-- IF NOT EXISTS: this table first shipped as 0016_local_agent on the same day
-- 0016_task_frames landed; installs that applied the old number already have it.
CREATE TABLE IF NOT EXISTS "local_agent_preferences" (
  "user_id" text PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "model" text DEFAULT 'default' NOT NULL
);
