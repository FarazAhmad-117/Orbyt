import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./columns.js";
import { workspaces } from "./schema.js";

// Workspace data: RLS is applied in the migration (app_enable_workspace_rls).
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// Bring-your-own-key LLM connections. The key is stored only encrypted (AES-256-GCM) and never
// returned by the API.
export const aiProviders = pgTable(
  "ai_providers",
  {
    id: pk(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // Custom endpoint (self-hosted Ollama, a proxy, an OpenAI-compatible server). Null = vendor default.
    baseUrl: text("base_url"),
    apiKeyEnc: text("api_key_enc"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("ai_providers_workspace_name_uniq").on(t.workspaceId, t.name),
    check(
      "ai_providers_provider_check",
      sql`${t.provider} in ('anthropic', 'openai', 'gemini', 'ollama')`,
    ),
  ],
);

// Usage ledger: one row per model call, so spend can be capped and (on the cloud) billed.
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: pk(),
    workspaceId: workspaceId(),
    providerId: uuid("provider_id").references(() => aiProviders.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    // "byok" = the customer's own key (no charge); "managed" = platform key, billed by credits.
    source: text("source").notNull().default("byok"),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const aiSettings = pgTable("ai_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  // Calendar-month cap on input+output tokens across all providers. Null = no cap.
  monthlyTokenCap: integer("monthly_token_cap"),
  updatedAt: updatedAt(),
});

// Per-workspace override of a built-in system prompt (keyed by prompt name).
export const aiPrompts = pgTable(
  "ai_prompts",
  {
    id: pk(),
    workspaceId: workspaceId(),
    key: text("key").notNull(),
    template: text("template").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("ai_prompts_workspace_key_uniq").on(t.workspaceId, t.key)],
);
