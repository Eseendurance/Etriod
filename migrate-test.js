// Verifies the migration runner itself: applying migrations/, recording
// them, and being idempotent on a second run — against a real in-memory
// Postgres, not just checking the script parses.
const { newDb } = require('pg-mem');
const fs = require('fs');
const path = require('path');
const { main: runMigrations } = require('./scripts/migrate');

async function main() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid', implementation: () => require('crypto').randomUUID() });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();

  let failures = 0;
  const check = (label, cond) => { console.log((cond ? '✅' : '❌') + ' ' + label); if (!cond) failures++; };

  const first = await runMigrations({ pool, statusOnly: false });
  check('first run applies the initial schema migration', first.applied.includes('0001_init.sql'));
  check('billing migration adds provider-specific subscription identity', first.applied.includes('0002_payment_providers.sql'));
  check('payment-intent migration adds verified checkout records', first.applied.includes('0003_payment_orders.sql'));
  check('distributed rate-limit migration adds shared counters', first.applied.includes('0004_rate_limit_counters.sql'));
  check('company roles and paid analytics migration is applied', first.applied.includes('0005_company_billing_analytics.sql'));

  const tableCheck = await pool.query(`SELECT COUNT(*) AS n FROM users`);
  check('the users table genuinely exists and is queryable after migrating', Number(tableCheck.rows[0].n) === 0);

  const tracked = await pool.query('SELECT version FROM schema_migrations');
  check('schema_migrations records all applied migrations', tracked.rows.length === 5);
  const billingColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'subscriptions' AND column_name IN ('payment_provider','provider_subscription_id','provider_customer_id')`
  );
  check('subscription table stores provider references', billingColumns.rows.length === 3);
  const orderTable = await pool.query('SELECT COUNT(*) AS n FROM payment_orders');
  check('payment orders table is available', Number(orderTable.rows[0].n) === 0);
  const rateLimitTable = await pool.query('SELECT COUNT(*) AS n FROM rate_limit_counters');
  check('shared rate-limit storage is available', Number(rateLimitTable.rows[0].n) === 0);
  const companyRoles = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'organization_members' AND column_name IN ('organization_id', 'user_id', 'role')`
  );
  check('company role membership table is available', companyRoles.rows.length === 3);
  const paidColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'payment_orders' AND column_name IN ('paid_amount', 'paid_at')`
  );
  check('payment orders have captured amount and timestamp fields', paidColumns.rows.length === 2);

  const second = await runMigrations({ pool, statusOnly: false });
  check('second run is a no-op (already applied)', second.applied.length === 0);

  const status = await runMigrations({ pool, statusOnly: true });
  check('--status mode reports nothing pending, without changing anything', status.pending.length === 0);

  const legacyDb = newDb({ autoCreateForeignKeyIndices: true });
  legacyDb.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid', implementation: () => require('crypto').randomUUID() });
  const { Pool: LegacyPool } = legacyDb.adapters.createPg();
  const legacyPool = new LegacyPool();
  await legacyPool.query(fs.readFileSync(path.join(__dirname, 'migrations', '0001_init.sql'), 'utf8'));
  await legacyPool.query(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await legacyPool.query(`INSERT INTO schema_migrations (version) VALUES ('0001_init.sql')`);
  const orgId = require('crypto').randomUUID();
  const olderUserId = require('crypto').randomUUID();
  const newerUserId = require('crypto').randomUUID();
  await legacyPool.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Legacy workspace']);
  await legacyPool.query(
    `INSERT INTO users (id, name, email, password_hash, org_id, created_at)
     VALUES ($1, 'Original owner', 'first@example.com', 'hash', $3, '2024-01-01T00:00:00Z'),
            ($2, 'Later member', 'later@example.com', 'hash', $3, '2024-02-01T00:00:00Z')`,
    [olderUserId, newerUserId, orgId]
  );
  const legacyMigrations = await runMigrations({ pool: legacyPool, statusOnly: false });
  const legacyRoles = await legacyPool.query(
    `SELECT u.email, m.role FROM organization_members m
     JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1`,
    [orgId]
  );
  check('legacy workspace migrations apply the new company-role schema', legacyMigrations.applied.includes('0005_company_billing_analytics.sql'));
  check('legacy workspace backfill grants ownership only to its oldest account', legacyRoles.rows.length === 2 &&
    legacyRoles.rows.some(row => row.email === 'first@example.com' && row.role === 'owner') &&
    legacyRoles.rows.some(row => row.email === 'later@example.com' && row.role === 'member'));
  await legacyPool.end();

  console.log(failures === 0 ? '\nALL MIGRATION CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('Migration test crashed:', err); process.exit(1); });
