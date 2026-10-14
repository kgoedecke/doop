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
