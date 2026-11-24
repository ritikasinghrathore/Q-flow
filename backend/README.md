# Q-FLOW backend (Phases 1–4 core)

Node 20+, Express, PostgreSQL (Neon), Socket.IO, Argon2id, Zod. Frontend: Netlify. API: Render.

## Honest status
**Written, syntax-checked, and the prediction engine unit-tested (8/8 pass).**
**NOT yet run against a real database or deployed.** The API integration tests (`tests/api.test.js`) are written but have never been executed. Run them yourself (below) and expect to fix small bugs.
The frontend in `../frontend/index.html` now calls this API (no localStorage database). It was smoke-tested against stubbed responses only, never against the real server. Patient sharing (Family) and staff-side per-patient estimates are not in it yet.

### Built
Auth (register/login/logout/me, Argon2id, HttpOnly sessions, CSRF header, rate limits, password reset tokens) · clinics, departments, doctors, staff and roles, workflow stages, clinic rules · tokens with concurrency-safe numbering and idempotency · queue with explicit transitions (arrival, start, complete, missed, recall, cancel, advance) · journeys with event history · prediction engine (`wma-v1`) with stored snapshots and actual-wait capture · arrival windows · de-duplicated in-app notifications with preferences · public anonymous tracking and token-display endpoints · Socket.IO rooms (authenticated, server-emitted only) · audit logs · demo seed.

### Added later (written and syntax-checked, NOT yet run against a real database)
Family Journey Mode (`/api/family/*`: invite by email, list, revoke, view a shared person's active visits) · Congestion Radar and prediction accuracy report (`GET /api/clinics/:id/analytics?days=7`: time per stage, slowest stage, doctor load, busy hours, average error and range coverage) · staff-side per-patient estimates in the queue · `GET /api/health` · Account section (`GET/PATCH /api/account`: account details, editable profile, visit history and stats, family sharing summary).

### Not built yet
offline outbox sync · frontend wiring · SMS/email/WhatsApp providers (password reset therefore cannot send email in production) · backups automation · data-retention jobs · email verification · journey-template editing beyond `PUT /workflow` · dedicated receptionist/admin screens.

## Local setup
```
cd backend && npm install
cp .env.example .env   # fill DATABASE_URL and SESSION_SECRET
set -a; . ./.env; set +a
npm run migrate && npm start
```
Tests: create an **empty separate** Neon branch/database, then
`DATABASE_URL=$TEST_DATABASE_URL SESSION_SECRET=$(openssl rand -hex 24) npm run migrate && TEST_DATABASE_URL=... npm test`.

## Neon
Create a project, copy the **pooled** connection string (it ends with `sslmode=require`). Keep it only in Render's environment variables. Use a second Neon branch for demos and tests. Neon free plans keep limited point-in-time history; check the current plan before relying on it.

## Render (Web Service)
Root directory `backend` · Build `npm install` · Start `npm start` · Pre-deploy command `npm run migrate`.
Env vars: `NODE_ENV=production`, `DATABASE_URL`, `FRONTEND_URL=https://YOUR-SITE.netlify.app`, `SESSION_SECRET` (random 48+ chars), `COOKIE_SAMESITE=lax`. Health check path `/health`. Render's free plan sleeps when idle, so the first request can take about a minute.

## Netlify
Deploy the `frontend` folder. Edit `netlify.toml` with your Render URL (see the comment in it). Once the frontend uses `fetch('/api/...', {credentials:'include'})` it will be same-origin. Netlify's proxy may not carry WebSockets, so Socket.IO should use polling transport there, or give both apps subdomains of one custom domain.

## API (all JSON; success `{data}`, errors `{error:{code,message}}`)
Mutating calls need the header `X-CSRF-Token` (returned by login/register/me). Token creation also takes `Idempotency-Key`.
- `POST /api/auth/register|login|logout|forgot-password|reset-password`, `GET /api/auth/me`
- `GET/POST /api/clinics`, `GET/PATCH /api/clinics/:id`, `PUT /api/clinics/:id/workflow`
- `GET/POST /api/clinics/:id/doctors|departments|staff`, `DELETE /api/clinics/:id/staff/:membershipId`, `GET /api/clinics/:id/audit-logs`
- `POST /api/tokens` (patient, or `walkInName` for reception) · `GET /api/tokens/:id`, `/journey` · `GET /api/my/tokens` · `GET /api/clinics/:id/queue`
- `PATCH /api/tokens/:id/arrival|start|complete|missed|recall|cancel|advance`
- `PATCH /api/doctors/:id/availability|pause|delay`
- `GET /api/notifications`, `PATCH /api/notifications/:id/read|preferences`
- Public: `GET /api/public/track/:trackingId`, `GET /api/public/display/:slug`
- Realtime events (ids only): `TOKEN_CREATED, QUEUE_UPDATED, TOKEN_STATUS_CHANGED, CONSULTATION_STARTED, CONSULTATION_COMPLETED, JOURNEY_STAGE_CHANGED, TOKEN_RECALLED, TOKEN_ARRIVED, DOCTOR_AVAILABILITY_CHANGED, WAITING_ESTIMATE_UPDATED, NOTIFICATION_CREATED`. After any event or reconnect, refetch from REST.

## Security notes and limits
Passwords: Argon2id. Sessions: random 256-bit token, stored only as an HMAC; HttpOnly cookie; CSRF header check; sign-out everywhere on password reset. All SQL is parameterised. Roles come from `clinic_memberships`, never from the request. Not reviewed by a security professional; **no legal or healthcare-regulatory compliance is claimed**. Known gaps: no email verification, no account lockout beyond rate limiting, no retention/deletion jobs, queue recalculation uses one query per waiting patient (fine for small clinics).

## Backup and recovery
Neon keeps point-in-time history (length depends on plan). Also take a weekly `pg_dump "$DATABASE_URL" -Fc -f qflow.dump` and test `pg_restore` into a scratch database.

## Prediction model (`wma-v1`)
Recency-weighted mean of recorded consultation seconds (weight 0.85^age, normalised), doctor → department → clinic fallback when fewer than 3 samples. Remaining time of the current consultation = mean − elapsed. Range ≈ 80% interval from the weighted spread; pauses, unavailability and reported delay widen it and cap confidence at low. Every snapshot stores factors; the actual wait from the snapshot time to consultation start is saved for error analysis. This is statistics, not AI, and is not yet validated on real clinic data.
