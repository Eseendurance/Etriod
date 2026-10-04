const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set — the server will start but every query will fail. See .env.example.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '3', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : false
});

// CRITICAL: pg emits 'error' on the pool whenever an idle client's connection
// drops (network blip, DB restart, etc). Without a listener here, that
// unhandled event crashes the entire Node process — not just that request.
pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client — connection recovered automatically, process kept running:', err.message);
});

async function healthCheck() {
  await pool.query('SELECT 1');
}

async function shutdown() {
  await pool.end();
}

module.exports = { pool, healthCheck, shutdown };
