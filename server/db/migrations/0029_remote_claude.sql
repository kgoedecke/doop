-- Preserve Claude preferences already created by the earlier branch migrations.
ALTER TABLE "local_agent_preferences" ADD COLUMN IF NOT EXISTS "remote_auth_attempt" text;--> statement-breakpoint
ALTER TABLE "local_agent_preferences" ADD COLUMN IF NOT EXISTS "remote_auth_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "local_agent_preferences" ADD COLUMN IF NOT EXISTS "remote_auth_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "local_agent_preferences" ADD COLUMN IF NOT EXISTS "transport" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
-- Earlier Claude journals had timestamps after 0018_chat, so ensure its table exists.
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"from_name" text NOT NULL,
	"from_kind" text NOT NULL,
	"from_user_id" text,
	"color" text NOT NULL,
	"text" text NOT NULL,
	"at" bigint NOT NULL,
	"mentions" text,
	"task_id" text,
	"reply_to_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_canvas_idx" ON "chat_messages" USING btree ("canvas_id");

--> statement-breakpoint
-- Existing hosted Claude databases may have advanced past the Slack migration.
CREATE TABLE IF NOT EXISTS "slack_installations" (
	"team_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"name" text NOT NULL,
	"bot_token" text NOT NULL,
	"connected_at" bigint NOT NULL,
	CONSTRAINT "slack_installations_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slack_oauth_states" (
	"hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slack_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text,
	"requester_id" text NOT NULL,
	"response_url" text,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"canvas_id" text,
	"task_id" text,
	"follow_up" boolean DEFAULT false NOT NULL,
	"error" text,
	"ack_ts" text,
	"next_attempt_at" bigint DEFAULT 0 NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"linked" boolean DEFAULT false NOT NULL,
	"reported" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slack_sessions_status_idx" ON "slack_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slack_sessions_thread_idx" ON "slack_sessions" USING btree ("team_id","channel_id","thread_ts");
