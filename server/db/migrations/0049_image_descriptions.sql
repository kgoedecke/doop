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
ALTER TABLE "assets" ADD COLUMN "describe_payer_id" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "describe_provider" text;
--> statement-breakpoint
-- Do not bill people for images uploaded before descriptions shipped.
UPDATE "assets" SET "describe_attempts" = 3;
