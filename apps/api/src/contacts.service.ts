import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  asc,
  companies,
  contacts,
  contactTags,
  customFieldDefs,
  desc,
  eq,
  ilike,
  inArray,
  lt,
  or,
  sql,
  tags,
  type Tx,
} from "@orbyt/db";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { z } from "zod";
import {
  type FieldValues,
  mergeCustomFields,
  validateCustomFields,
} from "./custom-fields";
import { DbService } from "./db.service";
import { EventsService } from "./events.service";
import { idParam, parse } from "./http";
import type { Scope } from "./scope";

const fieldValue = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.null(),
]);
const email = z.string().trim().toLowerCase().pipe(z.email().max(320));

export const contactInput = z.object({
  email,
  name: z.string().trim().min(1).max(200).nullish(),
  phone: z.string().trim().max(50).nullish(),
  companyId: z.uuid().nullish(),
  source: z.string().trim().max(100).nullish(),
  customFields: z.record(z.string().max(64), fieldValue).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
});
const contactPatch = contactInput.partial();
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(50).optional(),
  companyId: z.uuid().optional(),
});

const MAX_IMPORT_ROWS = 10_000;
const BASE_COLUMNS = ["email", "name", "phone", "source", "company", "tags"];

type ContactRow = typeof contacts.$inferSelect;

/** FK constraints ignore tenancy, so references must be checked under RLS (same workspace). */
export async function assertCompanyInWorkspace(tx: Tx, id: string) {
  const rows = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, id));
  if (rows.length === 0) throw new BadRequestException("Unknown companyId");
}

