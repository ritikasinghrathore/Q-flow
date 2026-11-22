// Applies migrations/*.sql in order, once each, each inside a transaction.
const fs = require('fs'); const path = require('path');
const { pool } = require('./config/database'); const log = require('./config/logger');
(async () => {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir = path.join(__dirname, '..', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if ((await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f])).rowCount) continue;
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(fs.readFileSync(path.join(dir, f), 'utf8')); await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]); await c.query('COMMIT'); log.info({ migration: f }, 'applied'); }
    catch (e) { await c.query('ROLLBACK'); log.error({ migration: f, err: e.message }, 'migration failed'); process.exitCode = 1; break; }
    finally { c.release(); }
  }
  await pool.end();
})();
