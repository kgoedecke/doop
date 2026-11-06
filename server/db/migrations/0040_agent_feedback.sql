CREATE TABLE "agent_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"tool" text,
	"agent_name" text,
	"client" text,
	"canvas_id" text,
	"user_id" text
);
--> statement-breakpoint
CREATE INDEX "agent_feedback_at_idx" ON "agent_feedback" USING btree ("at");