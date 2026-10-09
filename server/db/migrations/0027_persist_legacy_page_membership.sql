UPDATE "canvases" SET "pages" = jsonb_build_array(jsonb_build_object('id', "id" || ':page1', 'name', 'Page 1')) WHERE "pages" IS NULL;
--> statement-breakpoint
UPDATE "frames" AS f SET "page_id" = c."pages"->0->>'id' FROM "canvases" AS c WHERE f."canvas_id" = c."id" AND f."page_id" IS NULL;
