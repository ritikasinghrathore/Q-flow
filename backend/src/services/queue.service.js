const { withTx } = require('../config/database');
const { roleIn } = require('../middleware/authorize');
const { notFound, forbidden, conflict, badRequest } = require('../utils/errors');
const { audit } = require('./audit.service'); const { notify } = require('./notification.service');
const pred = require('./prediction.service'); const journey = require('./journey.service'); const ev = require('../realtime/events');

// Explicit transition rules. Anything else is rejected.
const TRANSITIONS = { waiting: ['serving', 'missed', 'cancelled'], missed: ['waiting', 'cancelled'], serving: ['post', 'done'], post: ['post', 'done'] };
const STAFF = ['clinic_admin', 'receptionist'];

async function loadToken(c, id) {
  const r = await c.query(`SELECT t.*, pp.user_id AS patient_user_id FROM tokens t LEFT JOIN patient_profiles pp ON pp.id=t.patient_profile_id WHERE t.id=$1 FOR UPDATE OF t`, [id]);
  if (!r.rowCount) throw notFound('Token not found'); return r.rows[0];
}
async function setStatus(c, t, to, userId, eventType, extraSql = '') {
  if (!(TRANSITIONS[t.status] || []).includes(to)) throw conflict(`A token that is ${t.status} cannot become ${to}`);
  await c.query(`UPDATE tokens SET status=$1${extraSql} WHERE id=$2`, [to, t.id]);
  await c.query('INSERT INTO queue_events(clinic_id,token_id,event_type,previous_status,new_status,actor_user_id) VALUES($1,$2,$3,$4,$5,$6)', [t.clinic_id, t.id, eventType, t.status, to, userId]);
}

// Recalculates every waiting token of one doctor, stores snapshots, and sends de-duplicated notifications.
async function recalcDoctor(c, after, doctorId) {
  const d = (await c.query('SELECT d.*, cl.settings FROM doctors d JOIN clinics cl ON cl.id=d.clinic_id WHERE d.id=$1', [doctorId])).rows[0]; if (!d) return;
  const { durations, source } = await pred.durationsFor(c, d);
  const act = (await c.query(`SELECT consultation_started_at FROM tokens WHERE doctor_id=$1 AND status='serving'`, [doctorId])).rows[0];
  const q = (await c.query(`SELECT t.id,t.token_label,t.arrival_status,t.near_notified,t.last_notified_max,t.last_notified_at,t.clinic_id,pp.user_id
    FROM tokens t LEFT JOIN patient_profiles pp ON pp.id=t.patient_profile_id WHERE t.doctor_id=$1 AND t.status='waiting' ORDER BY t.queue_sequence, t.created_at`, [doctorId])).rows;
  const s = d.settings || {}, sig = s.significant_change_minutes ?? 10, nearAhead = s.turn_approaching_ahead ?? 2, buf = s.arrival_window_minutes ?? 15;
  let notArrived = 0;
  for (let i = 0; i < q.length; i++) {
    const t = q[i];
    const p = pred.predict({ durations, source, ahead: i, hasActive: !!act, activeElapsedSec: act ? (Date.now() - new Date(act.consultation_started_at)) / 1000 : 0, delayMin: d.reported_delay_minutes, paused: d.paused, available: d.available, notArrivedAhead: notArrived });
    const last = (await c.query('SELECT predicted_max_minutes, calculated_at FROM waiting_predictions WHERE token_id=$1 ORDER BY calculated_at DESC LIMIT 1', [t.id])).rows[0];
    if (!last || Math.abs(last.predicted_max_minutes - p.maxMinutes) >= 3 || Date.now() - new Date(last.calculated_at) > 10 * 60e3) {
      await c.query('INSERT INTO waiting_predictions(clinic_id,token_id,predicted_min_minutes,predicted_max_minutes,confidence,model_version,factors) VALUES($1,$2,$3,$4,$5,$6,$7)', [t.clinic_id, t.id, p.minMinutes, p.maxMinutes, p.confidence, p.modelVersion, { ...p.factors, positionInQueue: i }]);
      after.push(() => ev.emitClinic(t.clinic_id, 'WAITING_ESTIMATE_UPDATED', { tokenId: t.id }));
      if (t.user_id) after.push(() => ev.emitUser(t.user_id, 'WAITING_ESTIMATE_UPDATED', { tokenId: t.id }));
    }
    if (t.user_id) {
      const w = pred.arrivalWindow(p, buf);
      if (i <= nearAhead && !t.near_notified) {
        await notify(c, after, { userId: t.user_id, clinicId: t.clinic_id, tokenId: t.id, type: 'arrival_approaching', message: `Token ${t.token_label}: your turn is approaching. ${w.arriveNow ? 'Please be at the clinic now.' : `Suggested arrival in ${w.fromMinutes}–${w.toMinutes} min (an estimate).`}` });
        await c.query('UPDATE tokens SET near_notified=true, last_notified_max=$2, last_notified_at=now() WHERE id=$1', [t.id, p.maxMinutes]);
      } else if (t.last_notified_max == null) {
        await c.query('UPDATE tokens SET last_notified_max=$2 WHERE id=$1', [t.id, p.maxMinutes]); // baseline, no alert
      } else if (Math.abs(p.maxMinutes - t.last_notified_max) >= sig && (!t.last_notified_at || Date.now() - new Date(t.last_notified_at) > 5 * 60e3)) {
        await notify(c, after, { userId: t.user_id, clinicId: t.clinic_id, tokenId: t.id, type: 'estimate_changed', message: `Token ${t.token_label}: your estimated wait is now ${p.minMinutes}–${p.maxMinutes} min. This is an estimate, not a guarantee.` });
        await c.query('UPDATE tokens SET last_notified_max=$2, last_notified_at=now() WHERE id=$1', [t.id, p.maxMinutes]);
      }
    }
    if (t.arrival_status !== 'arrived') notArrived++;
  }
}

