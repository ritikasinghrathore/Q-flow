// Integration tests. They need a real Postgres. Run: DATABASE_URL=$TEST_DATABASE_URL npm run migrate && TEST_DATABASE_URL=... npm test
const test = require('node:test'); const assert = require('node:assert');
const URL_ = process.env.TEST_DATABASE_URL;
if (!URL_) { test('integration tests', { skip: 'Set TEST_DATABASE_URL to run them' }, () => {}); return; }
process.env.DATABASE_URL = URL_; process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(40); process.env.NODE_ENV = 'test';
const http = require('http'); const app = require('../src/app'); const { pool } = require('../src/config/database');
let base; const server = http.createServer(app);
const R = Math.random().toString(36).slice(2, 8), PW = 'correct-horse-9';
function client() {
  const s = { cookie: '', csrf: '' };
  s.call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: s.cookie, ...(s.csrf ? { 'x-csrf-token': s.csrf } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) s.cookie = sc.split(';')[0];
    const j = await r.json().catch(() => ({})); if (j.data && j.data.csrfToken) s.csrf = j.data.csrfToken; return { status: r.status, body: j };
  };
  return s;
}
const ctx = {};
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { server.close(); await pool.end(); });

test('register, csrf protection, login failure message', async () => {
  const a = client(); const r = await a.call('POST', '/api/auth/register', { email: `admin-${R}@t.test`, password: PW, fullName: 'Admin' }); assert.equal(r.status, 201); ctx.admin = a;
  const bad = client(); const l = await bad.call('POST', '/api/auth/login', { email: `admin-${R}@t.test`, password: 'wrong-password-1' }); assert.equal(l.status, 401);
  const unknown = await client().call('POST', '/api/auth/login', { email: `nobody-${R}@t.test`, password: 'wrong-password-1' }); assert.equal(unknown.body.error.message, l.body.error.message);
  const noCsrf = await fetch(base + '/api/clinics', { method: 'POST', headers: { 'content-type': 'application/json', cookie: a.cookie }, body: JSON.stringify({ name: 'No Csrf Clinic' }) }); assert.equal(noCsrf.status, 403);
});
test('clinic setup, staff roles, patient', async () => {
  const c = await ctx.admin.call('POST', '/api/clinics', { name: `Test Clinic ${R}` }); assert.equal(c.status, 201); ctx.clinic = c.body.data.id;
  const dup = await ctx.admin.call('POST', '/api/clinics', { name: `test clinic ${R}` }); assert.equal(dup.status, 409);
  const dep = (await ctx.admin.call('GET', `/api/clinics/${ctx.clinic}/departments`)).body.data[0].id;
  for (const [role, key] of [['receptionist', 'rec'], ['doctor', 'doc']]) {
    const r = await ctx.admin.call('POST', `/api/clinics/${ctx.clinic}/staff`, { email: `${key}-${R}@t.test`, fullName: key, role, temporaryPassword: PW, departmentId: dep }); assert.equal(r.status, 201);
    const s = client(); await s.call('POST', '/api/auth/login', { email: `${key}-${R}@t.test`, password: PW }); ctx[key] = s;
  }
  ctx.doctorId = (await ctx.admin.call('GET', `/api/clinics/${ctx.clinic}/doctors`)).body.data[0].id;
  const p = client(); await p.call('POST', '/api/auth/register', { email: `pat-${R}@t.test`, password: PW, fullName: 'Patient One' }); ctx.pat = p;
  const q = client(); await q.call('POST', '/api/auth/register', { email: `pat2-${R}@t.test`, password: PW, fullName: 'Patient Two' }); ctx.pat2 = q;
});
test('token creation: online token, idempotent replay, concurrent walk-ins are unique', async () => {
  const k = 'idem-' + R + '-1234';
  const a = await ctx.pat.call('POST', '/api/tokens', { clinicId: ctx.clinic, doctorId: ctx.doctorId }, { 'idempotency-key': k }); assert.equal(a.status, 201);
  const b = await ctx.pat.call('POST', '/api/tokens', { clinicId: ctx.clinic, doctorId: ctx.doctorId }, { 'idempotency-key': k }); assert.equal(b.status, 200); assert.equal(b.body.data.id, a.body.data.id);
  ctx.tok = a.body.data.id;
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => ctx.rec.call('POST', '/api/tokens', { clinicId: ctx.clinic, doctorId: ctx.doctorId, walkInName: 'Walk ' + i }, { 'idempotency-key': `walk-${R}-${i}-xxxx` })));
  assert.ok(rs.every((r) => r.status === 201)); const ids = rs.map((r) => r.body.data.id);
  const q = (await ctx.rec.call('GET', `/api/clinics/${ctx.clinic}/queue?limit=100`)).body.data; const labels = q.map((t) => t.token_label); assert.equal(new Set(labels).size, labels.length);
  assert.ok(ids.every((id) => q.some((t) => t.id === id)));
});
test('consultation lifecycle and rules', async () => {
  const bad = await ctx.doc.call('PATCH', `/api/tokens/${ctx.tok}/complete`, {}); assert.equal(bad.status, 409, 'waiting token cannot be completed');
  const noArr = await ctx.doc.call('PATCH', `/api/tokens/${ctx.tok}/start`, {}); assert.equal(noArr.status, 409, 'arrival not confirmed');
  assert.equal((await ctx.pat.call('PATCH', `/api/tokens/${ctx.tok}/arrival`, {})).status, 200);
  assert.equal((await ctx.pat.call('PATCH', `/api/tokens/${ctx.tok}/start`, {})).status, 403, 'patients cannot start consultations');
  assert.equal((await ctx.doc.call('PATCH', `/api/tokens/${ctx.tok}/start`, {})).status, 200);
  const other = (await ctx.rec.call('GET', `/api/clinics/${ctx.clinic}/queue?status=waiting`)).body.data[0].id;
  assert.equal((await ctx.doc.call('PATCH', `/api/tokens/${other}/start`, { overrideArrival: true })).status, 409, 'one consultation at a time');
  const v = (await ctx.pat.call('GET', `/api/tokens/${ctx.tok}`)).body.data; assert.equal(v.status, 'serving'); assert.ok(v.journey.stages.some((s) => s.state === 'active'));
  assert.equal((await ctx.doc.call('PATCH', `/api/tokens/${ctx.tok}/complete`, {})).status, 200);
  const done = (await ctx.pat.call('GET', `/api/tokens/${ctx.tok}`)).body.data; assert.ok(['post', 'done'].includes(done.status));
  assert.equal((await ctx.doc.call('PATCH', `/api/tokens/${ctx.tok}/start`, { overrideArrival: true })).status, 409, 'finished tokens cannot return to the queue');
});
test('missed turn and recall are audited', async () => {
  const t = (await ctx.rec.call('GET', `/api/clinics/${ctx.clinic}/queue?status=waiting`)).body.data[0].id;
  assert.equal((await ctx.rec.call('PATCH', `/api/tokens/${t}/missed`, {})).status, 200);
  assert.equal((await ctx.rec.call('PATCH', `/api/tokens/${t}/recall`, {})).status, 200);
  const log = (await ctx.admin.call('GET', `/api/clinics/${ctx.clinic}/audit-logs`)).body.data; assert.ok(log.some((l) => l.action === 'token.recalled'));
});
test('isolation: other clinics and other patients cannot read or act', async () => {
  const x = client(); await x.call('POST', '/api/auth/register', { email: `x-${R}@t.test`, password: PW, fullName: 'Other Admin' });
  assert.equal((await x.call('POST', '/api/clinics', { name: `Other Clinic ${R}` })).status, 201);
  assert.equal((await x.call('GET', `/api/clinics/${ctx.clinic}/queue`)).status, 403);
  assert.equal((await x.call('GET', `/api/tokens/${ctx.tok}`)).status, 404);
  assert.equal((await x.call('PATCH', `/api/tokens/${ctx.tok}/cancel`, {})).status, 404);
  assert.equal((await ctx.pat2.call('GET', `/api/tokens/${ctx.tok}`)).status, 404, 'another patient cannot read it');
  assert.equal((await ctx.pat.call('GET', `/api/clinics/${ctx.clinic}/queue`)).status, 403, 'patients cannot read the staff queue');
  assert.equal((await ctx.pat.call('GET', `/api/clinics/${ctx.clinic}/audit-logs`)).status, 403);
});
test('public tracking and display expose no names', async () => {
  const t = (await ctx.pat.call('POST', '/api/tokens', { clinicId: ctx.clinic, doctorId: ctx.doctorId })).body.data.id;
  const row = await pool.query('SELECT tracking_id FROM tokens WHERE id=$1', [t]);
  const tr = await (await fetch(`${base}/api/public/track/${row.rows[0].tracking_id}`)).text(); assert.ok(!tr.includes('Patient One'));
  const ds = await (await fetch(`${base}/api/public/display/test-clinic-${R}`)).text(); assert.ok(!ds.includes('Patient One') && !ds.includes('Walk '));
});
