import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Options,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  and,
  desc,
  eq,
  formSubmissions,
  forms,
  lt,
  sql,
  type FormField,
} from "@orbyt/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ContactsService } from "../contacts.service";
import { DbService } from "../db.service";
import { EventsService } from "../events.service";
import { idParam, notFoundIfEmpty, parse } from "../http";
import {
  allowAnyOrigin,
  clientIp,
  escapeHtml,
  publicBase,
  rateLimit,
} from "../public-endpoints";
import { Ctx, type Scope, systemScope, WorkspaceGuard } from "../scope";

const MAX_FORMS = 50;
const fieldSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/,
      "Field names start with a letter and use letters, digits and _",
    ),
  label: z.string().trim().min(1).max(100),
  type: z.enum(["text", "email", "tel", "textarea"]),
  required: z.boolean().default(false),
});
const fieldsSchema = z
  .array(fieldSchema)
  .min(1)
  .max(20)
  .superRefine((fields, ctx) => {
    const names = fields.map((f) => f.name);
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: "custom", message: "Field names must be unique" });
    if (names.includes("_hp"))
      ctx.addIssue({ code: "custom", message: '"_hp" is reserved' });
    const email = fields.find((f) => f.name === "email");
    if (!email || email.type !== "email" || !email.required)
      ctx.addIssue({
        code: "custom",
        message: 'A form needs a required field named "email" of type email',
      });
  });
const formInput = z.object({
  name: z.string().trim().min(1).max(200),
  fields: fieldsSchema,
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  successMessage: z.string().trim().min(1).max(500).optional(),
  status: z.enum(["active", "paused"]).optional(),
});

const urlOf = (workspaceId: string, token: string) =>
  `${publicBase()}/api/forms/${workspaceId}/${token}`;

/** A plain HTML snippet to paste into any website. No JavaScript needed. */
function embedHtml(url: string, fields: FormField[]) {
  const rows = fields
    .map((f) => {
      const id = `orbyt-${f.name}`;
      const control =
        f.type === "textarea"
          ? `<textarea id="${id}" name="${f.name}"${f.required ? " required" : ""}></textarea>`
          : `<input id="${id}" name="${f.name}" type="${f.type}"${f.required ? " required" : ""}>`;
      return `  <label for="${id}">${escapeHtml(f.label)}</label>\n  ${control}`;
    })
    .join("\n");
  return `<form method="post" action="${url}">\n${rows}\n  <input name="_hp" style="display:none" tabindex="-1" autocomplete="off">\n  <button type="submit">Send</button>\n</form>`;
}

const present = (
  workspaceId: string,
  f: typeof forms.$inferSelect & { submissions?: number },
) => ({
  id: f.id,
  name: f.name,
  fields: f.fields,
  tags: f.tags,
  successMessage: f.successMessage,
  status: f.status,
  publicToken: f.publicToken,
  submissions: f.submissions ?? 0,
  createdAt: f.createdAt,
  url: urlOf(workspaceId, f.publicToken),
  embedHtml: embedHtml(urlOf(workspaceId, f.publicToken), f.fields),
});

@Controller("api/w/:workspaceId/forms")
@UseGuards(WorkspaceGuard)
export class FormsController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select({
          form: forms,
          // Written out by hand: Drizzle prints a single-table select's columns unqualified, which would
          // bind "id" to the subquery's own table.
          submissions: sql<number>`(select count(*)::int from form_submissions s where s.form_id = forms.id)`,
        })
        .from(forms)
        .orderBy(desc(forms.id));
      return rows.map((r) =>
        present(scope.workspaceId, { ...r.form, submissions: r.submissions }),
      );
    });
  }

  @Post()
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(formInput, body);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(forms);
      if (n >= MAX_FORMS)
        throw new BadRequestException(
          `At most ${MAX_FORMS} forms per workspace`,
        );
      const [row] = await tx
        .insert(forms)
        .values({
          workspaceId: scope.workspaceId,
          name: d.name,
          fields: d.fields,
          tags: d.tags,
          ...(d.successMessage ? { successMessage: d.successMessage } : {}),
          ...(d.status ? { status: d.status } : {}),
          publicToken: randomBytes(24).toString("hex"),
        })
        .returning();
      return present(scope.workspaceId, row!);
    });
  }

  @Get(":id")
  async get(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(forms).where(eq(forms.id, id)),
    );
    return present(scope.workspaceId, notFoundIfEmpty(rows, "Form"));
  }

  @Patch(":id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const d = parse(formInput.partial(), body);
    const set: Partial<typeof forms.$inferInsert> = {};
    if (d.name !== undefined) set.name = d.name;
    if (d.fields !== undefined) set.fields = d.fields;
    if (d.tags !== undefined) set.tags = d.tags;
    if (d.successMessage !== undefined) set.successMessage = d.successMessage;
    if (d.status !== undefined) set.status = d.status;
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      Object.keys(set).length
        ? tx.update(forms).set(set).where(eq(forms.id, id)).returning()
        : tx.select().from(forms).where(eq(forms.id, id)),
    );
    return present(scope.workspaceId, notFoundIfEmpty(rows, "Form"));
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.delete(forms).where(eq(forms.id, id)).returning({ id: forms.id }),
    );
    notFoundIfEmpty(rows, "Form");
  }

  @Get(":id/submissions")
  submissions(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Query() rawQuery: unknown,
  ) {
    const id = idParam(rawId);
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.uuid().optional(),
      }),
      rawQuery,
    );
    return this.dbs.inWorkspace(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(formSubmissions)
        .where(
          and(
            eq(formSubmissions.formId, id),
            q.cursor ? lt(formSubmissions.id, q.cursor) : undefined,
          ),
        )
        .orderBy(desc(formSubmissions.id))
        .limit(q.limit + 1);
      const items = rows.slice(0, q.limit);
      return {
        items,
        nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null,
      };
    });
  }
}

