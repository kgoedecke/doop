CREATE TABLE "agent_defaults" (
	"user_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_accounts" DROP CONSTRAINT "model_accounts_pkey";--> statement-breakpoint
ALTER TABLE "model_accounts" ADD CONSTRAINT "model_accounts_user_id_kind_pk" PRIMARY KEY("user_id","kind");--> statement-breakpoint
ALTER TABLE "model_accounts" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;
