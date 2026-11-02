ALTER TABLE "comments" ALTER COLUMN "selector" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "element_id" text;