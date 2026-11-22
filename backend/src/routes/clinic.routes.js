const router = require('express').Router(); const { z } = require('zod');
const { query, withTx } = require('../config/database'); const { authenticate } = require('../middleware/authenticate'); const { requireRole, roleIn } = require('../middleware/authorize');
const validate = require('../middleware/validate'); const wrap = require('../utils/async'); const { params } = require('../utils/ids'); const { page } = require('../utils/pagination');
const { notFound, conflict, badRequest } = require('../utils/errors'); const { audit } = require('../services/audit.service'); const clinics = require('../services/clinic.service'); const auth = require('../services/auth.service');
router.use(authenticate);
const ADMIN = requireRole('clinic_admin'), ANY = requireRole('clinic_admin', 'receptionist', 'doctor');
const settings = z.object({ missed_policy: z.enum(['original', 'behind_3']), arrival_window_minutes: z.number().int().min(5).max(60), significant_change_minutes: z.number().int().min(5).max(60), turn_approaching_ahead: z.number().int().min(1).max(5) }).partial().strict();

router.get('/', validate(z.object({ q: z.string().trim().max(60).default('') }).merge(page), 'query'), wrap(async (req, res) => {
  const like = '%' + req.query.q.replace(/[\\%_]/g, '\\$&') + '%';
  const r = await query(`SELECT id,name,slug,address,is_demo AS "isDemo" FROM clinics WHERE status='active' AND name ILIKE $1 ORDER BY name LIMIT $2 OFFSET $3`, [like, Math.min(req.query.limit, 20), req.query.offset]);
  res.json({ data: r.rows });
}));
router.post('/', validate(z.object({ name: z.string().trim().min(3).max(80), address: z.string().trim().max(200).optional(), contactInfo: z.string().trim().max(120).optional(), timezone: z.string().max(60).default('Asia/Kolkata') })), wrap(async (req, res) => {
  const cl = await withTx((c) => clinics.createClinic(c, { ownerUserId: req.user.id, ...req.body })); // duplicate name/slug -> 409 from unique indexes
  res.status(201).json({ data: cl });
}));
router.get('/:clinicId', validate(params('clinicId'), 'params'), wrap(async (req, res) => {
  const c = (await query(`SELECT id,name,slug,address,contact_info AS "contactInfo",timezone,settings,is_demo AS "isDemo" FROM clinics WHERE id=$1 AND status='active'`, [req.params.clinicId])).rows[0];
  if (!c) throw notFound('Clinic not found');
  if (!(await roleIn({ query }, req.user.id, c.id))) delete c.settings; // clinic rules are visible to staff only
  res.json({ data: c });
}));
router.patch('/:clinicId', validate(params('clinicId'), 'params'), ADMIN, validate(z.object({ name: z.string().trim().min(3).max(80).optional(), address: z.string().trim().max(200).optional(), contactInfo: z.string().trim().max(120).optional(), settings: settings.optional() }).strict()), wrap(async (req, res) => {
  const b = req.body; await withTx(async (c) => {
    await c.query(`UPDATE clinics SET name=COALESCE($2,name), address=COALESCE($3,address), contact_info=COALESCE($4,contact_info), settings=settings || COALESCE($5::jsonb,'{}'::jsonb), updated_at=now() WHERE id=$1`, [req.params.clinicId, b.name, b.address, b.contactInfo, b.settings ? JSON.stringify(b.settings) : null]);
    await audit(c, { clinicId: req.params.clinicId, actorId: req.user.id, action: 'clinic.updated', resourceType: 'clinic', resourceId: req.params.clinicId, metadata: { fields: Object.keys(b) } });
  }); res.json({ data: { ok: true } });
}));
router.put('/:clinicId/workflow', validate(params('clinicId'), 'params'), ADMIN, validate(z.object({ stages: z.array(z.object({ name: z.string().trim().min(2).max(40), optional: z.boolean().default(false) })).max(6) })), wrap(async (req, res) => {
  await withTx(async (c) => { await clinics.setWorkflow(c, req.params.clinicId, req.body.stages); await audit(c, { clinicId: req.params.clinicId, actorId: req.user.id, action: 'workflow.updated', resourceType: 'clinic', resourceId: req.params.clinicId, metadata: { stages: req.body.stages.map((s) => s.name) } }); });
  res.json({ data: { ok: true } });
}));
// Doctors and departments (readable by any signed-in user so patients can choose; no staff details exposed)
router.get('/:clinicId/doctors', validate(params('clinicId'), 'params'), wrap(async (req, res) => {
  res.json({ data: (await query(`SELECT d.id,d.display_name AS "displayName",d.department_id AS "departmentId",dep.name AS department,d.available,d.paused FROM doctors d JOIN departments dep ON dep.id=d.department_id WHERE d.clinic_id=$1 AND dep.active ORDER BY d.display_name`, [req.params.clinicId])).rows });
}));
router.post('/:clinicId/doctors', validate(params('clinicId'), 'params'), ADMIN, validate(z.object({ displayName: z.string().trim().min(2).max(80), departmentId: z.string().uuid() })), wrap(async (req, res) => {
  const dep = await query('SELECT 1 FROM departments WHERE id=$1 AND clinic_id=$2', [req.body.departmentId, req.params.clinicId]); if (!dep.rowCount) throw badRequest('Department not found in this clinic');
  const d = (await query('INSERT INTO doctors(clinic_id,department_id,display_name) VALUES($1,$2,$3) RETURNING id', [req.params.clinicId, req.body.departmentId, req.body.displayName])).rows[0];
  await audit({ query }, { clinicId: req.params.clinicId, actorId: req.user.id, action: 'doctor.created', resourceType: 'doctor', resourceId: d.id }); res.status(201).json({ data: d });
}));
router.get('/:clinicId/departments', validate(params('clinicId'), 'params'), wrap(async (req, res) => { res.json({ data: (await query('SELECT id,name,description,active FROM departments WHERE clinic_id=$1 AND active ORDER BY name', [req.params.clinicId])).rows }); }));
router.post('/:clinicId/departments', validate(params('clinicId'), 'params'), ADMIN, validate(z.object({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(200).optional() })), wrap(async (req, res) => {
  const d = (await query('INSERT INTO departments(clinic_id,name,description) VALUES($1,$2,$3) RETURNING id,name', [req.params.clinicId, req.body.name, req.body.description || null])).rows[0];
  await audit({ query }, { clinicId: req.params.clinicId, actorId: req.user.id, action: 'department.created', resourceType: 'department', resourceId: d.id }); res.status(201).json({ data: d });
}));
// Staff (admin only). Existing users are linked; new users get the temporary password the admin sets.
router.get('/:clinicId/staff', validate(params('clinicId'), 'params'), ADMIN, wrap(async (req, res) => {
  res.json({ data: (await query(`SELECT cm.id,cm.role,cm.membership_status AS status,u.email,u.full_name AS "fullName" FROM clinic_memberships cm JOIN users u ON u.id=cm.user_id WHERE cm.clinic_id=$1 ORDER BY cm.created_at`, [req.params.clinicId])).rows });
}));
router.post('/:clinicId/staff', validate(params('clinicId'), 'params'), ADMIN, validate(z.object({ email: z.string().email().max(254), fullName: z.string().trim().min(1).max(80), role: z.enum(['receptionist', 'doctor', 'clinic_admin']), temporaryPassword: z.string().min(10).max(128).optional(), departmentId: z.string().uuid().optional() })), wrap(async (req, res) => {
  const b = req.body, email = b.email.toLowerCase(), cid = req.params.clinicId;
  if (b.role === 'doctor' && !b.departmentId) throw badRequest('Choose a department for the doctor');
  const out = await withTx(async (c) => {
    let u = (await c.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
    if (!u) { if (!b.temporaryPassword) throw badRequest('Set a temporary password for the new account'); u = (await c.query('INSERT INTO users(email,password_hash,full_name) VALUES($1,$2,$3) RETURNING id', [email, await auth.hash(b.temporaryPassword), b.fullName])).rows[0]; }
    const m = (await c.query(`INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT (clinic_id,user_id,role) DO UPDATE SET membership_status='active' RETURNING id`, [cid, u.id, b.role])).rows[0];
    if (b.role === 'doctor') {
      if (!(await c.query('SELECT 1 FROM departments WHERE id=$1 AND clinic_id=$2', [b.departmentId, cid])).rowCount) throw badRequest('Department not found in this clinic');
      await c.query(`INSERT INTO doctors(clinic_id,user_id,department_id,display_name) VALUES($1,$2,$3,$4) ON CONFLICT (clinic_id,user_id) WHERE user_id IS NOT NULL DO NOTHING`, [cid, u.id, b.departmentId, b.fullName]);
    }
    await audit(c, { clinicId: cid, actorId: req.user.id, action: 'staff.added', resourceType: 'membership', resourceId: m.id, metadata: { role: b.role } });
    return m;
  }); res.status(201).json({ data: out });
}));
router.delete('/:clinicId/staff/:membershipId', validate(params('clinicId', 'membershipId'), 'params'), ADMIN, wrap(async (req, res) => {
  await withTx(async (c) => {
    const m = (await c.query('SELECT id,role FROM clinic_memberships WHERE id=$1 AND clinic_id=$2 FOR UPDATE', [req.params.membershipId, req.params.clinicId])).rows[0]; if (!m) throw notFound('Staff member not found');
    if (m.role === 'clinic_admin' && (await c.query(`SELECT 1 FROM clinic_memberships WHERE clinic_id=$1 AND role='clinic_admin' AND membership_status='active' AND id<>$2`, [req.params.clinicId, m.id])).rowCount === 0) throw conflict('A clinic must keep at least one administrator');
    await c.query(`UPDATE clinic_memberships SET membership_status='disabled' WHERE id=$1`, [m.id]); // disabled, never deleted, so history keeps its actor
    await audit(c, { clinicId: req.params.clinicId, actorId: req.user.id, action: 'staff.disabled', resourceType: 'membership', resourceId: m.id });
  }); res.json({ data: { ok: true } });
}));
router.get('/:clinicId/audit-logs', validate(params('clinicId'), 'params'), ADMIN, validate(page, 'query'), wrap(async (req, res) => {
  res.json({ data: (await query(`SELECT a.id,a.action,a.resource_type AS "resourceType",a.resource_id AS "resourceId",a.metadata,a.created_at AS "createdAt",u.full_name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.clinic_id=$1 ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`, [req.params.clinicId, req.query.limit, req.query.offset])).rows });
}));
module.exports = router;
