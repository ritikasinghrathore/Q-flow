// Congestion Radar and prediction accuracy reports for clinic staff.
const router = require('express').Router(); const { z } = require('zod');
const { query } = require('../config/database'); const { authenticate } = require('../middleware/authenticate'); const { requireRole } = require('../middleware/authorize');
const validate = require('../middleware/validate'); const wrap = require('../utils/async'); const { params } = require('../utils/ids');
const r1 = (n) => (n == null ? null : Math.round(Number(n) * 10) / 10);
router.get('/:clinicId/analytics', authenticate, validate(params('clinicId'), 'params'), requireRole('clinic_admin', 'receptionist'),
  validate(z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), 'query'), wrap(async (req, res) => {
    const { clinicId } = req.params, days = String(req.query.days);
    // Time spent in each journey stage = gap between a stage event and the next event of the same journey.
    const stages = (await query(`WITH ev AS (SELECT e.journey_id, e.stage_id, e.created_at, LEAD(e.created_at) OVER (PARTITION BY e.journey_id ORDER BY e.created_at) AS next_at
        FROM journey_events e WHERE e.clinic_id=$1 AND e.created_at > now() - ($2 || ' days')::interval)
      SELECT s.stage_name AS stage, count(*)::int AS visits, avg(extract(epoch FROM next_at-created_at))/60 AS avg_min,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM next_at-created_at))/60 AS p90_min
      FROM ev JOIN journey_template_stages s ON s.id=ev.stage_id WHERE next_at IS NOT NULL GROUP BY s.stage_name ORDER BY avg_min DESC`, [clinicId, days])).rows;
    const total = stages.reduce((a, s) => a + Number(s.avg_min), 0);
    const radar = stages.map((s) => ({ stage: s.stage, visits: s.visits, avgMinutes: r1(s.avg_min), p90Minutes: r1(s.p90_min), shareOfTime: total ? Math.round((Number(s.avg_min) / total) * 100) : 0 }));
    const doctors = (await query(`SELECT d.id, d.display_name AS name, count(c.id)::int AS consultations, avg(c.duration_seconds)/60 AS avg_min,
        (SELECT count(*)::int FROM tokens t WHERE t.doctor_id=d.id AND t.status='waiting') AS waiting_now
      FROM doctors d LEFT JOIN consultations c ON c.doctor_id=d.id AND c.completed_at > now() - ($2 || ' days')::interval
      WHERE d.clinic_id=$1 GROUP BY d.id, d.display_name ORDER BY waiting_now DESC`, [clinicId, days])).rows
      .map((d) => ({ id: d.id, name: d.name, consultations: d.consultations, avgConsultationMinutes: r1(d.avg_min), waitingNow: d.waiting_now }));
    const hours = (await query(`SELECT extract(hour FROM created_at)::int AS hour, count(*)::int AS tokens FROM tokens WHERE clinic_id=$1 AND created_at > now() - ($2 || ' days')::interval GROUP BY 1 ORDER BY 1`, [clinicId, days])).rows;
    // Prediction accuracy: compare each stored estimate with the wait that actually happened.
    const a = (await query(`SELECT count(*)::int AS n, avg(abs(actual_wait_minutes - (predicted_min_minutes + predicted_max_minutes)/2.0)) AS mae,
        avg(CASE WHEN actual_wait_minutes BETWEEN predicted_min_minutes AND predicted_max_minutes THEN 1.0 ELSE 0.0 END) AS coverage
      FROM waiting_predictions WHERE clinic_id=$1 AND actual_wait_minutes IS NOT NULL AND calculated_at > now() - ($2 || ' days')::interval`, [clinicId, days])).rows[0];
    res.json({ data: { days: Number(days), radar, bottleneck: radar[0] || null, doctors, busyHours: hours,
      accuracy: { samples: a.n, meanAbsoluteErrorMinutes: r1(a.mae), rangeCoveragePercent: a.n ? Math.round(Number(a.coverage) * 100) : null,
        note: a.n < 30 ? 'Fewer than 30 measured waits: treat these numbers as early signs, not proof.' : 'Measured from real recorded waits.' } } });
  }));
module.exports = router;
