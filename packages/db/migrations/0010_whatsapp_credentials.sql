ALTER TABLE "channels" ADD COLUMN "waba_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "access_token_sealed" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Hand-written: owners connect their own WhatsApp number (P-04), still only
-- inside their own tenant (the channels policy). The token column is sealed.
GRANT INSERT ON channels TO app_user;--> statement-breakpoint
GRANT UPDATE (display_phone_number, waba_id, access_token_sealed, updated_at) ON channels TO app_user;
