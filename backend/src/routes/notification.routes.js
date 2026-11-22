const router = require('express').Router(); const { z } = require('zod');
const { query } = require('../config/database'); const { authenticate } = require('../middleware/authenticate'); const validate = require('../middleware/validate'); const wrap = require('../utils/async'); const { params } = require('../utils/ids'); const { page } = require('../utils/pagination'); const { notFound } = require('../utils/errors');
router.use(authenticate);
router.get('/', validate(page.extend({ unread: z.enum(['true', 'false']).optional() }), 'query'), wrap(async (req, res) => {
  const r = await query(`SELECT id,notification_type AS type,message,status,read_at AS "readAt",created_at AS "createdAt",token_id AS "tokenId" FROM notifications WHERE user_id=$1 ${req.query.unread === 'true' ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [req.user.id, req.query.limit, req.query.offset]);
  res.json({ data: r.rows });
}));
router.patch('/preferences', validate(z.object({ arrival_approaching: z.boolean().optional(), estimate_changed: z.boolean().optional() }).strict()), wrap(async (req, res) => {
  await query(`UPDATE users SET notification_prefs=notification_prefs || $2::jsonb, updated_at=now() WHERE id=$1`, [req.user.id, JSON.stringify(req.body)]); res.json({ data: { ok: true } });
}));
router.patch('/:notificationId/read', validate(params('notificationId'), 'params'), wrap(async (req, res) => {
  const r = await query('UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.notificationId, req.user.id]); // scoped to the signed-in user
  if (!r.rowCount) throw notFound(); res.json({ data: { ok: true } });
}));
module.exports = router;
