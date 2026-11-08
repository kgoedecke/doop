CREATE TABLE "design_tokens" (
	"canvas_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"themes" jsonb,
	"description" text,
	"order" double precision NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "design_tokens_canvas_id_name_pk" PRIMARY KEY("canvas_id","name")
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "token_themes" jsonb;