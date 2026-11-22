const rateLimit = require('express-rate-limit');
const mk = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'rate_limited', message: 'Too many requests. Please wait and try again.' } } });
module.exports = { general: mk(15 * 60e3, 600), auth: mk(15 * 60e3, 20) };
