const { emitUser } = require('../realtime/events');
const PREF_TYPES = ['arrival_approaching', 'estimate_changed']; // others are essential and always sent
// Delivery providers. Only in-app exists. SMS/email/WhatsApp must be registered here after real setup and testing;
// until then nothing external is sent and nothing is reported as delivered.
const providers = { in_app: async () => ({ reference: null }) };
const registerProvider = (name, fn) => { providers[name] = fn; };

// In-app rows are stored as 'sent' (available to fetch). 'delivered' is only used when a provider confirms delivery.
async function notify(db, after, { userId, clinicId = null, tokenId = null, type, message }) {
  if (!userId) return null;
  if (PREF_TYPES.includes(type)) {
    const r = await db.query(`SELECT notification_prefs->>$2 AS v FROM users WHERE id=$1`, [userId, type]);
    if (r.rows[0] && r.rows[0].v === 'false') return null;
  }
  const r = await db.query(
    `INSERT INTO notifications(user_id,clinic_id,token_id,notification_type,message,status,delivery_provider) VALUES($1,$2,$3,$4,$5,'sent','in_app') RETURNING id`,
    [userId, clinicId, tokenId, type, message]);
  after.push(() => emitUser(userId, 'NOTIFICATION_CREATED', { id: r.rows[0].id, type }));
  return r.rows[0].id;
}
module.exports = { notify, registerProvider, providers };
