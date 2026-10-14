CREATE TABLE "chat_messages" (
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
CREATE INDEX "chat_messages_canvas_idx" ON "chat_messages" USING btree ("canvas_id");