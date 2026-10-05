CREATE TABLE "linear_installations" (
  "organization_id" text PRIMARY KEY,
  "user_id" text NOT NULL UNIQUE,
  "app_user_id" text NOT NULL,
  "name" text NOT NULL,
  "access_token" text NOT NULL,
  "refresh_token" text NOT NULL,
  "expires_at" bigint NOT NULL,
  "connected_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_oauth_states" (
  "hash" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "verifier" text NOT NULL,
  "expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_sessions" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL,
  "user_id" text NOT NULL,
  "issue_id" text,
  "title" text NOT NULL,
  "prompt" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "canvas_id" text,
  "task_id" text,
  "error" text,
  "ack_id" text NOT NULL,
  "result_id" text NOT NULL,
  "next_attempt_at" bigint NOT NULL DEFAULT 0,
  "linked" boolean NOT NULL DEFAULT false,
  "acknowledged" boolean NOT NULL DEFAULT false,
  "reported" boolean NOT NULL DEFAULT false,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "linear_sessions_status_idx" ON "linear_sessions" ("status");
