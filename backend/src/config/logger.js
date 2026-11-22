const pino = require('pino');
module.exports = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', '*.password', '*.password_hash', '*.token'], censor: '[redacted]' },
});
