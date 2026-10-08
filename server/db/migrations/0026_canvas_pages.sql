ALTER TABLE "canvases" ADD COLUMN "pages" jsonb;
--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "page_id" text;
