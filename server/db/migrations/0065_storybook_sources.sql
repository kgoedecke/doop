CREATE TABLE "storybook_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"url" text NOT NULL,
	"components" jsonb NOT NULL,
	"tokens" jsonb NOT NULL,
	"last_result" jsonb,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"synced_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "storybook_sources_canvas_url_idx" ON "storybook_sources" USING btree ("canvas_id","url");