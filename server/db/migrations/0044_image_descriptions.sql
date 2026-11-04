CREATE TABLE "image_description_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'account' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "described_at" bigint;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "described_by" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "describe_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Images stored before descriptions existed are not described on the first boot after this
-- migration (that would bill every owner for their history at once): they are marked as out of
-- attempts, the value a described-later backfill can reset.
UPDATE "assets" SET "describe_attempts" = 3;
