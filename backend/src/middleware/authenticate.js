const crypto = require('crypto'); const cfg = require('../config/environment'); const { query } = require('../config/database'); const { unauthorized, forbidden } = require('../utils/errors');
const hashToken = (t) => crypto.createHmac('sha256', cfg.sessionSecret).update(t).digest('hex');
const COOKIE = 'qf_session';
async function authenticate(req, _res, next) {
  try {
    const token = req.cookies && req.cookies[COOKIE]; if (!token) throw unauthorized();
    const r = await query(`SELECT s.id AS session_id, s.csrf_token, u.id, u.email, u.full_name, u.account_status
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`, [hashToken(token)]);
    const row = r.rows[0]; if (!row || row.account_status !== 'active') throw unauthorized();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const sent = Buffer.from(String(req.get('x-csrf-token') || '')), want = Buffer.from(row.csrf_token);
      if (sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) throw forbidden('Missing or invalid CSRF token');
    }
    req.user = { id: row.id, email: row.email, fullName: row.full_name }; req.session = { id: row.session_id, csrf: row.csrf_token };
    next();
  } catch (e) { next(e); }
}
module.exports = { authenticate, hashToken, COOKIE };
