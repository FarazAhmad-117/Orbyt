import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  and,
  asc,
  contacts,
  conversations,
  desc,
  emailEvents,
  eq,
  ilike,
  inArray,
  lt,
  mailboxes,
  messages,
  or,
  uuidv7,
} from "@orbyt/db";
import { z } from "zod";
import { ChannelsService } from "../channels/channels.service";
import { DbService } from "../db.service";
import { EventsService } from "../events.service";
import { idParam, parse } from "../http";
import { Ctx, type Scope, WorkspaceGuard } from "../scope";
import { MailService, SendError } from "./mail.service";
import { textToHtml } from "./render";
import { SyncService } from "./sync.service";

const listQuery = z.object({
  status: z.enum(["open", "closed"]).optional(),
  unread: z.enum(["true", "false"]).optional(),
  mailboxId: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // "<ISO timestamp>_<id>": keyset position of the last row of the previous page.
  cursor: z
    .string()
    .regex(/^[^_]+_[0-9a-f-]{36}$/i)
    .optional(),
});

@Controller("api/w/:workspaceId/inbox")
@UseGuards(WorkspaceGuard)
export class ConversationsController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(ChannelsService) private readonly channels: ChannelsService,
  ) {}

  /** Newest activity first. */
  @Get("conversations")
  list(@Ctx() scope: Scope, @Query() rawQuery: unknown) {
    const q = parse(listQuery, rawQuery);
    return this.dbs.inWorkspace(scope, async (tx) => {
      let after: ReturnType<typeof or> | undefined;
      if (q.cursor) {
        const [iso, id] = q.cursor.split("_") as [string, string];
        const t = new Date(iso);
        if (Number.isNaN(t.getTime()))
          throw new BadRequestException("Invalid cursor");
        after = or(
          lt(conversations.lastMessageAt, t),
          and(eq(conversations.lastMessageAt, t), lt(conversations.id, id)),
        );
      }
      const like = q.q ? `%${q.q.replace(/[\\%_]/g, "\\$&")}%` : null;
      const rows = await tx
        .select({
          c: conversations,
          email: contacts.email,
          name: contacts.name,
        })
        .from(conversations)
        .leftJoin(contacts, eq(contacts.id, conversations.contactId))
        .where(
          and(
            q.status ? eq(conversations.status, q.status) : undefined,
            q.unread
              ? eq(conversations.hasUnread, q.unread === "true")
              : undefined,
            q.mailboxId ? eq(conversations.mailboxId, q.mailboxId) : undefined,
            like
              ? or(
                  ilike(conversations.subject, like),
                  ilike(contacts.email, like),
                  ilike(contacts.name, like),
                )
              : undefined,
            after,
          ),
        )
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const last = page.length
        ? await tx
            .selectDistinctOn([messages.conversationId], {
              conversationId: messages.conversationId,
              direction: messages.direction,
              snippet: messages.bodyText,
              at: messages.at,
            })
            .from(messages)
            .where(
              inArray(
                messages.conversationId,
                page.map((r) => r.c.id),
              ),
            )
            .orderBy(messages.conversationId, desc(messages.at))
        : [];
      const lastBy = new Map(last.map((m) => [m.conversationId, m]));
      const tail = page[page.length - 1];
      return {
        items: page.map((r) => ({
          ...r.c,
          contactEmail: r.email,
          contactName: r.name,
          lastDirection: lastBy.get(r.c.id)?.direction ?? null,
          snippet: (lastBy.get(r.c.id)?.snippet ?? "").slice(0, 200),
        })),
        nextCursor:
          rows.length > q.limit && tail
            ? `${tail.c.lastMessageAt.toISOString()}_${tail.c.id}`
            : null,
      };
    });
  }

  @Get("conversations/:id")
  async get(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [row] = await tx
        .select({
          c: conversations,
          email: contacts.email,
          name: contacts.name,
        })
        .from(conversations)
        .leftJoin(contacts, eq(contacts.id, conversations.contactId))
        .where(eq(conversations.id, id));
      if (!row) throw new NotFoundException("Conversation not found");
      const thread = await tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(asc(messages.at), asc(messages.id));
      return {
        ...row.c,
        contactEmail: row.email,
        contactName: row.name,
        messages: thread,
      };
    });
  }

  @Patch("conversations/:id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const d = parse(
      z.object({
        status: z.enum(["open", "closed"]).optional(),
        read: z.boolean().optional(),
      }),
      body,
    );
    const set: Partial<typeof conversations.$inferInsert> = {};
    if (d.status) set.status = d.status;
    if (d.read !== undefined) set.hasUnread = !d.read;
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      Object.keys(set).length
        ? tx
            .update(conversations)
            .set(set)
            .where(eq(conversations.id, id))
            .returning()
        : tx.select().from(conversations).where(eq(conversations.id, id)),
    );
    if (!rows[0]) throw new NotFoundException("Conversation not found");
    return rows[0];
  }

  /** Reply from the inbox: sent from the conversation's mailbox, threaded onto the latest message. */
  @Post("conversations/:id/reply")
  async reply(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const { body: text } = parse(
      z.object({ body: z.string().trim().min(1).max(20_000) }),
      body,
    );
    // SMS / WhatsApp conversations are answered through their channel account, not a mailbox.
    const [kind] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .select({ channel: conversations.channel })
        .from(conversations)
        .where(eq(conversations.id, id)),
    );
    if (kind && kind.channel !== "email")
      return this.channels.reply(scope, id, text);
    const ctx = await this.dbs.inWorkspace(scope, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, id));
      if (!conv) throw new NotFoundException("Conversation not found");
      if (!conv.mailboxId)
        throw new BadRequestException(
          "The mailbox for this conversation was removed",
        );
      const [mailbox] = await tx
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.id, conv.mailboxId));
      if (!mailbox || mailbox.status !== "active")
        throw new BadRequestException("The mailbox is not active");
      const [latest] = await tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(desc(messages.at))
        .limit(1);
      const [lastIn] = await tx
        .select()
        .from(messages)
        .where(
          and(eq(messages.conversationId, id), eq(messages.direction, "in")),
        )
        .orderBy(desc(messages.at))
        .limit(1);
      const [contact] = conv.contactId
        ? await tx
            .select()
            .from(contacts)
            .where(eq(contacts.id, conv.contactId))
        : [];
      const to = lastIn?.fromEmail ?? contact?.email;
      if (!to) throw new BadRequestException("No recipient to reply to");
      return { conv, mailbox, latest, to, contactId: contact?.id ?? null };
    });

    const messageUuid = uuidv7();
    const messageId = `${messageUuid}@${ctx.mailbox.email.split("@")[1]}`;
    const subject = `Re: ${ctx.conv.subject.replace(/^(re:\s*)+/i, "")}`;
    try {
      await this.mail.send({
        mailbox: ctx.mailbox,
        to: ctx.to,
        subject,
        text,
        html: `<div>${textToHtml(text)}</div>`,
        messageId,
        inReplyTo: ctx.latest?.messageId,
        references: ctx.latest ? [ctx.latest.messageId] : undefined,
      });
    } catch (err) {
      throw new BadRequestException(
        `Could not send: ${err instanceof SendError ? err.message : (err as Error).message}`,
      );
    }
    const at = new Date();
    const saved = await this.dbs.inWorkspace(scope, async (tx) => {
      const [row] = await tx
        .insert(messages)
        .values({
          id: messageUuid,
          workspaceId: scope.workspaceId,
          conversationId: id,
          direction: "out",
          mailboxId: ctx.mailbox.id,
          messageId,
          inReplyTo: ctx.latest?.messageId ?? null,
          fromEmail: ctx.mailbox.email,
          toEmail: ctx.to,
          subject,
          bodyText: text,
          bodyHtml: `<div>${textToHtml(text)}</div>`,
          at,
        })
        .returning();
      await tx
        .update(conversations)
        .set({ lastMessageAt: at, hasUnread: false })
        .where(eq(conversations.id, id));
      await tx.insert(emailEvents).values({
        workspaceId: scope.workspaceId,
        type: "sent",
        contactId: ctx.contactId,
        messageId: messageUuid,
        data: { manual: true },
      });
      return row!;
    });
    await this.events.emit(scope, {
      type: "email.sent",
      contactId: ctx.contactId,
      data: { manual: true },
    });
    return saved;
  }

  /** Pull new mail now (otherwise it is polled every minute). */
  @Post("sync")
  @HttpCode(200)
  async syncNow(@Ctx() scope: Scope, @Body() body: unknown) {
    const { mailboxId } = parse(
      z.object({ mailboxId: z.uuid().optional() }),
      body ?? {},
    );
    const ids = mailboxId
      ? [mailboxId]
      : (
          await this.dbs.inWorkspace(scope, (tx) =>
            tx
              .select({ id: mailboxes.id })
              .from(mailboxes)
              .where(eq(mailboxes.status, "active")),
          )
        ).map((m) => m.id);
    let processed = 0;
    const errors: { mailboxId: string; error: string }[] = [];
    for (const id of ids) {
      const r = await this.sync.syncMailbox(scope.workspaceId, id);
      processed += r.processed;
      if (r.error) errors.push({ mailboxId: id, error: r.error });
    }
    return { processed, errors };
  }
}
