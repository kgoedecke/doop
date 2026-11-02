CREATE TABLE "frame_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"frame_id" text NOT NULL,
	"canvas_id" text NOT NULL,
	"html" text NOT NULL,
	"width" double precision NOT NULL,
	"height" double precision NOT NULL,
	"saved_at" bigint NOT NULL,
	"saved_by" text NOT NULL,
	"saved_by_kind" text
);
--> statement-breakpoint
CREATE INDEX "frame_versions_frame_idx" ON "frame_versions" USING btree ("frame_id");--> statement-breakpoint
CREATE INDEX "frame_versions_canvas_idx" ON "frame_versions" USING btree ("canvas_id");