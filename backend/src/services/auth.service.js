const argon2 = require('argon2'); const crypto = require('crypto');
const cfg = require('../config/environment'); const log = require('../config/logger');
const { query, withTx } = require('../config/database'); const { hashToken } = require('../middleware/authenticate');
const { conflict, unauthorized, badRequest } = require('../utils/errors');
const OPTS = { type: argon2.argon2id };
let dummy; // used so unknown emails take as long to reject as wrong passwords
const hash = (p) => argon2.hash(p, OPTS);

async function register({ email, password, fullName }) {
  const e = email.trim().toLowerCase();
  if ((await query('SELECT 1 FROM users WHERE email=$1', [e])).rowCount) throw conflict('An account with this email already exists');
  const h = await hash(password);
  return withTx(async (c) => {
    const u = (await c.query('INSERT INTO users(email,password_hash,full_name) VALUES($1,$2,$3) RETURNING id,email,full_name', [e, h, fullName.trim()])).rows[0];
    await c.query('INSERT INTO patient_profiles(user_id,display_name) VALUES($1,$2)', [u.id, fullName.trim()]);
    return u;
  });
}
async function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url'), csrf = crypto.randomBytes(24).toString('base64url');
  await query(`INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3, now() + ($4 || ' days')::interval)`, [userId, hashToken(token), csrf, String(cfg.sessionDays)]);
  return { token, csrf };
}
async function login({ email, password }) {
  const u = (await query('SELECT id,email,full_name,password_hash,account_status FROM users WHERE email=$1', [email.trim().toLowerCase()])).rows[0];
  dummy = dummy || await hash('not-a-real-password');
  const ok = await argon2.verify(u ? u.password_hash : dummy, password).catch(() => false);
  if (!u || !ok || u.account_status !== 'active') throw unauthorized('Incorrect email or password'); // same message for every failure
  return { user: { id: u.id, email: u.email, fullName: u.full_name }, ...(await createSession(u.id)) };
}
const logout = (sessionId) => query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [sessionId]);

// Creates a one-time reset token. No email provider exists yet, so nothing is sent. In development the link is logged;
// in production nothing is logged and resets cannot be completed until an email provider is registered.
async function forgotPassword(email) {
  const u = (await query(`SELECT id FROM users WHERE email=$1 AND account_status='active'`, [email.trim().toLowerCase()])).rows[0]; if (!u) return;
  const token = crypto.randomBytes(32).toString('base64url');
  await query(`INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2, now() + interval '30 minutes')`, [u.id, hashToken(token)]);
  if (cfg.isProd) log.warn('password reset requested but no email provider is configured; nothing was sent');
  else log.info({ resetUrl: `${cfg.frontendUrl}/#reset=${token}` }, 'DEV ONLY: password reset link');
}
async function resetPassword(token, newPassword) {
  const h = await hash(newPassword);
  await withTx(async (c) => {
    const r = (await c.query(`UPDATE password_resets SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id`, [hashToken(token)])).rows[0];
    if (!r) throw badRequest('This reset link is invalid or has expired');
    await c.query('UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2', [h, r.user_id]);
    await c.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [r.user_id]); // sign out everywhere
  });
}
module.exports = { register, login, logout, createSession, forgotPassword, resetPassword, hash };
