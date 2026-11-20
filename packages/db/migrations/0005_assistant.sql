-- Edited by hand: pgvector is not a trusted extension, so provisioning creates
-- it as superuser (bootstrapRoles). This line only confirms it exists; on a
-- database without it, the migration stops here with a permission error.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."assistant_outcome" AS ENUM('replied', 'handed_off', 'declined', 'guard_blocked', 'budget_exhausted', 'rate_limited', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_kind" AS ENUM('faq', 'file', 'catalogue');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_status" AS ENUM('queued', 'reading', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('received', 'preparing', 'ready', 'shipped', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TABLE "assistant_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"trigger_message_id" uuid NOT NULL,
	"reply_message_id" uuid,
	"model" text NOT NULL,
	"outcome" "assistant_outcome" NOT NULL,
	"basis" text,
	"language" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"passages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_turns_trigger_unique" UNIQUE("trigger_message_id")
);
--> statement-breakpoint
CREATE TABLE "assistant_usage_daily" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "assistant_usage_daily_tenant_id_day_pk" PRIMARY KEY("tenant_id","day")
);
--> statement-breakpoint
CREATE TABLE "knowledge_passages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text,
	"text" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedding_model" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(heading, '') || ' ' || text)) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_passages_source_ordinal_unique" UNIQUE("source_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "knowledge_source_kind" NOT NULL,
	"title" text NOT NULL,
	"answer" text,
	"content_type" text,
	"size_bytes" integer,
	"storage_key" text,
	"status" "knowledge_source_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"passage_count" integer DEFAULT 0 NOT NULL,
	"unit_count" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid,
	"order_number" text NOT NULL,
	"status" "order_status" NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total" numeric(12, 2),
	"currency" text,
	"courier" text,
	"tracking_number" text,
	"promised_date" date,
	"placed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_tenant_number_unique" UNIQUE("tenant_id","order_number")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "assistant_summary" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "assistant_daily_token_budget" integer DEFAULT 300000 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "assistant_turns_per_customer_hour" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_reply_message_id_messages_id_fk" FOREIGN KEY ("reply_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_usage_daily" ADD CONSTRAINT "assistant_usage_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_passages" ADD CONSTRAINT "knowledge_passages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_passages" ADD CONSTRAINT "knowledge_passages_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_turns_tenant_created_idx" ON "assistant_turns" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "assistant_turns_customer_created_idx" ON "assistant_turns" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "assistant_turns_reply_idx" ON "assistant_turns" USING btree ("reply_message_id");--> statement-breakpoint
CREATE INDEX "knowledge_passages_tenant_idx" ON "knowledge_passages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "knowledge_passages_search_idx" ON "knowledge_passages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "knowledge_sources_tenant_idx" ON "knowledge_sources" USING btree ("tenant_id","created_at");--> statement-breakpoint
-- Edited by hand: row-level security and grants for the phase 4 tables.
ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE knowledge_sources FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON knowledge_sources
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE knowledge_passages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE knowledge_passages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON knowledge_passages
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE orders FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE assistant_turns ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE assistant_turns FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON assistant_turns
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE assistant_usage_daily ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE assistant_usage_daily FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON assistant_usage_daily
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_sources TO app_user;--> statement-breakpoint
-- Passages are replaced wholesale when a source is re-read, never edited.
GRANT SELECT, INSERT, DELETE ON knowledge_passages TO app_user;--> statement-breakpoint
-- Orders come from the business's own system (seeded for the demo); the app only reads them.
GRANT SELECT ON orders TO app_user;--> statement-breakpoint
-- A turn is a record of what happened: written once, then only linked to its reply.
GRANT SELECT, INSERT ON assistant_turns TO app_user;--> statement-breakpoint
GRANT UPDATE (reply_message_id) ON assistant_turns TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON assistant_usage_daily TO app_user;
