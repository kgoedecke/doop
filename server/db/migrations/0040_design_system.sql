CREATE TABLE "component_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_systems" (
	"scope" text PRIMARY KEY NOT NULL,
	"global_css" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_components" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"group_id" text NOT NULL,
	"kind" text,
	"description" text DEFAULT '' NOT NULL,
	"html" text NOT NULL,
	"css" text DEFAULT '' NOT NULL,
	"js" text DEFAULT '' NOT NULL,
	"variants" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "component_groups_scope_idx" ON "component_groups" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "library_components_scope_slug_idx" ON "library_components" USING btree ("scope","slug");
