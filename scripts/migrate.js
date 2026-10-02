// A minimal migration runner — no extra framework, just tracks which .sql
// files in migrations/ have already been applied, in a schema_migrations
// table, and runs anything new in filename order inside a transaction.
//
// Usage:
//   node scripts/migrate.js            (applies pending migrations)
//   node scripts/migrate.js --status   (lists what's applied vs pending, doesn't change anything)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main(opts = {}) {
  const statusOnly = opts.statusOnly ?? process.argv.includes('--status');

  let pool = opts.pool;
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      console.error('DATABASE_URL is not set — see .env.example.');
      process.exit(1);
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : false
    });
  }
  const ownsPool = !opts.pool; // only close a pool we created ourselves

  // Bootstrap the tracking table if it isn't there yet. Checking first
  // (rather than just running CREATE TABLE IF NOT EXISTS unconditionally on
  // every invocation) also means this only ever issues DDL once in the
  // table's lifetime, not on every single migrate run.
  try {
    await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
  } catch {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort(); // filenames are zero-padded (0001_, 0002_...) so lexical sort == correct order

  const appliedResult = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(appliedResult.rows.map(r => r.version));
  const pending = files.filter(f => !applied.has(f));

  const result = { applied: [], pending };

  if (statusOnly) {
    console.log(`Applied (${applied.size}):`);
    files.filter(f => applied.has(f)).forEach(f => console.log('  ✓ ' + f));
    console.log(`Pending (${pending.length}):`);
    pending.forEach(f => console.log('  · ' + f));
    if (ownsPool) await pool.end();
    return result;
  }

  if (pending.length === 0) {
    console.log('Nothing to do — database is already up to date.');
    if (ownsPool) await pool.end();
    return result;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✅ applied ${file}`);
      result.applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      if (ownsPool) await pool.end();
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
    client.release();
  }

  console.log(`Done — applied ${result.applied.length} migration(s).`);
  if (ownsPool) await pool.end();
  return result;
}

if (require.main === module) {
  main().catch(err => {
    console.error('Migration run failed:', err);
    process.exit(1);
  });
}

module.exports = { main };
