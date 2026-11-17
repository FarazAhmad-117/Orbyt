import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./columns.js";
import { contacts } from "./schema-crm.js";
import { organizations, users, workspaces } from "./schema.js";

// Workspace data: RLS is applied in the migration (app_enable_workspace_rls).
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
type Json = Record<string, unknown>;

// Pending invitations to a workspace. Only the SHA-256 of the token is stored, so a database
// leak does not hand out working invite links. Looked up by that hash before the workspace is
// known (accept flow), so RLS is enabled but not forced (like api_keys).
export const invitations = pgTable(
  "invitations",
  {
    id: pk(),
    workspaceId: workspaceId(),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("invitations_workspace_idx").on(t.workspaceId),
    check("invitations_role_check", sql`${t.role} in ('admin', 'member')`),
  ],
);

export interface FormField {
  name: string; // key in the submitted JSON
  label: string;
  type: "text" | "email" | "tel" | "textarea";
  required: boolean;
}

// Public lead-capture forms: POST /api/forms/:workspaceId/:publicToken creates/updates a contact.
export const forms = pgTable(
  "forms",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    publicToken: text("public_token").notNull().unique(),
    fields: jsonb("fields").$type<FormField[]>().notNull(),
    // Tags added to the contact on every submission.
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    successMessage: text("success_message")
      .notNull()
      .default("Thanks! We will be in touch."),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("forms_workspace_idx").on(t.workspaceId),
    check("forms_status_check", sql`${t.status} in ('active', 'paused')`),
  ],
);

export const formSubmissions = pgTable(
  "form_submissions",
  {
    id: pk(),
    workspaceId: workspaceId(),
    formId: uuid("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    data: jsonb("data").$type<Json>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("form_submissions_form_idx").on(t.formId, t.createdAt)],
);

// Knowledge base for the AI features. A generated tsvector column (`search`) is added in the
// migration for full-text retrieval; it is not modelled here because queries use raw SQL.
export const kbDocuments = pgTable(
  "kb_documents",
  {
    id: pk(),
    workspaceId: workspaceId(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("kb_documents_workspace_idx").on(t.workspaceId)],
);

// Chat agents answer visitors from the knowledge base through a public endpoint.
export const chatAgents = pgTable(
  "chat_agents",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    systemPrompt: text("system_prompt").notNull().default(""),
    welcome: text("welcome").notNull().default("Hi! How can I help?"),
    publicToken: text("public_token").notNull().unique(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("chat_agents_workspace_idx").on(t.workspaceId),
    check("chat_agents_status_check", sql`${t.status} in ('active', 'paused')`),
  ],
);

// Who did what (ee: audit logs). Written for sensitive actions; append-only by convention.
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: pk(),
    workspaceId: workspaceId(),
    actorId: uuid("actor_id"), // no FK: the log outlives the user
    actorVia: text("actor_via").notNull(),
    action: text("action").notNull(), // e.g. "api_key.created"
    targetType: text("target_type"),
    targetId: text("target_id"),
    data: jsonb("data").$type<Json>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_workspace_idx").on(t.workspaceId, t.createdAt)],
);

// Billing state per organization (agency). Written by the Stripe webhook (system connection);
// members of the organization can read it.
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: pk(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    plan: text("plan").notNull().default("free"),
    status: text("status").notNull().default("active"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("subscriptions_org_uniq").on(t.organizationId),
    index("subscriptions_customer_idx").on(t.stripeCustomerId),
  ],
);
