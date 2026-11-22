const { Pool } = require('pg');
const cfg = require('./environment');
const log = require('./logger');
const pool = new Pool({
  connectionString: cfg.databaseUrl, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
  ssl: /sslmode=require/.test(cfg.databaseUrl) || cfg.isProd ? { rejectUnauthorized: true } : false,
});
pool.on('error', (e) => log.error({ err: e.message }, 'postgres pool error'));
const query = (text, params) => pool.query(text, params);
// Runs fn in one transaction. Functions pushed to `after` run only after COMMIT (used for realtime events).
async function withTx(fn) {
  const client = await pool.connect();
  const after = [];
  try {
    await client.query('BEGIN');
    const result = await fn(client, after);
    await client.query('COMMIT');
    for (const f of after) { try { await f(); } catch (e) { log.error({ err: e.message }, 'after-commit hook failed'); } }
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally { client.release(); }
}
module.exports = { pool, query, withTx };