@Injectable()
export class ContactsService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private async withTags(tx: Tx, rows: ContactRow[]) {
    const ids = rows.map((r) => r.id);
    const tagRows = ids.length
      ? await tx
          .select({
            contactId: contactTags.contactId,
            id: tags.id,
            name: tags.name,
            color: tags.color,
          })
          .from(contactTags)
          .innerJoin(tags, eq(tags.id, contactTags.tagId))
          .where(inArray(contactTags.contactId, ids))
      : [];
    return rows.map((row) => ({
      ...row,
      tags: tagRows
        .filter((t) => t.contactId === row.id)
        .map(({ id, name, color }) => ({ id, name, color })),
    }));
  }

  private async ensureTags(tx: Tx, scope: Scope, names: string[]) {
    const unique = [...new Set(names)];
    if (unique.length === 0) return [];
    await tx
      .insert(tags)
      .values(unique.map((name) => ({ workspaceId: scope.workspaceId, name })))
      .onConflictDoNothing();
    return tx.select().from(tags).where(inArray(tags.name, unique));
  }

  private async replaceTags(
    tx: Tx,
    scope: Scope,
    contactId: string,
    names: string[],
  ) {
    await tx.delete(contactTags).where(eq(contactTags.contactId, contactId));
    const rows = await this.ensureTags(tx, scope, names);
    if (rows.length)
      await tx.insert(contactTags).values(
        rows.map((t) => ({
          workspaceId: scope.workspaceId,
          contactId,
          tagId: t.id,
        })),
      );
  }

  list(scope: Scope, rawQuery: unknown) {
    const q = parse(listQuery, rawQuery);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const conds = [];
      if (q.cursor) conds.push(lt(contacts.id, q.cursor));
      if (q.companyId) conds.push(eq(contacts.companyId, q.companyId));
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, "\\$&")}%`;
        conds.push(
          or(ilike(contacts.email, like), ilike(contacts.name, like))!,
        );
      }
      if (q.tag)
        conds.push(
          inArray(
            contacts.id,
            tx
              .select({ id: contactTags.contactId })
              .from(contactTags)
              .innerJoin(tags, eq(tags.id, contactTags.tagId))
              .where(eq(tags.name, q.tag)),
          ),
        );
      const rows = await tx
        .select()
        .from(contacts)
        .where(and(...conds))
        .orderBy(desc(contacts.id)) // uuidv7 ids are time-ordered: newest first
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return {
        items: await this.withTags(tx, page),
        nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
      };
    });
  }

  async get(scope: Scope, rawId: string) {
    const id = idParam(rawId);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx.select().from(contacts).where(eq(contacts.id, id));
      if (rows.length === 0) throw new NotFoundException("Contact not found");
      return (await this.withTags(tx, rows))[0]!;
    });
  }

  async create(scope: Scope, body: unknown) {
    const input = parse(contactInput, body);
    const created = await this.dbs.inWorkspace(scope, async (tx) => {
      if (input.customFields)
        await validateCustomFields(tx, input.customFields);
      if (input.companyId) await assertCompanyInWorkspace(tx, input.companyId);
      const [row] = await tx
        .insert(contacts)
        .values({
          workspaceId: scope.workspaceId,
          email: input.email,
          name: input.name ?? null,
          phone: input.phone ?? null,
          companyId: input.companyId ?? null,
          source: input.source ?? null,
          ownerId: scope.userId,
          customFields: mergeCustomFields({}, input.customFields ?? {}),
        })
        .returning();
      if (input.tags) await this.replaceTags(tx, scope, row!.id, input.tags);
      return (await this.withTags(tx, [row!]))[0]!;
    });
    await this.events.emit(scope, {
      type: "contact.created",
      contactId: created.id,
      data: { email: created.email },
    });
    return created;
  }

  /** Public entry points (forms, workflow webhooks): reuse the contact with this email or create it. */
  async findOrCreate(scope: Scope, body: unknown) {
    const input = parse(contactInput, body);
    const find = () =>
      this.dbs.inWorkspace(scope, (tx) =>
        tx.select().from(contacts).where(eq(contacts.email, input.email)),
      );
    const [existing] = await find();
    if (existing) return { contact: existing, created: false };
    try {
      return { contact: await this.create(scope, input), created: true };
    } catch (err) {
      const [raced] = await find(); // two submissions of the same email at once
      if (raced) return { contact: raced, created: false };
      throw err;
    }
  }

  async update(scope: Scope, rawId: string, body: unknown) {
    const id = idParam(rawId);
    const patch = parse(contactPatch, body);
    const updated = await this.dbs.inWorkspace(scope, async (tx) => {
      const [existing] = await tx
        .select()
        .from(contacts)
        .where(eq(contacts.id, id));
      if (!existing) throw new NotFoundException("Contact not found");
      if (patch.customFields)
        await validateCustomFields(tx, patch.customFields);
      if (patch.companyId) await assertCompanyInWorkspace(tx, patch.companyId);
      const set: Partial<typeof contacts.$inferInsert> = {};
      if (patch.email !== undefined) set.email = patch.email;
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.phone !== undefined) set.phone = patch.phone;
      if (patch.companyId !== undefined) set.companyId = patch.companyId;
      if (patch.source !== undefined) set.source = patch.source;
      if (patch.customFields)
        set.customFields = mergeCustomFields(
          existing.customFields,
          patch.customFields,
        );
      const [row] = Object.keys(set).length
        ? await tx
            .update(contacts)
            .set(set)
            .where(eq(contacts.id, id))
            .returning()
        : [existing];
      if (patch.tags) await this.replaceTags(tx, scope, id, patch.tags);
      return (await this.withTags(tx, [row!]))[0]!;
    });
    await this.events.emit(scope, {
      type: "contact.updated",
      contactId: id,
      data: { fields: Object.keys(patch) },
    });
    return updated;
  }

  async remove(scope: Scope, rawId: string) {
    const id = idParam(rawId);
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx.delete(contacts).where(eq(contacts.id, id)).returning(),
    );
    if (!row) throw new NotFoundException("Contact not found");
    // contactId is null: the activity rows of a deleted contact are cascade-deleted with it.
    await this.events.emit(scope, {
      type: "contact.deleted",
      data: { id, email: row.email },
    });
  }

  async setTags(scope: Scope, rawId: string, body: unknown) {
    const id = idParam(rawId);
    const { tags: names } = parse(
      z.object({ tags: z.array(z.string().trim().min(1).max(50)).max(50) }),
      body,
    );
    await this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.id, id));
      if (rows.length === 0) throw new NotFoundException("Contact not found");
      await this.replaceTags(tx, scope, id, names);
    });
    await this.events.emit(scope, {
      type: "contact.tagged",
      contactId: id,
      data: { tags: names },
    });
    return this.get(scope, id);
  }

  async importCsv(scope: Scope, text: string) {
    let records: Record<string, string>[];
    try {
      records = parseCsv(text, {
        columns: (header: string[]) =>
          header.map((h) => h.trim().toLowerCase()),
        skip_empty_lines: true,
        bom: true,
        trim: true,
        relax_column_count: true,
      }) as Record<string, string>[];
    } catch (err) {
      throw new BadRequestException(`Invalid CSV: ${(err as Error).message}`);
    }
    if (records.length > MAX_IMPORT_ROWS)
      throw new BadRequestException(
        `At most ${MAX_IMPORT_ROWS} rows per import`,
      );
    if (records.length > 0 && !("email" in records[0]!))
      throw new BadRequestException("CSV needs an `email` column");

    const errors: { row: number; message: string }[] = [];
    const ignored = new Set<string>();
    let created = 0;
    let updated = 0;

    await this.dbs.inWorkspace(scope, async (tx) => {
      const defs = new Map(
        (await tx.select().from(customFieldDefs)).map((d) => [d.key, d]),
      );
      const companyIds = new Map<string, string>();
      const companyId = async (name: string) => {
        const cached = companyIds.get(name);
        if (cached) return cached;
        const [found] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.name, name));
        const id =
          found?.id ??
          (
            await tx
              .insert(companies)
              .values({ workspaceId: scope.workspaceId, name })
              .returning({ id: companies.id })
          )[0]!.id;
        companyIds.set(name, id);
        return id;
      };

      for (const [i, rec] of records.entries()) {
        const rowNo = i + 2; // header is row 1
        const em = email.safeParse(rec.email ?? "");
        if (!em.success) {
          errors.push({ row: rowNo, message: "Invalid email" });
          continue;
        }
        const custom: FieldValues = {};
        for (const [col, raw] of Object.entries(rec)) {
          if (BASE_COLUMNS.includes(col) || raw === "" || raw === undefined)
            continue;
          const def = defs.get(col);
          if (!def) {
            ignored.add(col);
            continue;
          }
          custom[col] =
            def.type === "number"
              ? Number(raw)
              : def.type === "boolean"
                ? /^(true|yes|1|y)$/i.test(raw)
                : raw;
        }
        try {
          await validateCustomFields(tx, custom);
        } catch (err) {
          errors.push({ row: rowNo, message: (err as Error).message });
          continue;
        }
        const [row] = await tx
          .insert(contacts)
          .values({
            workspaceId: scope.workspaceId,
            email: em.data,
            name: rec.name || null,
            phone: rec.phone || null,
            source: rec.source || null,
            companyId: rec.company ? await companyId(rec.company) : null,
            ownerId: scope.userId,
            customFields: custom,
          })
          .onConflictDoUpdate({
            target: [contacts.workspaceId, contacts.email],
            set: {
              name: sql`coalesce(excluded.name, ${contacts.name})`,
              phone: sql`coalesce(excluded.phone, ${contacts.phone})`,
              source: sql`coalesce(excluded.source, ${contacts.source})`,
              companyId: sql`coalesce(excluded.company_id, ${contacts.companyId})`,
              customFields: sql`${contacts.customFields} || excluded.custom_fields`,
              updatedAt: new Date(),
            },
          })
          .returning({ id: contacts.id, inserted: sql<boolean>`(xmax = 0)` });
        if (row!.inserted) created++;
        else updated++;
        const names = (rec.tags ?? "")
          .split(";")
          .map((t) => t.trim())
          .filter(Boolean);
        if (names.length) {
          const tagRows = await this.ensureTags(tx, scope, names);
          await tx
            .insert(contactTags)
            .values(
              tagRows.map((t) => ({
                workspaceId: scope.workspaceId,
                contactId: row!.id,
                tagId: t.id,
              })),
            )
            .onConflictDoNothing();
        }
      }
    });
    await this.events.emit(scope, {
      type: "contacts.imported",
      data: { created, updated, errors: errors.length },
    });
    return { created, updated, errors, ignoredColumns: [...ignored] };
  }

  /** shortcut: builds the whole CSV in memory; stream it when workspaces reach ~100k contacts. */
  async exportCsv(scope: Scope): Promise<string> {
    return this.dbs.inWorkspace(scope, async (tx) => {
      const defs = await tx
        .select({ key: customFieldDefs.key })
        .from(customFieldDefs)
        .orderBy(asc(customFieldDefs.key));
      const header = [...BASE_COLUMNS, ...defs.map((d) => d.key)];
      const lines: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      for (;;) {
        const rows = await tx
          .select({ contact: contacts, company: companies.name })
          .from(contacts)
          .leftJoin(companies, eq(companies.id, contacts.companyId))
          .where(cursor ? lt(contacts.id, cursor) : undefined)
          .orderBy(desc(contacts.id))
          .limit(1000);
        if (rows.length === 0) break;
        const withTags = await this.withTags(
          tx,
          rows.map((r) => r.contact),
        );
        for (const [i, r] of rows.entries()) {
          const c = withTags[i]!;
          lines.push({
            email: c.email,
            name: c.name ?? "",
            phone: c.phone ?? "",
            source: c.source ?? "",
            company: r.company ?? "",
            tags: c.tags.map((t) => t.name).join(";"),
            ...Object.fromEntries(
              defs.map((d) => [d.key, c.customFields[d.key] ?? ""]),
            ),
          });
        }
        cursor = rows[rows.length - 1]!.contact.id;
        if (rows.length < 1000) break;
      }
      return stringify(lines, { header: true, columns: header });
    });
  }
}