const PERMS = { // who may do what, checked against the database role
  arrival: (x) => x.isStaff || x.isOwner, start: (x) => x.role === 'clinic_admin' || x.isOwnDoctor, complete: (x) => x.role === 'clinic_admin' || x.isOwnDoctor,
  advance: (x) => x.isStaff || x.isOwnDoctor, missed: (x) => x.isStaff || x.isOwnDoctor, recall: (x) => x.isStaff, cancel: (x) => x.isStaff || x.isOwner,
};
const EVENT = { start: 'CONSULTATION_STARTED', complete: 'CONSULTATION_COMPLETED', recall: 'TOKEN_RECALLED', arrival: 'TOKEN_ARRIVED', advance: 'JOURNEY_STAGE_CHANGED' };

async function perform(user, tokenId, action, body = {}) {
  return withTx(async (c, after) => {
    const t = await loadToken(c, tokenId);
    const role = await roleIn(c, user.id, t.clinic_id);
    const isOwner = t.patient_user_id === user.id;
    if (!role && !isOwner) throw notFound('Token not found'); // never reveal that it exists
    const own = role === 'doctor' ? (await c.query('SELECT 1 FROM doctors WHERE id=$1 AND user_id=$2', [t.doctor_id, user.id])).rowCount > 0 : false;
    const x = { role, isOwner, isStaff: STAFF.includes(role), isOwnDoctor: own };
    if (!PERMS[action](x)) throw forbidden();
    const note = (type, message) => t.patient_user_id && notify(c, after, { userId: t.patient_user_id, clinicId: t.clinic_id, tokenId: t.id, type, message });
    let result = {};

    if (action === 'arrival') {
      const arrived = body.arrived !== false;
      if (!arrived && !x.isStaff) throw forbidden('Only staff can correct arrival information');
      if (!['waiting', 'missed'].includes(t.status) && arrived) throw conflict('Arrival can only be confirmed for waiting or missed tokens');
      if (!arrived && t.status !== 'waiting') throw conflict('Arrival can only be corrected for waiting tokens');
      await c.query(`UPDATE tokens SET arrival_status=$1, arrived_at=CASE WHEN $1='arrived' THEN now() ELSE NULL END WHERE id=$2`, [arrived ? 'arrived' : 'not_arrived', t.id]);
      await c.query('INSERT INTO queue_events(clinic_id,token_id,event_type,previous_status,new_status,actor_user_id) VALUES($1,$2,$3,$4,$4,$5)', [t.clinic_id, t.id, arrived ? 'arrival_confirmed' : 'arrival_corrected', t.status, user.id]);
      if (x.isStaff) await audit(c, { clinicId: t.clinic_id, actorId: user.id, action: arrived ? 'token.arrival_confirmed' : 'token.arrival_corrected', resourceType: 'token', resourceId: t.id });
    }
    if (action === 'start') {
      const d = (await c.query('SELECT * FROM doctors WHERE id=$1 FOR UPDATE', [t.doctor_id])).rows[0];
      if (!d.available || d.paused) throw conflict('The doctor is unavailable or service is paused');
      if ((await c.query(`SELECT 1 FROM tokens WHERE doctor_id=$1 AND status='serving'`, [t.doctor_id])).rowCount) throw conflict('Complete the current consultation first');
      if (t.arrival_status !== 'arrived' && !body.overrideArrival) throw conflict('This patient has not confirmed arrival. Confirm arrival, or start with an override.');
      if (t.arrival_status !== 'arrived') await audit(c, { clinicId: t.clinic_id, actorId: user.id, action: 'token.start_without_arrival', resourceType: 'token', resourceId: t.id });
      await setStatus(c, t, 'serving', user.id, 'consultation_started', ', consultation_started_at=now()');
      await c.query('INSERT INTO consultations(clinic_id,doctor_id,token_id,started_at) VALUES($1,$2,$3,now())', [t.clinic_id, t.doctor_id, t.id]);
      // Actual wait measured from each snapshot's calculation time, so error compares like with like.
      await c.query('UPDATE waiting_predictions SET actual_wait_minutes=ROUND((EXTRACT(EPOCH FROM (now()-calculated_at))/60)::numeric,2) WHERE token_id=$1 AND actual_wait_minutes IS NULL', [t.id]);
      await journey.goKind(c, t.id, 'consultation', user.id);
      await note('consultation_started', `Token ${t.token_label}: your consultation has started.`);
    }
    if (action === 'complete') {
      const more = await journey.hasStageAfterConsultation(c, t.id);
      await setStatus(c, t, more ? 'post' : 'done', user.id, 'consultation_completed', `, consultation_completed_at=now()${more ? '' : ', completed_at=now()'}`);
      await c.query('UPDATE consultations SET completed_at=now(), duration_seconds=GREATEST(0,ROUND(EXTRACT(EPOCH FROM (now()-started_at)))) WHERE token_id=$1', [t.id]);
      if (more) { await journey.goNext(c, t.id, user.id); await note('stage_changed', `Token ${t.token_label}: your consultation is complete. Please follow the next step.`); }
      else { await journey.finishByToken(c, t.id, 'completed', user.id); await note('visit_completed', `Token ${t.token_label}: your visit is complete.`); }
    }
    if (action === 'advance') {
      if (t.status !== 'post') throw conflict('Only a patient who has finished the consultation can move to the next stage');
      const r = await journey.goNext(c, t.id, user.id, body.toStageId || null);
      await setStatus(c, t, r.finished ? 'done' : 'post', user.id, r.finished ? 'visit_completed' : 'stage_advanced', r.finished ? ', completed_at=now()' : '');
      await note(r.finished ? 'visit_completed' : 'stage_changed', r.finished ? `Token ${t.token_label}: your visit is complete.` : `Token ${t.token_label}: moved to the next step.`);
      result.finished = r.finished;
    }
    if (action === 'missed') {
      await setStatus(c, t, 'missed', user.id, 'marked_missed', ', missed_count=missed_count+1, near_notified=false');
      await audit(c, { clinicId: t.clinic_id, actorId: user.id, action: 'token.marked_missed', resourceType: 'token', resourceId: t.id });
      await note('token_missed', `Token ${t.token_label} is marked temporarily unavailable. Reception can recall you. Your token is kept.`);
    }
    if (action === 'recall') {
      const policy = (await c.query('SELECT settings->>\'missed_policy\' AS p FROM clinics WHERE id=$1', [t.clinic_id])).rows[0].p;
      let seqSql = '';
      if (policy === 'behind_3') { // transparent rule: re-enter behind the 3rd waiting patient; original sequence stays in queue_events history
        const w = (await c.query(`SELECT queue_sequence FROM tokens WHERE doctor_id=$1 AND status='waiting' ORDER BY queue_sequence`, [t.doctor_id])).rows;
        if (w.length >= 3) { const a = Number(w[2].queue_sequence), b = w[3] ? Number(w[3].queue_sequence) : a + 1; seqSql = `, queue_sequence=${((a + b) / 2).toFixed(8)}`; }
        else if (w.length) seqSql = `, queue_sequence=${(Number(w[w.length - 1].queue_sequence) + 1).toFixed(8)}`;
      }
      await setStatus(c, t, 'waiting', user.id, 'recalled:' + (policy || 'original'), ', arrival_status=\'arrived\', arrived_at=now()' + seqSql);
      await audit(c, { clinicId: t.clinic_id, actorId: user.id, action: 'token.recalled', resourceType: 'token', resourceId: t.id, metadata: { policy: policy || 'original' } });
      await note('token_recalled', `Token ${t.token_label}: you have been recalled to the queue.`);
    }
    if (action === 'cancel') {
      await setStatus(c, t, 'cancelled', user.id, 'cancelled', ', cancelled_at=now()');
      await journey.finishByToken(c, t.id, 'cancelled', user.id);
      if (x.isStaff) await audit(c, { clinicId: t.clinic_id, actorId: user.id, action: 'token.cancelled', resourceType: 'token', resourceId: t.id });
    }

    await recalcDoctor(c, after, t.doctor_id);
    after.push(() => {
      ev.emitClinic(t.clinic_id, 'QUEUE_UPDATED', { tokenId: t.id, action });
      if (EVENT[action]) ev.emitClinic(t.clinic_id, EVENT[action], { tokenId: t.id });
      if (t.patient_user_id) ev.emitUser(t.patient_user_id, 'TOKEN_STATUS_CHANGED', { tokenId: t.id, action });
    });
    return { id: t.id, ...result };
  });
}

