// Family Journey Mode: a patient can let another registered user follow their active visits.
// Consent is explicit (the patient grants it) and either side can end it at any time.
const router = require('express').Router(); const { z } = require('zod');
const { query } = require('../config/database'); const { authenticate } = require('../middleware/authenticate');
const validate = require('../middleware/validate'); const wrap = require('../utils/async'); const { params } = require('../utils/ids');
const { notFound, badRequest, forbidden } = require('../utils/errors'); const tokens = require('../services/token.service');
const { notify } = require('../services/notification.service'); const { audit } = require('../services/audit.service');
router.use(authenticate);

// People I have allowed to follow my visits
router.get('/caregivers', wrap(async (req, res) => {
  const r = await query(`SELECT cp.id, u.email, u.full_name AS "fullName", cp.granted_at AS "grantedAt" FROM caregiver_permissions cp
    JOIN users u ON u.id=cp.caregiver_user_id WHERE cp.patient_user_id=$1 AND cp.status='active' ORDER BY cp.granted_at DESC`, [req.user.id]);
  res.json({ data: r.rows });
}));
// People who have allowed me to follow their visits
router.get('/patients', wrap(async (req, res) => {
  const r = await query(`SELECT cp.id, cp.patient_user_id AS "patientUserId", u.full_name AS "fullName", cp.granted_at AS "grantedAt" FROM caregiver_permissions cp
    JOIN users u ON u.id=cp.patient_user_id WHERE cp.caregiver_user_id=$1 AND cp.status='active' ORDER BY cp.granted_at DESC`, [req.user.id]);
  res.json({ data: r.rows });
}));
// Grant access by email. The other person must already have a Q-FLOW account.
router.post('/invite', validate(z.object({ email: z.string().email().max(254) })), wrap(async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
  const u = (await query(`SELECT id, full_name FROM users WHERE email=$1 AND account_status='active'`, [email])).rows[0];
  if (!u) throw notFound('No Q-FLOW account uses that email. Ask them to create one first.');
  if (u.id === req.user.id) throw badRequest('You cannot add yourself');
  const r = await query(`INSERT INTO caregiver_permissions(patient_user_id, caregiver_user_id) VALUES($1,$2) RETURNING id`, [req.user.id, u.id]); // duplicate -> 409 via unique index
  await audit({ query }, { actorId: req.user.id, action: 'family_access_granted', resourceType: 'caregiver_permission', resourceId: r.rows[0].id });
  const after = []; await notify({ query }, after, { userId: u.id, type: 'family_access', message: `${req.user.fullName} shared their clinic visits with you. Open the Family tab to follow them.` }); for (const f of after) await f();
  res.status(201).json({ data: { id: r.rows[0].id } });
}));
// End sharing (either the patient or the caregiver can do this)
router.delete('/:id', validate(params('id'), 'params'), wrap(async (req, res) => {
  const r = await query(`UPDATE caregiver_permissions SET status='revoked', revoked_at=now() WHERE id=$1 AND status='active' AND (patient_user_id=$2 OR caregiver_user_id=$2) RETURNING id`, [req.params.id, req.user.id]);
  if (!r.rowCount) throw notFound('Sharing not found');
  await audit({ query }, { actorId: req.user.id, action: 'family_access_revoked', resourceType: 'caregiver_permission', resourceId: req.params.id });
  res.json({ data: { ok: true } });
}));
// Active visits of a person who shared with me. No tracking links and no event history are included.
router.get('/patients/:patientUserId/journeys', validate(params('patientUserId'), 'params'), wrap(async (req, res) => {
  const ok = await query(`SELECT 1 FROM caregiver_permissions WHERE patient_user_id=$1 AND caregiver_user_id=$2 AND status='active'`, [req.params.patientUserId, req.user.id]);
  if (!ok.rowCount) throw forbidden('This person has not shared their visits with you');
  const t = await query(`SELECT t.id FROM tokens t JOIN patient_profiles pp ON pp.id=t.patient_profile_id WHERE pp.user_id=$1 AND t.status NOT IN ('done','cancelled') ORDER BY t.created_at DESC LIMIT 10`, [req.params.patientUserId]);
  const views = []; for (const row of t.rows) views.push(await tokens.getView({ query }, row.id, { withEvents: false }));
  res.json({ data: views });
}));
module.exports = router;
