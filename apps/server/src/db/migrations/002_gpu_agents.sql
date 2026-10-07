-- GPU agents: GPU machines that connect out to NX STUDIO and pull work (no inbound address needed).
CREATE TABLE gpu_agents (
  id           text PRIMARY KEY,               -- from NX_GPU_AGENTS
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  info         jsonb NOT NULL DEFAULT '{}'::jsonb   -- { gpu, version, engines: [...], failed_engines: [...] }
);

-- One remote execution of a generation job on an agent. Inputs and outputs live in the storage
-- under gpu-tasks/<id>/ and are deleted once the worker has collected the result.
CREATE TABLE gpu_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         text NOT NULL,
  job_id           uuid REFERENCES generation_jobs(id) ON DELETE CASCADE,
  engine           text NOT NULL,
  operation        text NOT NULL,
  params           jsonb NOT NULL,
  files            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- field -> storage key
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  stage            text,
  progress         real NOT NULL DEFAULT 0,
  error            text,
  retryable        boolean NOT NULL DEFAULT false,
  outputs          jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ index, key, mime, seed }]
  cancel_requested boolean NOT NULL DEFAULT false,
  heartbeat_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gpu_tasks_queue_idx ON gpu_tasks (agent_id, created_at) WHERE status = 'queued';