const wantsHtml = (req: FastifyRequest) =>
  (req.headers.accept ?? "").includes("text/html") &&
  !(req.headers.accept ?? "").includes("application/json");
const page = (title: string, message: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`;

/**
 * The public side of a form. Anyone can submit; the unguessable token in the URL selects the form,
 * and a honeypot field, a per-visitor rate limit and strict validation keep junk out.
 */
@Controller("api/forms")
export class PublicFormsController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private async find(workspaceId: string, token: string) {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId) || !/^[0-9a-f]{48}$/.test(token))
      throw new NotFoundException();
    const [form] = await this.dbs.inWorkspace(systemScope(workspaceId), (tx) =>
      tx
        .select()
        .from(forms)
        .where(and(eq(forms.publicToken, token), eq(forms.status, "active"))),
    );
    if (!form) throw new NotFoundException();
    return form;
  }

  @Options(":workspaceId/:token")
  @HttpCode(204)
  preflight(@Res({ passthrough: true }) reply: FastifyReply) {
    allowAnyOrigin(reply);
  }

  /** The form definition, for sites that render the fields themselves. */
  @Get(":workspaceId/:token")
  async definition(
    @Param("workspaceId") workspaceId: string,
    @Param("token") token: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    allowAnyOrigin(reply);
    const form = await this.find(workspaceId, token);
    return {
      name: form.name,
      fields: form.fields,
      successMessage: form.successMessage,
    };
  }

  @Post(":workspaceId/:token")
  @HttpCode(200)
  async submit(
    @Param("workspaceId") workspaceId: string,
    @Param("token") token: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    allowAnyOrigin(reply);
    const html = wantsHtml(req);
    try {
      const form = await this.find(workspaceId, token);
      rateLimit(`form:${token}:${clientIp(req)}`, 10);
      const raw = parse(z.record(z.string(), z.unknown()), body ?? {});

      // Honeypot: real visitors never see this field. Bots fill it and get a fake success.
      if (typeof raw._hp === "string" && raw._hp.trim() !== "")
        return this.reply(reply, html, form.successMessage);

      const data: Record<string, string> = {};
      for (const f of form.fields) {
        const value = raw[f.name];
        const v = typeof value === "string" ? value.trim() : "";
        if (!v) {
          if (f.required)
            throw new BadRequestException(`${f.label} is required`);
          continue;
        }
        const max = f.type === "textarea" ? 5000 : f.type === "tel" ? 50 : 500;
        if (v.length > max)
          throw new BadRequestException(`${f.label} is too long`);
        if (f.type === "email" && !z.email().safeParse(v).success)
          throw new BadRequestException(
            `${f.label} is not a valid email address`,
          );
        data[f.name] = v;
      }

      const scope = systemScope(workspaceId);
      const { contact } = await this.contacts.findOrCreate(scope, {
        email: data.email!.toLowerCase(),
        name: data.name || undefined,
        phone: data.phone || undefined,
        source: `form: ${form.name}`.slice(0, 100),
      });
      if (form.tags.length) {
        const current = (
          (await this.contacts.get(scope, contact.id)) as {
            tags: { name: string }[];
          }
        ).tags.map((t) => t.name);
        const merged = [...new Set([...current, ...form.tags])];
        if (merged.length !== current.length)
          await this.contacts.setTags(scope, contact.id, { tags: merged });
      }
      await this.dbs.inWorkspace(scope, (tx) =>
        tx.insert(formSubmissions).values({
          workspaceId,
          formId: form.id,
          contactId: contact.id,
          data,
        }),
      );
      await this.events.emit(scope, {
        type: "form.submitted",
        contactId: contact.id,
        data: { formId: form.id, formName: form.name, fields: data },
      });
      return this.reply(reply, html, form.successMessage);
    } catch (err) {
      if (!html || !(err instanceof HttpException)) throw err;
      return reply
        .status(err.getStatus())
        .type("text/html")
        .send(page("Something went wrong", err.message));
    }
  }

  private reply(reply: FastifyReply, html: boolean, message: string) {
    return html
      ? reply.type("text/html").send(page("Thank you", message))
      : reply.send({ ok: true, message });
  }
}
