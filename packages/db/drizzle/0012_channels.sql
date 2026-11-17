CREATE TABLE "channel_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"config_enc" text NOT NULL,
	"webhook_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_accounts_webhook_token_unique" UNIQUE("webhook_token"),
	CONSTRAINT "channel_accounts_workspace_name_uniq" UNIQUE("workspace_id","name"),
	CONSTRAINT "channel_accounts_type_check" CHECK ("channel_accounts"."type" in ('twilio_sms', 'twilio_whatsapp', 'retell'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "channel_account_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_accounts_workspace_idx" ON "channel_accounts" USING btree ("workspace_id");