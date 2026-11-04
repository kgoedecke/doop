CREATE TABLE "custom_model_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text,
	"model" text NOT NULL,
	"supports_vision" boolean DEFAULT true NOT NULL,
	"connected_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_accounts" ADD COLUMN "profile_id" text;--> statement-breakpoint
CREATE INDEX "custom_model_profiles_user_idx" ON "custom_model_profiles" USING btree ("user_id");