CREATE TABLE "agent_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"start" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint
);
--> statement-breakpoint
CREATE INDEX "agent_keys_user_idx" ON "agent_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_keys_hash_idx" ON "agent_keys" USING btree ("secret_hash");