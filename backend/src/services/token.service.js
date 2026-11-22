const crypto = require('crypto');
const { withTx, query } = require('../config/database'); const { notFound, badRequest } = require('../utils/errors');
const { audit } = require('./audit.service'); const { notify } = require('./notification.service');
const journey = require('./journey.service'); const queue = require('./queue.service'); const pred = require('./prediction.service'); const ev = require('../realtime/events');

async function createToken({ user, isStaffWalkIn, clinicId, doctorId, walkInName, idempotencyKey }) {
  try {
    return await withTx(async (c, after) => {
      const clinic = (await c.query(`SELECT id,timezone,status FROM clinics WHERE id=$1`, [clinicId])).rows[0];
      if (!clinic || clinic.status !== 'active') throw notFound('Clinic not found');
      if (idempotencyKey) { // a repeated request returns the original token instead of creating a second one
        const ex = (await c.query('SELECT id FROM tokens WHERE clinic_id=$1 AND idempotency_key=$2 AND created_by=$3', [clinicId, idempotencyKey, user.id])).rows[0];
        if (ex) return { id: ex.id, replayed: true };
      }
      const doctor = (await c.query('SELECT * FROM doctors WHERE id=$1 AND clinic_id=$2', [doctorId, clinicId])).rows[0];
      if (!doctor) throw notFound('Doctor not found at this clinic');
      let profileId = null;
      if (!isStaffWalkIn) {
        const p = (await c.query('SELECT id FROM patient_profiles WHERE user_id=$1', [user.id])).rows[0];
        if (!p) throw badRequest('Your account has no patient profile'); profileId = p.id;
      }
      const day = (await c.query(`SELECT to_char((now() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS d`, [clinic.timezone])).rows[0].d;
      // Concurrency-safe numbering: the counter row is locked until commit, so two requests can never get the same number.
      const n = (await c.query(`INSERT INTO token_counters(clinic_id,token_day,last_number) VALUES($1,$2,1) ON CONFLICT (clinic_id,token_day) DO UPDATE SET last_number=token_counters.last_number+1 RETURNING last_number`, [clinicId, day])).rows[0].last_number;
      const seq = (await c.query(`SELECT nextval('queue_sequence_seq') AS s`)).rows[0].s;
      const t = (await c.query(`INSERT INTO tokens(clinic_id,department_id,doctor_id,patient_profile_id,walk_in_name,token_day,token_number,token_label,queue_sequence,arrival_status,arrived_at,tracking_id,created_by,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [clinicId, doctor.department_id, doctorId, profileId, isStaffWalkIn ? walkInName : null, day, n, 'A' + String(n).padStart(3, '0'), seq,
          isStaffWalkIn ? 'arrived' : 'not_arrived', isStaffWalkIn ? new Date() : null, crypto.randomBytes(16).toString('base64url'), user.id, idempotencyKey || null])).rows[0];
      await journey.createJourney(c, t, user.id);
      await c.query(`INSERT INTO queue_events(clinic_id,token_id,event_type,new_status,actor_user_id) VALUES($1,$2,'created','waiting',$3)`, [clinicId, t.id, user.id]);
      if (isStaffWalkIn) await audit(c, { clinicId, actorId: user.id, action: 'token.walk_in_created', resourceType: 'token', resourceId: t.id });
      else await notify(c, after, { userId: user.id, clinicId, tokenId: t.id, type: 'token_created', message: `Your token is ${t.token_label}. Open Q-FLOW to follow your journey.` });
      await queue.recalcDoctor(c, after, doctorId);
      after.push(() => { ev.emitClinic(clinicId, 'TOKEN_CREATED', { tokenId: t.id }); ev.emitClinic(clinicId, 'QUEUE_UPDATED', { tokenId: t.id, action: 'created' }); });
      return { id: t.id, replayed: false };
    });
  } catch (e) {
    if (e.code === '23505' && e.constraint === 'tokens_idem_uq') {
      const ex = (await query('SELECT id FROM tokens WHERE clinic_id=$1 AND idempotency_key=$2 AND created_by=$3', [clinicId, idempotencyKey, user.id])).rows[0];
      if (ex) return { id: ex.id, replayed: true };
    }
    throw e;
  }
}

// Patient/public-safe view: never contains names. `withEvents` adds the history for the owner only.
async function getView(db, id, { withEvents = false } = {}) {
  const t = (await db.query(`SELECT t.*, d.display_name AS doctor_name, d.paused, d.available, d.reported_delay_minutes, dep.name AS department_name, cl.name AS clinic_name, cl.slug, cl.settings
    FROM tokens t JOIN doctors d ON d.id=t.doctor_id JOIN departments dep ON dep.id=t.department_id JOIN clinics cl ON cl.id=t.clinic_id WHERE t.id=$1`, [id])).rows[0];
  if (!t) return null;
  const j = (await db.query(`SELECT j.id,j.status,j.template_id,j.current_stage_id, s.stage_order AS cur FROM journeys j LEFT JOIN journey_template_stages s ON s.id=j.current_stage_id WHERE j.token_id=$1`, [id])).rows[0];
  const stages = j ? (await db.query('SELECT id,stage_name,stage_order,optional FROM journey_template_stages WHERE template_id=$1 AND active ORDER BY stage_order', [j.template_id])).rows : [];
  const done = t.status === 'done' || (j && j.status === 'completed');
  const ahead = t.status === 'waiting' ? Number((await db.query(`SELECT count(*) FROM tokens WHERE doctor_id=$1 AND status='waiting' AND queue_sequence<$2`, [t.doctor_id, t.queue_sequence])).rows[0].count) : null;
  const serving = (await db.query(`SELECT token_label FROM tokens WHERE doctor_id=$1 AND status='serving'`, [t.doctor_id])).rows[0];
  const next = (await db.query(`SELECT token_label FROM tokens WHERE doctor_id=$1 AND status='waiting' ORDER BY queue_sequence LIMIT 1`, [t.doctor_id])).rows[0];
  const p = t.status === 'waiting' ? (await db.query('SELECT * FROM waiting_predictions WHERE token_id=$1 ORDER BY calculated_at DESC LIMIT 1', [id])).rows[0] : null;
  const upd = (await db.query('SELECT max(created_at) AS m FROM queue_events WHERE token_id=$1', [id])).rows[0].m;
  const view = {
    id: t.id, label: t.token_label, status: t.status, arrivalStatus: t.arrival_status, createdAt: t.created_at, lastUpdated: upd,
    clinic: { name: t.clinic_name, slug: t.slug }, department: t.department_name,
    doctor: { name: t.doctor_name, available: t.available, paused: t.paused, delayMinutes: t.reported_delay_minutes },
    ahead, nowServing: serving ? serving.token_label : null, next: next ? next.token_label : null,
    estimate: p ? { minMinutes: p.predicted_min_minutes, maxMinutes: p.predicted_max_minutes, confidence: p.confidence, factors: p.factors, calculatedAt: p.calculated_at, disclaimer: 'An estimate, not a guarantee. It can change.' } : null,
    arrivalWindow: p ? pred.arrivalWindow({ minMinutes: p.predicted_min_minutes, maxMinutes: p.predicted_max_minutes }, t.settings.arrival_window_minutes ?? 15) : null,
    journey: { status: j ? j.status : null, stages: stages.map((s) => ({ id: s.id, name: s.stage_name, optional: s.optional, state: done || (j && s.stage_order < j.cur) ? 'done' : j && s.id === j.current_stage_id && t.status !== 'cancelled' ? 'active' : 'upcoming' })) },
  };
  if (withEvents) view.trackingId = t.tracking_id; // private link secret: owner/staff only
  if (withEvents && j) view.events = (await db.query('SELECT event_type, created_at FROM journey_events WHERE journey_id=$1 ORDER BY created_at', [j.id])).rows;
  return view;
}
async function listQueue(clinicId, { doctorId, departmentId, status, limit, offset, onlyDoctorUserId }) {
  const where = ['t.clinic_id=$1'], vals = [clinicId];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', '$' + vals.length)); };
  if (doctorId) add('t.doctor_id=?', doctorId); if (departmentId) add('t.department_id=?', departmentId); if (status) add('t.status=?', status);
  if (onlyDoctorUserId) add('t.doctor_id IN (SELECT id FROM doctors WHERE user_id=?)', onlyDoctorUserId);
  vals.push(limit, offset);
  const r = await query(`SELECT t.id,t.token_label,t.status,t.arrival_status,t.doctor_id,t.department_id,t.missed_count,t.created_at,t.queue_sequence,
      COALESCE(t.walk_in_name, pp.display_name) AS patient_name, (t.patient_profile_id IS NULL) AS walk_in
    FROM tokens t LEFT JOIN patient_profiles pp ON pp.id=t.patient_profile_id WHERE ${where.join(' AND ')}
    ORDER BY (t.status IN ('done','cancelled')), t.queue_sequence LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
  return r.rows;
}
module.exports = { createToken, getView, listQueue };
