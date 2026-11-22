const { query } = require('../config/database'); const { forbidden } = require('../utils/errors');
// The role always comes from the database (clinic_memberships), never from the request.
async function roleIn(db, userId, clinicId) {
  const r = await db.query(`SELECT role FROM clinic_memberships WHERE user_id=$1 AND clinic_id=$2 AND membership_status='active' ORDER BY CASE role WHEN 'clinic_admin' THEN 0 WHEN 'receptionist' THEN 1 ELSE 2 END LIMIT 1`, [userId, clinicId]);
  return r.rows[0] ? r.rows[0].role : null;
}
const requireRole = (...roles) => async (req, _res, next) => {
  try { const role = await roleIn({ query }, req.user.id, req.params.clinicId); if (!role || !roles.includes(role)) throw forbidden(); req.role = role; next(); }
  catch (e) { next(e); }
};
module.exports = { roleIn, requireRole };
