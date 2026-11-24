// Account section: the signed-in person's account, profile, visit history ("journey on the app") and family sharing.
const router = require('express').Router(); const { z } = require('zod');
const { query } = require('../config/database'); const { authenticate } = require('../middleware/authenticate');
const validate = require('../middleware/validate'); const wrap = require('../utils/async');
router.use(authenticate);

router.get('/', wrap(async (req, res) => {
  const uid = req.user.id;
  const u = (await query(`SELECT u.id, u.email, u.full_name AS "fullName", u.phone_number AS phone, u.account_status AS status, u.email_verified_at AS "emailVerifiedAt",
      u.created_at AS "memberSince", pp.id AS "profileId", pp.display_name AS "displayName" FROM users u LEFT JOIN patient_profiles pp ON pp.user_id=u.id WHERE u.id=$1`, [uid])).rows[0];
  const staff = (await query(`SELECT cm.role, c.name AS "clinicName" FROM clinic_memberships cm JOIN clinics c ON c.id=cm.clinic_id WHERE cm.user_id=$1 AND cm.membership_status='active' ORDER BY c.name`, [uid])).rows;
  let journeys = [], stats = { visits: 0, completed: 0, cancelled: 0, avgVisitMinutes: null };
  if (u.profileId) {
    journeys = (await query(`SELECT t.token_label AS "tokenLabel", t.token_day AS day, t.status, c.name AS "clinicName", d.display_name AS "doctorName", dep.name AS department,
        t.created_at AS "startedAt", t.completed_at AS "completedAt", t.missed_count AS "missedCount",
        CASE WHEN t.completed_at IS NOT NULL THEN round(extract(epoch FROM t.completed_at - t.created_at)/60.0) END AS "totalMinutes"
      FROM tokens t JOIN clinics c ON c.id=t.clinic_id JOIN doctors d ON d.id=t.doctor_id JOIN departments dep ON dep.id=t.department_id
      WHERE t.patient_profile_id=$1 ORDER BY t.created_at DESC LIMIT 30`, [u.profileId])).rows;
    const s = (await query(`SELECT count(*)::int AS visits, count(*) FILTER (WHERE status='done')::int AS completed, count(*) FILTER (WHERE status='cancelled')::int AS cancelled,
        avg(extract(epoch FROM completed_at - created_at)/60.0) FILTER (WHERE completed_at IS NOT NULL) AS avg FROM tokens WHERE patient_profile_id=$1`, [u.profileId])).rows[0];
    stats = { visits: s.visits, completed: s.completed, cancelled: s.cancelled, avgVisitMinutes: s.avg == null ? null : Math.round(Number(s.avg)) };
  }
  const sharedWith = (await query(`SELECT u2.full_name AS "fullName", u2.email FROM caregiver_permissions cp JOIN users u2 ON u2.id=cp.caregiver_user_id WHERE cp.patient_user_id=$1 AND cp.status='active'`, [uid])).rows;
  const following = (await query(`SELECT u2.full_name AS "fullName" FROM caregiver_permissions cp JOIN users u2 ON u2.id=cp.patient_user_id WHERE cp.caregiver_user_id=$1 AND cp.status='active'`, [uid])).rows;
  res.json({ data: { account: { id: u.id, email: u.email, fullName: u.fullName, phone: u.phone, status: u.status, emailVerified: !!u.emailVerifiedAt, memberSince: u.memberSince },
    profile: u.profileId ? { displayName: u.displayName } : null, staffRoles: staff, stats, journeys, family: { sharedWith, following } } });
}));

// Edit name, phone and the name staff see on tokens
router.patch('/', validate(z.object({ fullName: z.string().trim().min(1).max(80).optional(), displayName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(20).regex(/^[0-9+() -]*$/, 'Phone can only have digits, spaces, + ( ) -').optional() })), wrap(async (req, res) => {
  const { fullName, displayName, phone } = req.body;
  if (fullName !== undefined) await query('UPDATE users SET full_name=$1, updated_at=now() WHERE id=$2', [fullName, req.user.id]);
  if (phone !== undefined) await query('UPDATE users SET phone_number=$1, updated_at=now() WHERE id=$2', [phone || null, req.user.id]);
  if (displayName !== undefined) await query('UPDATE patient_profiles SET display_name=$1, updated_at=now() WHERE user_id=$2', [displayName, req.user.id]);
  res.json({ data: { ok: true } });
}));
module.exports = router;
