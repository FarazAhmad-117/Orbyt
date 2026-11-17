import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Agency / account owner.
export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

// Sub-account: the data isolation boundary (plan §4.3).
export const workspaces = pgTable("workspaces", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

// First tenant table. Every table with a workspace_id MUST get an RLS policy in a migration
// (enforced by the guard test in tenancy.test.ts).
export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    createdAt: createdAt(),
  },
  (t) => [unique("contacts_workspace_email_uniq").on(t.workspaceId, t.email)],
);
