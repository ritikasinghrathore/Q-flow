const http = require('http'); const cfg = require('./config/environment'); const log = require('./config/logger'); const { pool } = require('./config/database');
const app = require('./app'); const server = http.createServer(app); require('./realtime/socket').init(server);
server.listen(cfg.port, '0.0.0.0', () => log.info({ port: cfg.port, env: cfg.nodeEnv }, 'Q-FLOW API listening'));
const stop = () => { log.info('shutting down'); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
