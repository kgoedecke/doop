CREATE TABLE "instance_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"email_password_signup" boolean DEFAULT true NOT NULL,
	"sso_auto_redirect" boolean DEFAULT false NOT NULL,
	"default_workspace_id" text,
	"updated_at" bigint NOT NULL,
	"updated_by" text
);
