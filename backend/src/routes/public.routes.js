// Public endpoints: no login, anonymous tokens only. Never returns names or any health information.
const router = require('express').Router(); const { z } = require('zod');
const { query } = require('../config/database'); const validate = require('../middleware/validate'); const wrap = require('../utils/async'); const { notFound } = require('../utils/errors'); const tokens = require('../services/token.service');
router.get('/track/:trackingId', validate(z.object({ trackingId: z.string().regex(/^[A-Za-z0-9_-]{16,40}$/) }), 'params'), wrap(async (req, res) => {
  const t = (await query('SELECT id FROM tokens WHERE tracking_id=$1', [req.params.trackingId])).rows[0]; if (!t) throw notFound('This tracking link is not valid');
  res.json({ data: await tokens.getView({ query }, t.id) });
}));
router.get('/display/:slug', validate(z.object({ slug: z.string().max(80) }), 'params'), wrap(async (req, res) => {
  const c = (await query(`SELECT id,name FROM clinics WHERE slug=$1 AND status='active'`, [req.params.slug])).rows[0]; if (!c) throw notFound('Clinic not found');
  const d = (await query(`SELECT d.id,d.display_name,d.paused,d.available,
      (SELECT token_label FROM tokens WHERE doctor_id=d.id AND status='serving') AS serving,
      ARRAY(SELECT token_label FROM tokens WHERE doctor_id=d.id AND status='waiting' ORDER BY queue_sequence LIMIT 8) AS waiting FROM doctors d WHERE d.clinic_id=$1 ORDER BY d.display_name`, [c.id])).rows;
  res.json({ data: { clinic: c.name, doctors: d.map((x) => ({ name: x.display_name, paused: x.paused, available: x.available, nowServing: x.serving, nextTokens: x.waiting })) } });
}));
module.exports = router;
