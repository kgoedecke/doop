CREATE TABLE "library_components" (
	"canvas_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"template" text NOT NULL,
	"css" text NOT NULL,
	"raw_css" text NOT NULL,
	"head" jsonb NOT NULL,
	"props" jsonb NOT NULL,
	"slots" jsonb NOT NULL,
	"code" jsonb,
	"rev" integer NOT NULL,
	"published_at" bigint NOT NULL,
	"published_by" text NOT NULL,
	CONSTRAINT "library_components_canvas_id_id_pk" PRIMARY KEY("canvas_id","id")
);
