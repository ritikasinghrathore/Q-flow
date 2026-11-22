// Transparent statistical waiting-time model ("wma-v1"). No machine learning is used or claimed.
// Newer consultations always weigh more than older ones: weight = decay^(age rank), then normalised.
const MODEL_VERSION = 'wma-v1';

// durations are seconds, ordered OLDEST -> NEWEST.
function weightedStats(durations, decay = 0.85) {
  const n = durations.length; if (!n) return null;
  let sw = 0, sw2 = 0, sm = 0;
  const w = durations.map((_, i) => decay ** (n - 1 - i));
  durations.forEach((d, i) => { sw += w[i]; sw2 += w[i] * w[i]; sm += w[i] * d; });
  const mean = sm / sw;
  const variance = durations.reduce((s, d, i) => s + w[i] * (d - mean) ** 2, 0) / sw;
  return { mean, sd: Math.sqrt(variance), n, effectiveN: (sw * sw) / sw2 };
}

function predict({ durations = [], ahead, hasActive = false, activeElapsedSec = 0, delayMin = 0, paused = false, available = true, notArrivedAhead = 0, source = 'none', defaultSec = 480 }) {
  const st = weightedStats(durations) || { mean: defaultSec, sd: defaultSec * 0.5, n: 0, effectiveN: 0 };
  const mean = st.mean, sd = Math.max(st.sd, mean * 0.15);
  // Remaining time of the consultation in progress: mean minus elapsed; if it is already overrunning, assume a short remainder.
  const remaining = hasActive ? (activeElapsedSec < mean ? mean - activeElapsedSec : Math.max(60, Math.min(sd, mean * 0.25))) : 0;
  const expected = remaining + ahead * mean + delayMin * 60;
  const variance = ahead * sd * sd + (hasActive ? sd * sd : 0);
  const half = 1.28 * Math.sqrt(variance); // ~80% interval under a normal approximation
  let lo = Math.max(0, expected - half), hi = expected + half + (variance === 0 ? Math.min(120, mean * 0.25) : 0);
  if (paused) hi += 15 * 60; // service paused: resume time unknown
  if (!available) hi += 30 * 60;
  let minMinutes = Math.floor(lo / 60), maxMinutes = Math.max(Math.ceil(hi / 60), minMinutes + 1);
  if (maxMinutes > 30) { minMinutes = Math.floor(minMinutes / 5) * 5; maxMinutes = Math.ceil(maxMinutes / 5) * 5; } // avoid false precision
  let confidence = st.n >= 10 ? 'high' : st.n >= 3 ? 'medium' : 'low';
  if (paused || !available) confidence = 'low';
  return {
    minMinutes, maxMinutes, confidence, modelVersion: MODEL_VERSION,
    factors: {
      patientsAhead: ahead, consultationInProgress: hasActive, remainingMinutesForCurrent: Math.round(remaining / 60 * 10) / 10,
      meanConsultationMinutes: Math.round(mean / 60 * 10) / 10, sampleSize: st.n, dataSource: st.n ? source : 'default 8 min (no data yet)',
      reportedDelayMinutes: delayMin, servicePaused: paused, doctorAvailable: available, notArrivedAhead, interval: 'about 80% range, not a guarantee',
    },
  };
}

// Suggested arrival window, in minutes from now. Always an estimate.
function arrivalWindow(p, bufferMin = 15) {
  if (p.minMinutes <= bufferMin) return { arriveNow: true, fromMinutes: 0, toMinutes: 0 };
  const from = Math.max(0, p.minMinutes - bufferMin), to = Math.max(from + 5, p.maxMinutes - 10);
  return { arriveNow: false, fromMinutes: from, toMinutes: to };
}

// Falls back doctor -> department -> clinic when a level has fewer than 3 recorded consultations.
async function durationsFor(db, doctor) {
  const levels = [
    ['doctor', 'SELECT duration_seconds FROM consultations WHERE doctor_id=$1 AND duration_seconds IS NOT NULL ORDER BY completed_at DESC LIMIT 30', doctor.id],
    ['department', 'SELECT c.duration_seconds FROM consultations c JOIN doctors d ON d.id=c.doctor_id WHERE d.department_id=$1 AND c.duration_seconds IS NOT NULL ORDER BY c.completed_at DESC LIMIT 30', doctor.department_id],
    ['clinic', 'SELECT duration_seconds FROM consultations WHERE clinic_id=$1 AND duration_seconds IS NOT NULL ORDER BY completed_at DESC LIMIT 30', doctor.clinic_id],
  ];
  let best = { durations: [], source: 'none' };
  for (const [source, sql, id] of levels) {
    const rows = (await db.query(sql, [id])).rows.map((r) => r.duration_seconds).reverse();
    if (rows.length >= 3) return { durations: rows, source };
    if (rows.length > best.durations.length) best = { durations: rows, source };
  }
  return best;
}
module.exports = { MODEL_VERSION, weightedStats, predict, arrivalWindow, durationsFor };
