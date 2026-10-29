-- Isolated OpenMontage composition queue. Each row and media output is owned by one NX user.
-- The first version supports one controlled single-host Remotion preview at a time.
CREATE TABLE openmontage_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  title text NOT NULL,
  spec jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed')),
  error text,
  media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX openmontage_jobs_owner_created_idx ON openmontage_jobs (owner_id, created_at DESC);
CREATE INDEX openmontage_jobs_active_idx ON openmontage_jobs (status, updated_at) WHERE status IN ('queued', 'running');
