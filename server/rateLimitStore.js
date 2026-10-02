const { pool } = require('./db');

class PostgresRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.windowMs = 60000;
    this.cleanupTimer = null;
  }

  init(options) {
    this.windowMs = options.windowMs;
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        pool.query('DELETE FROM rate_limit_counters WHERE reset_at < now() - interval \'1 day\'')
          .catch(err => console.error('[rate-limit:cleanup]', err));
      }, 60 * 60 * 1000);
      this.cleanupTimer.unref();
    }
  }

  async increment(key) {
    const result = await pool.query(
      `INSERT INTO rate_limit_counters (key, hits, reset_at)
       VALUES ($1, 1, now() + $2::interval)
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limit_counters.reset_at <= now() THEN 1 ELSE rate_limit_counters.hits + 1 END,
         reset_at = CASE
           WHEN rate_limit_counters.reset_at <= now() THEN now() + $2::interval
           ELSE rate_limit_counters.reset_at
         END
       RETURNING hits, reset_at`,
      [`${this.prefix}:${key}`, `${this.windowMs} milliseconds`]
    );
    return { totalHits: Number(result.rows[0].hits), resetTime: new Date(result.rows[0].reset_at) };
  }

  async decrement(key) {
    await pool.query(
      'UPDATE rate_limit_counters SET hits = GREATEST(hits - 1, 0) WHERE key = $1',
      [`${this.prefix}:${key}`]
    );
  }

  async resetKey(key) {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = $1', [`${this.prefix}:${key}`]);
  }

  shutdown() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }
}

module.exports = { PostgresRateLimitStore };
