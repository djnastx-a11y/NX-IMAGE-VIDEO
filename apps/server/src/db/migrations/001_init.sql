-- NX STUDIO initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  id           text PRIMARY KEY,               -- sha256 of the cookie token, the raw token is never stored
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  color       text NOT NULL DEFAULT '#7c5cff',
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_idx ON projects (owner_id, archived, updated_at DESC);

CREATE TABLE generation_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id       uuid REFERENCES projects(id) ON DELETE SET NULL,
  module           text NOT NULL CHECK (module IN ('image', 'video')),
  operation        text NOT NULL,
  kind             text NOT NULL DEFAULT 'generate',
  parent_job_id    uuid REFERENCES generation_jobs(id) ON DELETE SET NULL,
  batch_id         uuid NOT NULL,
  params           jsonb NOT NULL,
  provider_id      text,
  model            text,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','starting','processing','encoding','completed','failed','cancelled')),
  stage            text,
  progress         real NOT NULL DEFAULT 0,
  priority         integer NOT NULL DEFAULT 0,
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 3,
  error            text,
  error_code       text,
  cancel_requested boolean NOT NULL DEFAULT false,
  run_after        timestamptz NOT NULL DEFAULT now(),
  worker_id        text,
  heartbeat_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  duration_ms      integer,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX jobs_queue_idx ON generation_jobs (priority DESC, created_at) WHERE status = 'queued' AND deleted_at IS NULL;
CREATE INDEX jobs_owner_idx ON generation_jobs (owner_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX jobs_running_idx ON generation_jobs (heartbeat_at) WHERE status IN ('starting','processing','encoding');

CREATE TABLE media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
  job_id        uuid REFERENCES generation_jobs(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('image', 'video', 'mask')),
  source        text NOT NULL CHECK (source IN ('upload', 'generated')),
  storage_key   text NOT NULL,
  thumb_key     text,
  mime          text NOT NULL,
  width         integer,
  height        integer,
  duration_sec  real,
  size_bytes    bigint NOT NULL,
  original_name text,
  favorite      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX media_owner_idx ON media (owner_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX media_project_idx ON media (project_id) WHERE deleted_at IS NULL;
CREATE INDEX media_job_idx ON media (job_id);

CREATE TABLE generation_outputs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     uuid NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  idx        integer NOT NULL DEFAULT 0,
  seed       bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, idx)
);

CREATE TABLE job_logs (
  id      bigserial PRIMARY KEY,
  job_id  uuid NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now(),
  level   text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  data    jsonb
);
CREATE INDEX job_logs_job_idx ON job_logs (job_id, id);

CREATE TABLE presets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid REFERENCES users(id) ON DELETE CASCADE,   -- NULL = built-in
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  module      text NOT NULL CHECK (module IN ('image', 'video')),
  slug        text UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  builtin     boolean NOT NULL DEFAULT false,
  params      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Admin overlay for the providers registered in code/config (secrets never live here)
CREATE TABLE providers (
  id         text PRIMARY KEY,
  module     text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_settings (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action  text NOT NULL,
  target  text,
  data    jsonb,
  ip      text
);
CREATE INDEX audit_logs_at_idx ON audit_logs (at DESC);

-- Real-time: every job change is broadcast; API processes LISTEN and push to browsers (SSE).
CREATE FUNCTION notify_job_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('nx_job_events', NEW.id::text || ':' || NEW.owner_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generation_jobs_notify
AFTER INSERT OR UPDATE ON generation_jobs
FOR EACH ROW EXECUTE FUNCTION notify_job_change();
