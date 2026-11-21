CREATE TABLE "agent_overrides" (
	"scope" text NOT NULL,
	"role_id" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"color" text,
	"blurb" text,
	"brief" text,
	"reviewer" boolean,
	"updated_by" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "agent_overrides_scope_role_id_pk" PRIMARY KEY("scope","role_id")
);
--> statement-breakpoint
CREATE TABLE "custom_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"blurb" text NOT NULL,
	"brief" text NOT NULL,
	"reviewer" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "claimed_by_resident" boolean;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_agents_scope_handle_idx" ON "custom_agents" USING btree ("scope","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_agents_scope_name_idx" ON "custom_agents" USING btree ("scope","name");