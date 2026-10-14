CREATE TABLE "notification_prefs" (
  "user_id" text PRIMARY KEY,
  "comment_emails" boolean NOT NULL DEFAULT true,
  "updated_at" bigint NOT NULL
);
