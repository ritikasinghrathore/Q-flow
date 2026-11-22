const router = require('express').Router(); const { z } = require('zod');
const { query } = require('../config/database'); const { authenticate } = require('../middleware/authenticate'); const { roleIn } = require('../middleware/authorize');
const validate = require('../middleware/validate'); const wrap = require('../utils/async'); const { params, uuid } = require('../utils/ids'); const { page } = require('../utils/pagination');
const { notFound, forbidden, badRequest } = require('../utils/errors'); const tokens = require('../services/token.service'); const queue = require('../services/queue.service');
router.use(authenticate);
const tid = validate(params('tokenId'), 'params');

router.post('/tokens', validate(z.object({ clinicId: uuid, doctorId: uuid, walkInName: z.string().trim().min(1).max(80).optional() })), wrap(async (req, res) => {
  const key = req.get('idempotency-key') || undefined;
  if (key && !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw badRequest('Idempotency-Key must be 8–100 letters, numbers, - or _');
  const walkIn = !!req.body.walkInName;
  if (walkIn) { const role = await roleIn({ query }, req.user.id, req.body.clinicId); if (!['receptionist', 'clinic_admin'].includes(role)) throw forbidden('Only reception can register walk-in patients'); }
  const r = await tokens.createToken({ user: req.user, isStaffWalkIn: walkIn, clinicId: req.body.clinicId, doctorId: req.body.doctorId, walkInName: req.body.walkInName, idempotencyKey: key });
  res.status(r.replayed ? 200 : 201).json({ data: { id: r.id, replayed: r.replayed } });
}));
router.get('/my/tokens', validate(page, 'query'), wrap(async (req, res) => {
  const r = await query(`SELECT t.id,t.token_label AS label,t.status,c.name AS "clinicName",t.created_at AS "createdAt" FROM tokens t JOIN patient_profiles pp ON pp.id=t.patient_profile_id JOIN clinics c ON c.id=t.clinic_id WHERE pp.user_id=$1 ORDER BY t.created_at DESC LIMIT $2 OFFSET $3`, [req.user.id, req.query.limit, req.query.offset]);
  res.json({ data: r.rows });
}));
const showToken = wrap(async (req, res) => {
  const o = (await query(`SELECT t.clinic_id, pp.user_id AS owner FROM tokens t LEFT JOIN patient_profiles pp ON pp.id=t.patient_profile_id WHERE t.id=$1`, [req.params.tokenId])).rows[0];
  const isOwner = o && o.owner === req.user.id, isStaff = o && !!(await roleIn({ query }, req.user.id, o.clinic_id));
  if (!o || (!isOwner && !isStaff)) throw notFound('Token not found');
  res.json({ data: await tokens.getView({ query }, req.params.tokenId, { withEvents: isOwner || isStaff }) });
});
router.get('/tokens/:tokenId', tid, showToken);
router.get('/tokens/:tokenId/journey', tid, showToken); // the view includes the journey stages and event history
router.get('/clinics/:clinicId/queue', validate(params('clinicId'), 'params'), validate(z.object({ doctorId: uuid.optional(), departmentId: uuid.optional(), status: z.enum(['waiting', 'serving', 'missed', 'post', 'done', 'cancelled']).optional() }).merge(page), 'query'), wrap(async (req, res) => {
  const role = await roleIn({ query }, req.user.id, req.params.clinicId); if (!role) throw forbidden();
  res.json({ data: await tokens.listQueue(req.params.clinicId, { ...req.query, onlyDoctorUserId: role === 'doctor' ? req.user.id : null }) }); // doctors only see their own queue
}));
const act = (path, action, bodySchema = z.object({}).strict()) => router.patch(`/tokens/:tokenId/${path}`, tid, validate(bodySchema), wrap(async (req, res) => { res.json({ data: await queue.perform(req.user, req.params.tokenId, action, req.body) }); }));
act('arrival', 'arrival', z.object({ arrived: z.boolean().default(true) }).strict());
act('start', 'start', z.object({ overrideArrival: z.boolean().default(false) }).strict());
act('complete', 'complete'); act('missed', 'missed'); act('recall', 'recall'); act('cancel', 'cancel');
act('advance', 'advance', z.object({ toStageId: uuid.optional() }).strict());
// Doctor operations
const did = validate(params('doctorId'), 'params');
router.patch('/doctors/:doctorId/availability', did, validate(z.object({ available: z.boolean() }).strict()), wrap(async (req, res) => { res.json({ data: await queue.doctorOp(req.user, req.params.doctorId, 'availability', req.body) }); }));
router.patch('/doctors/:doctorId/pause', did, validate(z.object({ paused: z.boolean() }).strict()), wrap(async (req, res) => { res.json({ data: await queue.doctorOp(req.user, req.params.doctorId, 'pause', req.body) }); }));
router.patch('/doctors/:doctorId/delay', did, validate(z.object({ minutes: z.number().int().min(0).max(240) }).strict()), wrap(async (req, res) => { res.json({ data: await queue.doctorOp(req.user, req.params.doctorId, 'delay', req.body) }); }));
module.exports = router;
