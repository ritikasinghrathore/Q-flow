const router = require('express').Router(); const { z } = require('zod');
const cfg = require('../config/environment'); const { query } = require('../config/database');
const validate = require('../middleware/validate'); const { auth: authLimit } = require('../middleware/rateLimit');
const { authenticate, COOKIE } = require('../middleware/authenticate'); const svc = require('../services/auth.service'); const wrap = require('../utils/async'); const ev = require('../realtime/events');
const email = z.string().email().max(254), password = z.string().min(10, 'Use at least 10 characters').max(128);
const setCookie = (res, token) => res.cookie(COOKIE, token, { httpOnly: true, secure: cfg.isProd, sameSite: cfg.sameSite, maxAge: cfg.sessionDays * 864e5, path: '/' });

router.post('/register', authLimit, validate(z.object({ email, password, fullName: z.string().trim().min(1).max(80) })), wrap(async (req, res) => {
  const u = await svc.register(req.body); const s = await svc.createSession(u.id); setCookie(res, s.token);
  res.status(201).json({ data: { user: { id: u.id, email: u.email, fullName: u.full_name }, csrfToken: s.csrf } });
}));
router.post('/login', authLimit, validate(z.object({ email, password: z.string().min(1).max(128) })), wrap(async (req, res) => {
  const r = await svc.login(req.body); setCookie(res, r.token); res.json({ data: { user: r.user, csrfToken: r.csrf } });
}));
router.post('/logout', authenticate, wrap(async (req, res) => {
  await svc.logout(req.session.id); res.clearCookie(COOKIE, { path: '/', sameSite: cfg.sameSite, secure: cfg.isProd }); ev.disconnectUser(req.user.id); res.json({ data: { ok: true } });
}));
router.get('/me', authenticate, wrap(async (req, res) => {
  const m = await query(`SELECT cm.clinic_id AS "clinicId", c.name AS "clinicName", cm.role, d.id AS "doctorId" FROM clinic_memberships cm JOIN clinics c ON c.id=cm.clinic_id
    LEFT JOIN doctors d ON d.clinic_id=cm.clinic_id AND d.user_id=cm.user_id WHERE cm.user_id=$1 AND cm.membership_status='active'`, [req.user.id]);
  res.json({ data: { user: req.user, csrfToken: req.session.csrf, memberships: m.rows } });
}));
router.post('/forgot-password', authLimit, validate(z.object({ email })), wrap(async (req, res) => { await svc.forgotPassword(req.body.email); res.json({ data: { message: 'If that email has an account, a reset link will be sent once email delivery is set up.' } }); }));
router.post('/reset-password', authLimit, validate(z.object({ token: z.string().min(20).max(100), password })), wrap(async (req, res) => { await svc.resetPassword(req.body.token, req.body.password); res.json({ data: { ok: true } }); }));
module.exports = router;
