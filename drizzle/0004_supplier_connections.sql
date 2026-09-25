CREATE TABLE IF NOT EXISTS "supplier_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"product_data_url" text NOT NULL,
	"pricing_url" text NOT NULL,
	"account_id" text NOT NULL,
	"password_sealed" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"price_type" text DEFAULT 'Net' NOT NULL,
	"fob_id" text,
	"product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'never' NOT NULL,
	"status_at" timestamp with time zone,
	"last_sync" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "supplier_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "supplier_product_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_connections" ADD CONSTRAINT "supplier_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_connections_tenant_idx" ON "supplier_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_connections_tenant_name_uq" ON "supplier_connections" USING btree ("tenant_id","name");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_supplier_connection_id_supplier_connections_id_fk" FOREIGN KEY ("supplier_connection_id") REFERENCES "public"."supplier_connections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_supplier_uq" ON "products" USING btree ("tenant_id","supplier_connection_id","supplier_product_id");