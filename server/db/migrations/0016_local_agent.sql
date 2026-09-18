CREATE TABLE "local_agent_preferences" (
  "user_id" text PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "model" text DEFAULT 'default' NOT NULL
);
