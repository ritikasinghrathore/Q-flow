const audit = (db, { clinicId = null, actorId = null, action, resourceType, resourceId = null, metadata = {} }) =>
  db.query('INSERT INTO audit_logs(clinic_id,actor_user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,$5,$6)', [clinicId, actorId, action, resourceType, resourceId, metadata]);
module.exports = { audit };
