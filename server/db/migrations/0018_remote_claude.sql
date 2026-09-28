ALTER TABLE "local_agent_preferences" ADD COLUMN IF NOT EXISTS "transport" text NOT NULL DEFAULT 'local';
