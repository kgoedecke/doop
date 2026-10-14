CREATE TABLE "live_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"canvas_id" text NOT NULL,
	"token" text NOT NULL,
	"environment" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_payload" text,
	"last_timestamp" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "live_activities_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "live_activity_starters" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"environment" text NOT NULL,
	"origin" text NOT NULL,
	"expires_at" bigint NOT NULL
);
