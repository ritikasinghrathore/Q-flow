const { badRequest } = require('../utils/errors');
async function createJourney(c, t, userId) {
  let tpl = (await c.query(`SELECT id FROM journey_templates WHERE clinic_id=$1 AND department_id=$2 AND active ORDER BY created_at LIMIT 1`, [t.clinic_id, t.department_id])).rows[0]
    || (await c.query(`SELECT id FROM journey_templates WHERE clinic_id=$1 AND department_id IS NULL AND active ORDER BY created_at LIMIT 1`, [t.clinic_id])).rows[0];
  if (!tpl) throw badRequest('This clinic has no journey template configured');
  const st = (await c.query(`SELECT id FROM journey_template_stages WHERE template_id=$1 AND active AND kind='waiting' ORDER BY stage_order LIMIT 1`, [tpl.id])).rows[0];
  const j = (await c.query(`INSERT INTO journeys(clinic_id,token_id,template_id,current_stage_id) VALUES($1,$2,$3,$4) RETURNING id`, [t.clinic_id, t.id, tpl.id, st ? st.id : null])).rows[0];
  await c.query(`INSERT INTO journey_events(clinic_id,journey_id,stage_id,event_type,actor_user_id) VALUES($1,$2,$3,'journey_started',$4)`, [t.clinic_id, j.id, st ? st.id : null, userId]);
}
async function journeyOf(c, tokenId) {
  return (await c.query(`SELECT j.*, s.stage_order AS cur_order FROM journeys j LEFT JOIN journey_template_stages s ON s.id=j.current_stage_id WHERE j.token_id=$1 FOR UPDATE OF j`, [tokenId])).rows[0];
}
async function setStage(c, j, stageId, userId, eventType) {
  await c.query('UPDATE journeys SET current_stage_id=$1, updated_at=now() WHERE id=$2', [stageId, j.id]);
  await c.query(`INSERT INTO journey_events(clinic_id,journey_id,stage_id,event_type,actor_user_id) VALUES($1,$2,$3,$4,$5)`, [j.clinic_id, j.id, stageId, eventType, userId]);
}
async function goKind(c, tokenId, kind, userId) {
  const j = await journeyOf(c, tokenId); if (!j) return;
  const s = (await c.query(`SELECT id FROM journey_template_stages WHERE template_id=$1 AND active AND kind=$2 ORDER BY stage_order LIMIT 1`, [j.template_id, kind])).rows[0];
  if (s) await setStage(c, j, s.id, userId, 'stage_' + kind);
}
// Moves to the next active stage (or an explicit later stage, which lets staff skip optional stages). Returns {finished}.
async function goNext(c, tokenId, userId, toStageId = null) {
  const j = await journeyOf(c, tokenId); if (!j) return { finished: true };
  let next;
  if (toStageId) {
    next = (await c.query(`SELECT id FROM journey_template_stages WHERE id=$1 AND template_id=$2 AND active AND stage_order>$3`, [toStageId, j.template_id, j.cur_order || 0])).rows[0];
    if (!next) throw badRequest('That stage is not a later stage of this journey');
  } else next = (await c.query(`SELECT id FROM journey_template_stages WHERE template_id=$1 AND active AND stage_order>$2 ORDER BY stage_order LIMIT 1`, [j.template_id, j.cur_order || 0])).rows[0];
  if (!next) { await finish(c, j, 'completed', userId); return { finished: true }; }
  await setStage(c, j, next.id, userId, 'stage_advanced'); return { finished: false };
}
async function finish(c, j, status, userId) {
  await c.query(`UPDATE journeys SET status=$1, completed_at=now(), updated_at=now() WHERE id=$2`, [status, j.id]);
  await c.query(`INSERT INTO journey_events(clinic_id,journey_id,event_type,actor_user_id) VALUES($1,$2,$3,$4)`, [j.clinic_id, j.id, 'journey_' + status, userId]);
}
async function finishByToken(c, tokenId, status, userId) { const j = await journeyOf(c, tokenId); if (j) await finish(c, j, status, userId); }
// Consultation stage is "after" the waiting stage; a clinic without later stages finishes right after consultation.
async function hasStageAfterConsultation(c, tokenId) {
  const j = await journeyOf(c, tokenId); if (!j) return false;
  return (await c.query(`SELECT 1 FROM journey_template_stages WHERE template_id=$1 AND active AND stage_order>$2 LIMIT 1`, [j.template_id, j.cur_order || 0])).rowCount > 0;
}
module.exports = { createJourney, goKind, goNext, finishByToken, hasStageAfterConsultation };
