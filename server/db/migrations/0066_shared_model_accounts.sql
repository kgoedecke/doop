CREATE TABLE IF NOT EXISTS "shared_model_account_prefs" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"model" text,
	"reasoning_effort" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "shared_model_account_prefs_user_id_kind_pk" PRIMARY KEY("user_id","kind")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shared_model_accounts" (
	"kind" text PRIMARY KEY NOT NULL,
	"custom" jsonb NOT NULL,
	"api_key" text,
	"custom_headers" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_model_account_prefs_kind_idx" ON "shared_model_account_prefs" USING btree ("kind");