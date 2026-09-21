ALTER TABLE "local_agent_preferences" ADD COLUMN "remote_auth_attempt" text;--> statement-breakpoint
ALTER TABLE "local_agent_preferences" ADD COLUMN "remote_auth_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "local_agent_preferences" ADD COLUMN "remote_auth_generation" integer DEFAULT 0 NOT NULL;