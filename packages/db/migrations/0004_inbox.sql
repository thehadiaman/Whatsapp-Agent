CREATE TABLE "conversation_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Edited by hand: existing conversations get numbers in creation order per
-- tenant before the column becomes NOT NULL.
ALTER TABLE "conversations" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "next_conversation_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "conversations" c SET "number" = n.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn FROM "conversations") n
  WHERE c.id = n.id;--> statement-breakpoint
UPDATE "tenants" t SET "next_conversation_number" = coalesce(
  (SELECT max("number") + 1 FROM "conversations" c WHERE c.tenant_id = t.id), 1);--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_notes_conversation_idx" ON "conversation_notes" USING btree ("conversation_id","created_at");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_number_unique" UNIQUE("tenant_id","number");--> statement-breakpoint
ALTER TABLE conversation_notes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE conversation_notes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation_notes
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
-- Notes are append-only for the application, like the audit log.
GRANT SELECT, INSERT ON conversation_notes TO app_user;
