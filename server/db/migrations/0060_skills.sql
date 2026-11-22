CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"handle" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skills_scope_handle_idx" ON "skills" USING btree ("scope","handle");