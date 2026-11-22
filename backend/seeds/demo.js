// Creates (or resets) ONE fictional clinic with fictional people, marked is_demo. Use a SEPARATE database/environment for demos.
// Requires DEMO_PASSWORD. Refuses to run in production unless ALLOW_DEMO_SEED=true.
const crypto = require('crypto');
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') { console.error('Refusing to seed demo data in production.'); process.exit(1); }
if (!process.env.DEMO_PASSWORD || process.env.DEMO_PASSWORD.length < 10) { console.error('Set DEMO_PASSWORD (10+ characters) first.'); process.exit(1); }
const { pool, withTx } = require('../src/config/database'); const auth = require('../src/services/auth.service'); const clinics = require('../src/services/clinic.service');
const D = 'demo.qflow.invalid', DURS = [420, 540, 360, 660, 480, 600, 420, 720, 540, 480, 510, 450];
(async () => {
  const hash = await auth.hash(process.env.DEMO_PASSWORD);
  await withTx(async (c) => {
    await c.query(`DELETE FROM clinics WHERE slug='demo-clinic' AND is_demo`); await c.query(`DELETE FROM users WHERE email LIKE '%@${D}'`);
    const mk = async (name, key) => (await c.query('INSERT INTO users(email,password_hash,full_name) VALUES($1,$2,$3) RETURNING id', [`${key}@${D}`, hash, name])).rows[0].id;
    const admin = await mk('Demo Admin (fictional)', 'admin'), rec = await mk('Demo Receptionist (fictional)', 'reception'), doc = await mk('Dr. Asha Demo (fictional)', 'doctor'), pat = await mk('Demo Patient (fictional)', 'patient');
    await c.query('INSERT INTO patient_profiles(user_id,display_name) VALUES($1,$2)', [pat, 'Demo Patient']);
    const cl = await clinics.createClinic(c, { ownerUserId: admin, name: 'Demo Clinic (simulated)', slug: 'demo-clinic', isDemo: true });
    await clinics.setWorkflow(c, cl.id, [{ name: 'Checkout' }]);
    const dep = (await c.query('SELECT id FROM departments WHERE clinic_id=$1', [cl.id])).rows[0].id;
    await c.query(`INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist'),($1,$3,'doctor')`, [cl.id, rec, doc]);
    const d = (await c.query('INSERT INTO doctors(clinic_id,user_id,department_id,display_name) VALUES($1,$2,$3,$4) RETURNING id', [cl.id, doc, dep, 'Dr. Asha Demo']).catch((e) => { throw e; })).rows[0].id;
    for (let i = 0; i < DURS.length; i++) { // fictional history so the prediction model has data
      const t = (await c.query(`INSERT INTO tokens(clinic_id,department_id,doctor_id,walk_in_name,token_day,token_number,token_label,queue_sequence,status,arrival_status,tracking_id,completed_at,consultation_started_at,consultation_completed_at)
        VALUES($1,$2,$3,$4,current_date,$5,$6,nextval('queue_sequence_seq'),'done','arrived',$7, now() - ($8||' minutes')::interval, now() - ($8||' minutes')::interval - ($9||' seconds')::interval, now() - ($8||' minutes')::interval) RETURNING id`,
        [cl.id, dep, d, `Sample ${i + 1}`, i + 1, 'A' + String(i + 1).padStart(3, '0'), crypto.randomBytes(16).toString('base64url'), String(200 - i * 10), String(DURS[i])])).rows[0].id;
      await c.query(`INSERT INTO consultations(clinic_id,doctor_id,token_id,started_at,completed_at,duration_seconds) VALUES($1,$2,$3, now() - ($4||' minutes')::interval - ($5||' seconds')::interval, now() - ($4||' minutes')::interval, $5)`, [cl.id, d, t, String(200 - i * 10), DURS[i]]);
    }
    await c.query('INSERT INTO token_counters(clinic_id,token_day,last_number) VALUES($1,current_date,$2)', [cl.id, DURS.length]);
  });
  console.log(`Demo clinic ready. Accounts: admin@${D}, reception@${D}, doctor@${D}, patient@${D} (password = DEMO_PASSWORD). All data is fictional.`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
