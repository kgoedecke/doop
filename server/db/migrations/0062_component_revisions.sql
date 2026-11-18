CREATE TABLE IF NOT EXISTS "component_revisions" (
	"canvas_id" text NOT NULL,
	"component_id" text NOT NULL,
	"rev" integer NOT NULL,
	"template" text NOT NULL,
	"raw_css" text NOT NULL,
	"head" jsonb NOT NULL,
	"props" jsonb NOT NULL,
	"saved_at" bigint NOT NULL,
	"saved_by" text NOT NULL,
	CONSTRAINT "component_revisions_canvas_id_component_id_rev_pk" PRIMARY KEY("canvas_id","component_id","rev")
);
--> statement-breakpoint
ALTER TABLE "components" ALTER COLUMN "history" SET DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- Backfill: every revision the rows carried inline becomes a row of its own. The inline
-- column is left as it is (the previous release still reads it); a later migration drops it.
-- Safe to run again: a revision already there is left alone.
INSERT INTO "component_revisions" ("canvas_id", "component_id", "rev", "template", "raw_css", "head", "props", "saved_at", "saved_by")
SELECT
	c."canvas_id",
	c."id",
	(entry->>'rev')::numeric::integer,
	coalesce(entry->>'template', ''),
	coalesce(entry->>'rawCss', ''),
	CASE WHEN jsonb_typeof(entry->'head') = 'array' THEN entry->'head' ELSE '[]'::jsonb END,
	CASE WHEN jsonb_typeof(entry->'props') = 'array' THEN entry->'props' ELSE '[]'::jsonb END,
	coalesce((entry->>'savedAt')::numeric::bigint, c."updated_at"),
	coalesce(entry->>'savedBy', '')
FROM "components" c
CROSS JOIN LATERAL jsonb_array_elements(
	CASE WHEN jsonb_typeof(c."history") = 'array' THEN c."history" ELSE '[]'::jsonb END
) AS entry
WHERE jsonb_typeof(entry->'rev') = 'number'
ON CONFLICT DO NOTHING;