// Doctor operations: a doctor controls only their own record; clinic admins may control any doctor in their clinic.
async function doctorOp(user, doctorId, op, body) {
  return withTx(async (c, after) => {
    const d = (await c.query('SELECT * FROM doctors WHERE id=$1 FOR UPDATE', [doctorId])).rows[0]; if (!d) throw notFound('Doctor not found');
    const role = await roleIn(c, user.id, d.clinic_id); if (!role) throw notFound('Doctor not found');
    if (!(role === 'clinic_admin' || (role === 'doctor' && d.user_id === user.id))) throw forbidden();
    const sets = { availability: ['available', !!body.available], pause: ['paused', !!body.paused], delay: ['reported_delay_minutes', body.minutes] }[op];
    await c.query(`UPDATE doctors SET ${sets[0]}=$1, updated_at=now() WHERE id=$2`, [sets[1], d.id]);
    await audit(c, { clinicId: d.clinic_id, actorId: user.id, action: 'doctor.' + op, resourceType: 'doctor', resourceId: d.id, metadata: { value: sets[1] } });
    await recalcDoctor(c, after, d.id);
    after.push(() => { ev.emitClinic(d.clinic_id, 'DOCTOR_AVAILABILITY_CHANGED', { doctorId: d.id }); ev.emitClinic(d.clinic_id, 'QUEUE_UPDATED', { doctorId: d.id }); });
    return { id: d.id };
  });
}
module.exports = { perform, doctorOp, recalcDoctor, loadToken };
