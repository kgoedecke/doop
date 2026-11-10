DROP INDEX "fonts_workspace_idx";--> statement-breakpoint
DROP INDEX "fonts_owner_idx";--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "canvas_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_refs" ADD COLUMN "canvas_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "fonts" ADD COLUMN "canvas_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_parent_idx" ON "assets" USING btree ("id","canvas_id");--> statement-breakpoint
CREATE UNIQUE INDEX "frames_parent_idx" ON "frames" USING btree ("id","canvas_id");--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_refs" ADD CONSTRAINT "asset_refs_asset_id_canvas_id_assets_id_canvas_id_fk" FOREIGN KEY ("asset_id","canvas_id") REFERENCES "public"."assets"("id","canvas_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_refs" ADD CONSTRAINT "asset_refs_frame_id_canvas_id_frames_id_canvas_id_fk" FOREIGN KEY ("frame_id","canvas_id") REFERENCES "public"."frames"("id","canvas_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_members" ADD CONSTRAINT "canvas_members_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_tokens" ADD CONSTRAINT "design_tokens_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fonts" ADD CONSTRAINT "fonts_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fonts" ADD CONSTRAINT "fonts_asset_id_canvas_id_assets_id_canvas_id_fk" FOREIGN KEY ("asset_id","canvas_id") REFERENCES "public"."assets"("id","canvas_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frame_versions" ADD CONSTRAINT "frame_versions_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frames" ADD CONSTRAINT "frames_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guideline_versions" ADD CONSTRAINT "guideline_versions_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidelines" ADD CONSTRAINT "guidelines_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_activities" ADD CONSTRAINT "live_activities_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_references" ADD CONSTRAINT "memory_references_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_keys" ADD CONSTRAINT "sync_keys_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fonts_canvas_idx" ON "fonts" USING btree ("canvas_id");--> statement-breakpoint
ALTER TABLE "fonts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "fonts" DROP COLUMN "owner_id";
