const env = process.env;
const cfg = {
  nodeEnv: env.NODE_ENV || 'development', port: Number(env.PORT) || 3000,
  databaseUrl: env.DATABASE_URL, frontendUrl: env.FRONTEND_URL || 'http://localhost:5173',
  sessionSecret: env.SESSION_SECRET, sessionDays: Number(env.SESSION_DAYS) || 14,
  sameSite: env.COOKIE_SAMESITE || 'lax', logLevel: env.LOG_LEVEL || 'info',
};
cfg.isProd = cfg.nodeEnv === 'production';
const missing = [];
if (!cfg.databaseUrl) missing.push('DATABASE_URL');
if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) missing.push('SESSION_SECRET (32+ chars)');
if (cfg.isProd && !env.FRONTEND_URL) missing.push('FRONTEND_URL');
if (missing.length) throw new Error('Missing or invalid environment variables: ' + missing.join(', '));
if (!['lax', 'strict', 'none'].includes(cfg.sameSite)) throw new Error('COOKIE_SAMESITE must be lax, strict or none');
module.exports = cfg;
