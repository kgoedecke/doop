ALTER TABLE "comments" ALTER COLUMN "frame_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "page_id" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "x" double precision;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "y" double precision;