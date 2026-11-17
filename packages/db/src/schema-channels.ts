import { sql } from "drizzle-orm";
import { check, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk } from "./columns.js";
import { workspaces } from "./schema.js";

// A connected non-email channel (SMS, WhatsApp, voice). Credentials are stored ONLY encrypted
// (AES-256-GCM) in config_enc and never returned by the API. `webhook_token` is the unguessable
// path segment of the inbound webhook URL; it is looked up BEFORE a workspace is known, so this
// table is RLS-enabled but not FORCEd (like api_keys).
export const channelAccounts = pgTable(
  "channel_accounts",
  {
    id: pk(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    name: text("name").notNull(),
    // Our number for this account (E.164, or "whatsapp:+..." for WhatsApp).
    address: text("address").notNull(),
    configEnc: text("config_enc").notNull(),
    webhookToken: text("webhook_token").notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("channel_accounts_workspace_name_uniq").on(t.workspaceId, t.name),
    index("channel_accounts_workspace_idx").on(t.workspaceId),
    check(
      "channel_accounts_type_check",
      sql`${t.type} in ('twilio_sms', 'twilio_whatsapp', 'retell')`,
    ),
  ],
);
