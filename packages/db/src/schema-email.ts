import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./columns.js";
import { contacts } from "./schema-crm.js";
import { workspaces } from "./schema.js";

// Workspace data: RLS is applied in the migration (app_enable_workspace_rls).
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
type Json = Record<string, unknown>;

// A connected sending/receiving mailbox (SMTP + IMAP). Passwords are stored ONLY encrypted
// (AES-256-GCM, see apps/api/src/secrets.ts) in credentials_enc and never returned by the API.
export const mailboxes = pgTable(
  "mailboxes",
  {
    id: pk(),
    workspaceId: workspaceId(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    smtpSecure: boolean("smtp_secure").notNull().default(false),
    smtpUser: text("smtp_user").notNull(),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull(),
    imapSecure: boolean("imap_secure").notNull().default(false),
    imapUser: text("imap_user").notNull(),
    // "password": credentialsEnc holds {smtpPass, imapPass}. "google"/"microsoft": it holds the
    // OAuth tokens {refreshToken, accessToken, expiresAt} and logins use XOAUTH2.
    authType: text("auth_type").notNull().default("password"),
    credentialsEnc: text("credentials_enc").notNull(),
    // Warm-up ramps the effective daily limit up from a few emails to dailyLimit (see email/warmup.ts).
    warmupEnabled: boolean("warmup_enabled").notNull().default(false),
    warmupStartedAt: timestamp("warmup_started_at", { withTimezone: true }),
    dailyLimit: integer("daily_limit").notNull().default(30),
    hourlyLimit: integer("hourly_limit").notNull().default(10),
    status: text("status").notNull().default("active"),
    lastError: text("last_error"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    imapUidValidity: bigint("imap_uid_validity", { mode: "number" }),
    imapLastUid: bigint("imap_last_uid", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("mailboxes_workspace_email_uniq").on(t.workspaceId, t.email),
    check(
      "mailboxes_status_check",
      sql`${t.status} in ('active', 'paused', 'error')`,
    ),
    check(
      "mailboxes_auth_type_check",
      sql`${t.authType} in ('password', 'google', 'microsoft')`,
    ),
  ],
);

export const sequences = pgTable(
  "sequences",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    status: text("status").notNull().default("draft"),
    // Mailboxes to rotate through. Stored as ids (no FK on array elements); checked on write.
    mailboxIds: uuid("mailbox_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    timezone: text("timezone").notNull().default("UTC"),
    windowStartHour: integer("window_start_hour").notNull().default(9),
    windowEndHour: integer("window_end_hour").notNull().default(17),
    // ISO weekdays: 1 = Monday ... 7 = Sunday.
    sendDays: integer("send_days")
      .array()
      .notNull()
      .default(sql`'{1,2,3,4,5}'::int[]`),
    stopOnReply: boolean("stop_on_reply").notNull().default(true),
    // Off by default: tracking pixels hurt deliverability (plan §4.6, open question 4).
    trackOpens: boolean("track_opens").notNull().default(false),
    trackClicks: boolean("track_clicks").notNull().default(false),
    // Appended to every email: sender's postal address / unsubscribe wording (CAN-SPAM).
    footer: text("footer"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "sequences_status_check",
      sql`${t.status} in ('draft', 'active', 'paused')`,
    ),
    check(
      "sequences_window_check",
      sql`${t.windowStartHour} between 0 and 23 and ${t.windowEndHour} between 1 and 24 and ${t.windowStartHour} < ${t.windowEndHour}`,
    ),
  ],
);

export const sequenceSteps = pgTable(
  "sequence_steps",
  {
    id: pk(),
    workspaceId: workspaceId(),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    // Hours to wait after the previous step (or after enrolment, for the first step).
    delayHours: integer("delay_hours").notNull().default(0),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
  },
  (t) => [unique("sequence_steps_position_uniq").on(t.sequenceId, t.position)],
);

export const enrollments = pgTable(
  "enrollments",
  {
    id: pk(),
    workspaceId: workspaceId(),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    // Index (position) of the NEXT step to send.
    currentStep: integer("current_step").notNull().default(0),
    nextSendAt: timestamp("next_send_at", { withTimezone: true }),
    // Sticky once the first email goes out, so the whole thread comes from one mailbox.
    mailboxId: uuid("mailbox_id").references(() => mailboxes.id, {
      onDelete: "set null",
    }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("enrollments_sequence_contact_uniq").on(t.sequenceId, t.contactId),
    index("enrollments_due_idx").on(t.workspaceId, t.status, t.nextSendAt),
    check(
      "enrollments_status_check",
      sql`${t.status} in ('active', 'completed', 'replied', 'bounced', 'unsubscribed', 'paused', 'error')`,
    ),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: pk(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    mailboxId: uuid("mailbox_id").references(() => mailboxes.id, {
      onDelete: "set null",
    }),
    enrollmentId: uuid("enrollment_id").references(() => enrollments.id, {
      onDelete: "set null",
    }),
    subject: text("subject").notNull(),
    status: text("status").notNull().default("open"),
    hasUnread: boolean("has_unread").notNull().default(false),
    // Set by the AI "classify reply" feature (interested, not_interested, question, ...).
    aiLabel: text("ai_label"),
    aiSummary: text("ai_summary"),
    // The unified inbox is channel-agnostic: email uses mailbox_id, SMS/WhatsApp/voice use
    // channel_account_id (see schema-channels.ts; no FK here to keep the schema files acyclic).
    channel: text("channel").notNull().default("email"),
    channelAccountId: uuid("channel_account_id"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("conversations_inbox_idx").on(t.workspaceId, t.lastMessageAt),
    check("conversations_status_check", sql`${t.status} in ('open', 'closed')`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: pk(),
    workspaceId: workspaceId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    // "email" | "sms" | "whatsapp" | "voice". For non-email channels the *_email columns below hold
    // the phone numbers (kept for compatibility) and message_id is the provider's id (e.g. Twilio SID).
    channel: text("channel").notNull().default("email"),
    mailboxId: uuid("mailbox_id").references(() => mailboxes.id, {
      onDelete: "set null",
    }),
    // RFC 5322 Message-ID (without angle brackets) — used for threading and de-duplication.
    messageId: text("message_id").notNull(),
    inReplyTo: text("in_reply_to"),
    fromEmail: text("from_email").notNull(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    enrollmentId: uuid("enrollment_id").references(() => enrollments.id, {
      onDelete: "set null",
    }),
    stepId: uuid("step_id").references(() => sequenceSteps.id, {
      onDelete: "set null",
    }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("messages_dedupe_uniq").on(
      t.workspaceId,
      t.mailboxId,
      t.direction,
      t.messageId,
    ),
    index("messages_conversation_idx").on(t.conversationId, t.at),
    index("messages_message_id_idx").on(t.workspaceId, t.messageId),
  ],
);

export const emailEvents = pgTable(
  "email_events",
  {
    id: pk(),
    workspaceId: workspaceId(),
    type: text("type").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    enrollmentId: uuid("enrollment_id").references(() => enrollments.id, {
      onDelete: "cascade",
    }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    data: jsonb("data").$type<Json>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("email_events_type_idx").on(t.workspaceId, t.type, t.createdAt),
    index("email_events_enrollment_idx").on(t.enrollmentId),
    check(
      "email_events_type_check",
      sql`${t.type} in ('sent', 'failed', 'open', 'click', 'reply', 'auto_reply', 'bounce_hard', 'bounce_soft', 'unsubscribe', 'complaint')`,
    ),
  ],
);

// Addresses we must never email again (workspace-wide).
export const suppressions = pgTable(
  "suppressions",
  {
    id: pk(),
    workspaceId: workspaceId(),
    email: text("email").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("suppressions_workspace_email_uniq").on(t.workspaceId, t.email),
    check(
      "suppressions_reason_check",
      sql`${t.reason} in ('unsubscribe', 'hard_bounce', 'complaint', 'manual')`,
    ),
  ],
);
