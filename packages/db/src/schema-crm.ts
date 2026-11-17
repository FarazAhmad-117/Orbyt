import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./columns.js";
import { users, workspaces } from "./schema.js";

// Every table here is workspace data: it needs RLS in a migration (see app_enable_workspace_rls).
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
const userRef = (name: string) =>
  uuid(name).references(() => users.id, { onDelete: "set null" });
type Json = Record<string, unknown>;

export const companies = pgTable(
  "companies",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    domain: text("domain"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("companies_workspace_idx").on(t.workspaceId, t.id)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: pk(),
    workspaceId: workspaceId(),
    email: text("email").notNull(),
    name: text("name"),
    phone: text("phone"),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    ownerId: userRef("owner_id"),
    source: text("source"),
    customFields: jsonb("custom_fields").$type<Json>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("contacts_workspace_email_uniq").on(t.workspaceId, t.email),
    index("contacts_workspace_idx").on(t.workspaceId, t.id),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: createdAt(),
  },
  (t) => [unique("tags_workspace_name_uniq").on(t.workspaceId, t.name)],
);

export const contactTags = pgTable(
  "contact_tags",
  {
    workspaceId: workspaceId(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.tagId] }),
    index("contact_tags_tag_idx").on(t.tagId),
  ],
);

// Definitions for values stored in contacts.custom_fields (jsonb, keyed by `key`).
export const customFieldDefs = pgTable(
  "custom_field_defs",
  {
    id: pk(),
    workspaceId: workspaceId(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: text("type").notNull(),
    options: jsonb("options").$type<string[]>(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("custom_field_defs_workspace_key_uniq").on(t.workspaceId, t.key),
    check(
      "custom_field_defs_type_check",
      sql`${t.type} in ('text', 'number', 'date', 'boolean', 'select')`,
    ),
  ],
);

export const pipelines = pgTable("pipelines", {
  id: pk(),
  workspaceId: workspaceId(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: pk(),
    workspaceId: workspaceId(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [index("pipeline_stages_pipeline_idx").on(t.pipelineId, t.position)],
);

export const deals = pgTable(
  "deals",
  {
    id: pk(),
    workspaceId: workspaceId(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => pipelineStages.id),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    valueCents: bigint("value_cents", { mode: "number" }).notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    status: text("status").notNull().default("open"),
    ownerId: userRef("owner_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("deals_stage_idx").on(t.stageId),
    check("deals_status_check", sql`${t.status} in ('open', 'won', 'lost')`),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: pk(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    assigneeId: userRef("assignee_id"),
    createdAt: createdAt(),
  },
  (t) => [index("tasks_workspace_idx").on(t.workspaceId, t.id)],
);

export const notes = pgTable(
  "notes",
  {
    id: pk(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "cascade" }),
    authorId: userRef("author_id"),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("notes_workspace_idx").on(t.workspaceId, t.id)],
);

// Timeline entries (contact.created, deal.moved, email.sent, ...). Also feeds workflows/webhooks.
export const activities = pgTable(
  "activities",
  {
    id: pk(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: jsonb("data").$type<Json>().notNull().default({}),
    actorId: userRef("actor_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("activities_contact_idx").on(t.contactId, t.id),
    index("activities_workspace_idx").on(t.workspaceId, t.id),
  ],
);

// API keys are verified by hash BEFORE a workspace is known, so this table is RLS-ENABLED but not
// FORCEd (the owner connection looks the hash up). Only the sha256 hash is stored.
export const apiKeys = pgTable(
  "api_keys",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    createdBy: userRef("created_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_workspace_idx").on(t.workspaceId)],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: pk(),
    workspaceId: workspaceId(),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: text("events").array().notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("webhooks_workspace_idx").on(t.workspaceId)],
);
