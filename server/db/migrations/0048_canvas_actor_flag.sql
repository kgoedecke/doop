CREATE TABLE "feature_flags" (
	"flag" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "feature_flags_flag_user_id_pk" PRIMARY KEY("flag","user_id")
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "frame_store" text;