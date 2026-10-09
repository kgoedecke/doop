CREATE TABLE "webhooks" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "url" text NOT NULL,
  "secret" text NOT NULL,
  "events" jsonb NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" bigint NOT NULL,
  "last_status" integer,
  "last_at" bigint,
  "last_error" text,
  "failures" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX "webhooks_user_idx" ON "webhooks" ("user_id");
