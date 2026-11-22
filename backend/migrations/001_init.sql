CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  password_hash text NOT NULL,
  full_name text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 80),
  phone_number text CHECK (phone_number IS NULL OR length(phone_number) <= 20),
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','suspended','deleted')),
  email_verified_at timestamptz,
  notification_prefs jsonb NOT NULL DEFAULT '{"arrival_approaching":true,"estimate_changed":true}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 3 AND 80),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  address text, contact_info text, timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  is_demo boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{"missed_policy":"original","arrival_window_minutes":15,"significant_change_minutes":10,"turn_approaching_ahead":2}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX clinics_name_uq ON clinics(lower(name));
CREATE TABLE clinic_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('clinic_admin','receptionist','doctor')),
  membership_status text NOT NULL DEFAULT 'active' CHECK (membership_status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, user_id, role)
);
CREATE INDEX memberships_user_idx ON clinic_memberships(user_id);
CREATE TABLE patient_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 60), description text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX departments_name_uq ON departments(clinic_id, lower(name));
CREATE TABLE doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 80),
  available boolean NOT NULL DEFAULT true, paused boolean NOT NULL DEFAULT false,
  reported_delay_minutes int NOT NULL DEFAULT 0 CHECK (reported_delay_minutes BETWEEN 0 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctors_clinic_idx ON doctors(clinic_id);
CREATE UNIQUE INDEX doctors_user_uq ON doctors(clinic_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE journey_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  department_id uuid REFERENCES departments(id) ON DELETE CASCADE,
  name text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE journey_template_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES journey_templates(id) ON DELETE CASCADE,
  stage_name text NOT NULL CHECK (length(stage_name) BETWEEN 2 AND 40),
  stage_order int NOT NULL CHECK (stage_order >= 1),
  kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('registration','waiting','consultation','other')),
  optional boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
  UNIQUE (template_id, stage_order)
);

CREATE SEQUENCE queue_sequence_seq;
CREATE TABLE token_counters (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  token_day date NOT NULL, last_number int NOT NULL DEFAULT 0,
  PRIMARY KEY (clinic_id, token_day)
);
CREATE TABLE tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  patient_profile_id uuid REFERENCES patient_profiles(id) ON DELETE SET NULL,
  walk_in_name text CHECK (walk_in_name IS NULL OR length(walk_in_name) BETWEEN 1 AND 80),
  token_day date NOT NULL, token_number int NOT NULL, token_label text NOT NULL,
  queue_sequence numeric(24,8) NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','serving','missed','post','done','cancelled')),
  arrival_status text NOT NULL DEFAULT 'not_arrived' CHECK (arrival_status IN ('not_arrived','arrived')),
  tracking_id text NOT NULL UNIQUE,
  missed_count int NOT NULL DEFAULT 0,
  near_notified boolean NOT NULL DEFAULT false,
  last_notified_max int, last_notified_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL, idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(), arrived_at timestamptz,
  consultation_started_at timestamptz, consultation_completed_at timestamptz,
  completed_at timestamptz, cancelled_at timestamptz,
  CHECK (patient_profile_id IS NOT NULL OR walk_in_name IS NOT NULL),
  UNIQUE (clinic_id, token_day, token_number)
);
CREATE UNIQUE INDEX tokens_idem_uq ON tokens(clinic_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX tokens_one_serving_per_doctor ON tokens(doctor_id) WHERE status = 'serving';
CREATE UNIQUE INDEX tokens_one_active_per_patient_doctor ON tokens(patient_profile_id, doctor_id) WHERE patient_profile_id IS NOT NULL AND status IN ('waiting','serving','missed','post');
CREATE INDEX tokens_queue_idx ON tokens(doctor_id, status, queue_sequence);
CREATE INDEX tokens_clinic_status_idx ON tokens(clinic_id, status);

CREATE TABLE journeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  token_id uuid NOT NULL UNIQUE REFERENCES tokens(id) ON DELETE CASCADE,
  template_id uuid REFERENCES journey_templates(id) ON DELETE SET NULL,
  current_stage_id uuid REFERENCES journey_template_stages(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE journey_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  stage_id uuid REFERENCES journey_template_stages(id) ON DELETE SET NULL,
  event_type text NOT NULL, actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journey_events_idx ON journey_events(journey_id, created_at);

CREATE TABLE consultations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  token_id uuid NOT NULL UNIQUE REFERENCES tokens(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL, completed_at timestamptz,
  duration_seconds int CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consultations_doctor_idx ON consultations(doctor_id, completed_at);
CREATE TABLE waiting_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  token_id uuid NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  predicted_min_minutes int NOT NULL, predicted_max_minutes int NOT NULL CHECK (predicted_max_minutes >= predicted_min_minutes),
  confidence text NOT NULL CHECK (confidence IN ('low','medium','high')),
  model_version text NOT NULL, factors jsonb NOT NULL DEFAULT '{}',
  calculated_at timestamptz NOT NULL DEFAULT now(), actual_wait_minutes numeric(8,2)
);
CREATE INDEX predictions_token_idx ON waiting_predictions(token_id, calculated_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  token_id uuid REFERENCES tokens(id) ON DELETE CASCADE,
  notification_type text NOT NULL, message text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed')),
  read_at timestamptz, delivery_provider text, delivery_reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE TABLE caregiver_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caregiver_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_scope text NOT NULL DEFAULT 'view_journeys',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  CHECK (patient_user_id <> caregiver_user_id)
);
CREATE UNIQUE INDEX caregiver_active_uq ON caregiver_permissions(patient_user_id, caregiver_user_id) WHERE status = 'active';
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL, resource_type text NOT NULL, resource_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_clinic_idx ON audit_logs(clinic_id, created_at DESC);
CREATE TABLE queue_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  token_id uuid NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  event_type text NOT NULL, previous_status text, new_status text,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queue_events_idx ON queue_events(clinic_id, created_at DESC);
