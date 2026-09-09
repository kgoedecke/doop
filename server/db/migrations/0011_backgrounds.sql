CREATE TABLE "backgrounds" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"tone" text NOT NULL,
	"style" text NOT NULL,
	"avg_color" text NOT NULL,
	"palette" jsonb NOT NULL,
	"tags" jsonb NOT NULL,
	"slots" jsonb NOT NULL,
	"text_zone" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
