CREATE TABLE "agent_identities" (
	"user_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"brand" text NOT NULL,
	CONSTRAINT "agent_identities_user_id_agent_name_pk" PRIMARY KEY("user_id","agent_name")
);
