ALTER TABLE "components" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "deleted_by" text;