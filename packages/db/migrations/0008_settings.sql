CREATE TYPE "public"."assistant_tone" AS ENUM('warm', 'brief', 'formal');--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "staff_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" "tenant_role" NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD COLUMN "handoff_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "template_language" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "opening_hours" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "assistant_tone" "assistant_tone" DEFAULT 'warm' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "escalation_keywords" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "max_assistant_replies" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "outside_hours_notice" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "reopen_templates" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_resets_tenant_idx" ON "password_resets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "staff_invites_tenant_idx" ON "staff_invites" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conversations_tenant_created_idx" ON "conversations" USING btree ("tenant_id","created_at");--> statement-breakpoint
-- Hand-written: keep each business's reopen template, now per language (P-05).
UPDATE "tenants" t SET "reopen_templates" = jsonb_build_object('en', c."reopen_template_name")
  FROM "channels" c
  WHERE c."tenant_id" = t."id" AND c."reopen_template_name" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "reopen_template_name";--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_max_assistant_replies_range" CHECK ("tenants"."max_assistant_replies" is null or "tenants"."max_assistant_replies" between 1 and 50);--> statement-breakpoint
-- Hand-written below: isolation, grants and the two token lookups.
ALTER TABLE staff_invites ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE staff_invites FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON staff_invites
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON password_resets
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON staff_invites TO app_user;--> statement-breakpoint
GRANT UPDATE (accepted_at) ON staff_invites TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT ON password_resets TO app_user;--> statement-breakpoint
GRANT UPDATE (used_at) ON password_resets TO app_user;--> statement-breakpoint
-- Owners add people (an accepted invite) and remove them; still only in their own tenant.
GRANT INSERT, DELETE ON memberships TO app_user;--> statement-breakpoint

-- Opening an invite or reset link happens signed out, before any tenant is
-- known. Like auth_membership, these answer one question for one token hash
-- and return only what the page needs; the change itself is then made inside
-- that tenant, under row-level security.
CREATE FUNCTION staff_invite_by_token(p_token_hash text)
  RETURNS TABLE (id uuid, tenant_id uuid, name text, email text, role tenant_role,
                 expires_at timestamptz, accepted_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT i.id, i.tenant_id, i.name, i.email, i.role, i.expires_at, i.accepted_at
    FROM staff_invites i WHERE i.token_hash = p_token_hash
  $$;--> statement-breakpoint
CREATE FUNCTION password_reset_by_token(p_token_hash text)
  RETURNS TABLE (id uuid, tenant_id uuid, user_id uuid, expires_at timestamptz, used_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT r.id, r.tenant_id, r.user_id, r.expires_at, r.used_at
    FROM password_resets r WHERE r.token_hash = p_token_hash
  $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION staff_invite_by_token(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION password_reset_by_token(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION staff_invite_by_token(text) TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION password_reset_by_token(text) TO app_user;
