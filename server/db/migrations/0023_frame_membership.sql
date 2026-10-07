CREATE TABLE "canvas_frame_state" (
  "canvas_id" text PRIMARY KEY,
  "revision" bigint NOT NULL DEFAULT 0,
  "deleted" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "frame_memberships" (
  "id" text PRIMARY KEY,
  "canvas_id" text NOT NULL,
  "position" bigint NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('creating', 'active', 'deleting', 'deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "frame_memberships_position_idx" ON "frame_memberships" ("canvas_id", "position");
--> statement-breakpoint
CREATE INDEX "frame_memberships_status_idx" ON "frame_memberships" ("canvas_id", "status");
