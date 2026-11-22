const { slugify } = require('../utils/ids'); const { audit } = require('./audit.service');
// Creates a clinic, makes `ownerUserId` its admin, and adds a default department and journey template.
async function createClinic(c, { ownerUserId, name, address = null, contactInfo = null, timezone = 'Asia/Kolkata', isDemo = false, slug }) {
  const cl = (await c.query('INSERT INTO clinics(name,slug,address,contact_info,timezone,is_demo) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,slug', [name.trim(), slug || slugify(name), address, contactInfo, timezone, isDemo])).rows[0];
  await c.query(`INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'clinic_admin')`, [cl.id, ownerUserId]);
  await c.query(`INSERT INTO departments(clinic_id,name) VALUES($1,'General')`, [cl.id]);
  await setWorkflow(c, cl.id, []);
  await audit(c, { clinicId: cl.id, actorId: ownerUserId, action: 'clinic.created', resourceType: 'clinic', resourceId: cl.id });
  return cl;
}
// Fixed stages: Registration, Waiting, Consultation. `after` = ordered post-consultation stages [{name, optional}].
// Old post stages are deactivated, not deleted, so existing journeys and history stay valid.
async function setWorkflow(c, clinicId, after) {
  let t = (await c.query('SELECT id FROM journey_templates WHERE clinic_id=$1 AND department_id IS NULL AND active ORDER BY created_at LIMIT 1', [clinicId])).rows[0];
  if (!t) {
    t = (await c.query(`INSERT INTO journey_templates(clinic_id,name) VALUES($1,'Default visit') RETURNING id`, [clinicId])).rows[0];
    await c.query(`INSERT INTO journey_template_stages(template_id,stage_name,stage_order,kind) VALUES($1,'Registration',1,'registration'),($1,'Waiting for consultation',2,'waiting'),($1,'Consultation',3,'consultation')`, [t.id]);
  } else await c.query(`UPDATE journey_template_stages SET active=false WHERE template_id=$1 AND stage_order>3`, [t.id]);
  const base = (await c.query('SELECT COALESCE(max(stage_order),3) AS m FROM journey_template_stages WHERE template_id=$1', [t.id])).rows[0].m;
  for (let i = 0; i < after.length; i++) await c.query(`INSERT INTO journey_template_stages(template_id,stage_name,stage_order,optional) VALUES($1,$2,$3,$4)`, [t.id, after[i].name, base + 1 + i, !!after[i].optional]);
}
module.exports = { createClinic, setWorkflow };
