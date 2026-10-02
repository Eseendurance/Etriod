// Verifies the migration runner itself: applying migrations/, recording
// them, and being idempotent on a second run — against a real in-memory
// Postgres, not just checking the script parses.
const { newDb } = require('pg-mem');
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

  const tableCheck = await pool.query(`SELECT COUNT(*) AS n FROM users`);
  check('the users table genuinely exists and is queryable after migrating', Number(tableCheck.rows[0].n) === 0);

  const tracked = await pool.query('SELECT version FROM schema_migrations');
  check('schema_migrations records all applied migrations', tracked.rows.length === 4);
  const billingColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'subscriptions' AND column_name IN ('payment_provider','provider_subscription_id','provider_customer_id')`
  );
  check('subscription table stores provider references', billingColumns.rows.length === 3);
  const orderTable = await pool.query('SELECT COUNT(*) AS n FROM payment_orders');
  check('payment orders table is available', Number(orderTable.rows[0].n) === 0);
  const rateLimitTable = await pool.query('SELECT COUNT(*) AS n FROM rate_limit_counters');
  check('shared rate-limit storage is available', Number(rateLimitTable.rows[0].n) === 0);

  const second = await runMigrations({ pool, statusOnly: false });
  check('second run is a no-op (already applied)', second.applied.length === 0);

  const status = await runMigrations({ pool, statusOnly: true });
  check('--status mode reports nothing pending, without changing anything', status.pending.length === 0);

  console.log(failures === 0 ? '\nALL MIGRATION CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('Migration test crashed:', err); process.exit(1); });
