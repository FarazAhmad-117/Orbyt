import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  and,
  contacts,
  conversations,
  desc,
  emailEvents,
  enrollments,
  eq,
  inArray,
  mailboxes,
  messages,
  sequences,
  suppressions,
  workspaces,
  type Tx,
} from "@orbyt/db";
import { simpleParser, type ParsedMail } from "mailparser";
import { DbService } from "../db.service";
import { EventsService, type DomainEvent } from "../events.service";
import { metrics } from "../ops/metrics";
import { systemScope, type Scope } from "../scope";
import { loginFailure, MailService, type MailboxRow } from "./mail.service";

const strip = (id: string) => id.replace(/^<|>$/g, "");

export type InboundKind = "bounce" | "auto_reply" | "reply";

export interface BounceInfo {
  recipient: string | null;
  hard: boolean;
  reason: string;
}

/** Classifies an incoming message: delivery failure report, out-of-office/auto-responder, or a real reply. */
export function classify(
  parsed: ParsedMail,
  from: string,
): { kind: InboundKind; bounce?: BounceInfo } {
  const subject = parsed.subject ?? "";
  const text = parsed.text ?? "";
  const contentType = parsed.headers.get("content-type");
  const isReport =
    typeof contentType === "object" &&
    contentType !== null &&
    "value" in contentType &&
    String((contentType as { value: string }).value).toLowerCase() ===
      "multipart/report";
  const looksLikeBounce =
    /^(mailer-daemon|postmaster)@/i.test(from) ||
    isReport ||
    /undeliver|delivery status notification|returned mail|failure notice|delivery has failed/i.test(
      subject,
    );
  if (looksLikeBounce) {
    const failed = parsed.headers.get("x-failed-recipients");
    const recipient =
      (typeof failed === "string" ? failed.split(",")[0]?.trim() : undefined) ??
      /Final-Recipient:\s*rfc822;\s*<?([^\s<>]+)>?/i.exec(text)?.[1] ??
      /Original-Recipient:\s*rfc822;\s*<?([^\s<>]+)>?/i.exec(text)?.[1] ??
      /<([^\s<>@]+@[^\s<>]+)>/.exec(text)?.[1] ??
      null;
    const status = /Status:\s*([245])\.\d+\.\d+/i.exec(text)?.[1];
    const hard =
      status === "5" ||
      (!status &&
        (/\b5\d\d\b/.test(text) ||
          /user unknown|no such user|does not exist|unknown recipient|invalid recipient|address rejected/i.test(
            text,
          )) &&
        !/\b4\d\d\b|temporar|try again|mailbox full/i.test(text));
    return {
      kind: "bounce",
      bounce: {
        recipient: recipient?.toLowerCase() ?? null,
        hard,
        reason: text.slice(0, 500),
      },
    };
  }
  const auto = String(parsed.headers.get("auto-submitted") ?? "");
  const precedence = String(parsed.headers.get("precedence") ?? "");
  if (
    (auto && auto.toLowerCase() !== "no") ||
    parsed.headers.has("x-autoreply") ||
    parsed.headers.has("x-autorespond") ||
    /^(bulk|junk|auto_reply)$/i.test(precedence) ||
    /^(automatic reply|auto(matic)?[- ]?reply|out of office|autosvar)/i.test(
      subject,
    )
  )
    return { kind: "auto_reply" };
  return { kind: "reply" };
}

/**
 * Polls each mailbox's INBOX over IMAP (no push, so self-hosting needs nothing public) and turns
 * new mail into conversations, reply/bounce events and suppressions. Re-fetching is harmless:
 * messages are de-duplicated by Message-ID.
 */
@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  onModuleInit() {
    if (process.env.ORBYT_SYNC === "off") return;
    const every = Number(process.env.ORBYT_SYNC_INTERVAL_MS ?? 60_000);
    this.timer = setInterval(
      () => void this.syncAll().catch((e) => console.error("[sync]", e)),
      every,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async syncAll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let total = 0;
      for (const { id } of await this.dbs.db
        .select({ id: workspaces.id })
        .from(workspaces)) {
        const boxes = await this.dbs.inWorkspace(systemScope(id), (tx) =>
          tx
            .select({ id: mailboxes.id })
            .from(mailboxes)
            .where(eq(mailboxes.status, "active")),
        );
        // One broken mailbox must never stop the others from syncing.
        for (const b of boxes)
          try {
            total += (await this.syncMailbox(id, b.id)).processed;
          } catch (err) {
            metrics.inc("orbyt_loop_errors_total", 1, { loop: "sync" });
            console.error(`[sync] mailbox ${b.id}:`, err);
          }
      }
      metrics.inc("orbyt_inbound_messages_total", total);
      metrics.set("orbyt_loop_last_run_timestamp_seconds", Date.now() / 1000, {
        loop: "sync",
      });
      return total;
    } finally {
      this.running = false;
    }
  }

  async syncMailbox(
    workspaceId: string,
    mailboxId: string,
  ): Promise<{ processed: number; error?: string }> {
    const scope = systemScope(workspaceId);
    const [mailbox] = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)),
    );
    if (!mailbox || mailbox.status === "paused") return { processed: 0 };

    let client: Awaited<ReturnType<MailService["imap"]>>;
    try {
      client = await this.mail.imap(mailbox);
    } catch (err) {
      // Unreadable credentials or a revoked OAuth grant: record it on the mailbox and move on.
      // (A provider outage while refreshing is only reported; the next pass tries again.)
      const f = loginFailure(err);
      if (f.kind === "auth")
        await this.dbs.inWorkspace(scope, (tx) =>
          tx
            .update(mailboxes)
            .set({ status: "error", lastError: f.message })
            .where(eq(mailboxes.id, mailbox.id)),
        );
      return { processed: 0, error: f.message };
    }
    let processed = 0;
    let last = mailbox.imapLastUid;
    let validity = mailbox.imapUidValidity;
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const box = client.mailbox;
        const current =
          box && typeof box === "object" ? Number(box.uidValidity) : null;
        // A changed UIDVALIDITY means old UIDs are meaningless: start over (dedupe makes it safe).
        if (current !== null && validity !== null && current !== validity)
          last = 0;
        validity = current;
        const since = last;
        for await (const msg of client.fetch(
          `${since + 1}:*`,
          { uid: true, source: true, internalDate: true },
          { uid: true },
        )) {
          if (msg.uid <= since) continue; // "n:*" always yields the newest message, even if old
          try {
            // Ordering uses when OUR server received the mail, not the sender's Date header
            // (second precision, and clients with a wrong clock could otherwise pin a thread to the top).
            const received = new Date(msg.internalDate ?? Date.now());
            await this.ingest(
              scope,
              mailbox,
              await simpleParser(msg.source as Buffer),
              msg.uid,
              received,
            );
            processed++;
          } catch (err) {
            console.error(`[sync] mailbox ${mailbox.id} uid ${msg.uid}:`, err);
          }
          last = Math.max(last, msg.uid);
        }
      } finally {
        lock.release();
      }
      await this.dbs.inWorkspace(scope, (tx) =>
        tx
          .update(mailboxes)
          .set({
            lastSyncAt: new Date(),
            imapLastUid: last,
            imapUidValidity: validity,
            lastError: null,
          })
          .where(eq(mailboxes.id, mailbox.id)),
      );
      return { processed };
    } catch (err) {
      const e = err as { authenticationFailed?: boolean; message: string };
      await this.dbs.inWorkspace(scope, (tx) =>
        tx
          .update(mailboxes)
          .set({
            lastError: e.message,
            ...(e.authenticationFailed ? { status: "error" } : {}),
          })
          .where(eq(mailboxes.id, mailbox.id)),
      );
      return { processed, error: e.message };
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async ingest(
    scope: Scope,
    mailbox: MailboxRow,
    parsed: ParsedMail,
    uid: number,
    receivedAt: Date,
  ) {
    const from = parsed.from?.value[0]?.address?.toLowerCase();
    if (!from || from === mailbox.email.toLowerCase()) return; // our own copy / unusable
    const messageId = strip(parsed.messageId ?? `${mailbox.id}-${uid}`);
    const { kind, bounce } = classify(parsed, from);
    const events: DomainEvent[] = [];

    await this.dbs.inWorkspace(scope, async (tx) => {
      const dup = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.mailboxId, mailbox.id),
            eq(messages.direction, "in"),
            eq(messages.messageId, messageId),
          ),
        );
      if (dup.length) return;
      if (kind === "bounce")
        return this.recordBounce(tx, scope, mailbox, bounce!, events);

      const refs = [parsed.references ?? []].flat().map(strip);
      const parents = [parsed.inReplyTo, ...refs]
        .filter((x): x is string => !!x)
        .map(strip);
      const [parent] = parents.length
        ? await tx
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.mailboxId, mailbox.id),
                eq(messages.direction, "out"),
                inArray(messages.messageId, parents),
              ),
            )
            .orderBy(desc(messages.at))
            .limit(1)
        : [];
      const [contact] = await tx
        .select()
        .from(contacts)
        .where(eq(contacts.email, from));
      let convId = parent?.conversationId;
      if (!convId && contact) {
        const [c] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.contactId, contact.id),
              eq(conversations.mailboxId, mailbox.id),
            ),
          )
          .orderBy(desc(conversations.lastMessageAt))
          .limit(1);
        convId = c?.id;
      }
      // INTERNALDATE has one-second precision, but a reply cannot predate the message it answers:
      // clamp so the thread order is always right.
      const at =
        parent && parent.at >= receivedAt
          ? new Date(parent.at.getTime() + 1)
          : receivedAt;
      if (convId)
        await tx
          .update(conversations)
          .set({ lastMessageAt: at, hasUnread: true, status: "open" })
          .where(eq(conversations.id, convId));
      else
        convId = (
          await tx
            .insert(conversations)
            .values({
              workspaceId: scope.workspaceId,
              contactId: contact?.id ?? null,
              mailboxId: mailbox.id,
              subject: parsed.subject?.trim() || "(no subject)",
              hasUnread: true,
              lastMessageAt: at,
            })
            .returning({ id: conversations.id })
        )[0]!.id;
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, convId));
      const enrollmentId = parent?.enrollmentId ?? conv?.enrollmentId ?? null;
      await tx.insert(messages).values({
        workspaceId: scope.workspaceId,
        conversationId: convId,
        direction: "in",
        mailboxId: mailbox.id,
        messageId,
        inReplyTo: parsed.inReplyTo ? strip(parsed.inReplyTo) : null,
        fromEmail: from,
        toEmail: mailbox.email,
        subject: parsed.subject?.trim() || "(no subject)",
        bodyText: parsed.text ?? null,
        bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
        enrollmentId,
        at,
      });

      if (!enrollmentId) return;
      const type = kind === "reply" ? "reply" : "auto_reply";
      await tx.insert(emailEvents).values({
        workspaceId: scope.workspaceId,
        type,
        contactId: contact?.id ?? conv?.contactId ?? null,
        enrollmentId,
        data: { messageId },
      });
      if (kind === "reply") {
        // A human answered: stop the sequence (unless the sequence says otherwise).
        const [row] = await tx
          .select({ e: enrollments, s: sequences })
          .from(enrollments)
          .innerJoin(sequences, eq(sequences.id, enrollments.sequenceId))
          .where(eq(enrollments.id, enrollmentId));
        // "replied" is the outcome people report on, so it also upgrades an already-completed
        // enrollment (nothing left to stop); an active one only stops if the sequence says so.
        if (
          row &&
          (row.e.status === "completed" ||
            (row.e.status === "active" && row.s.stopOnReply))
        )
          await tx
            .update(enrollments)
            .set({ status: "replied", nextSendAt: null })
            .where(eq(enrollments.id, enrollmentId));
        events.push({
          type: "email.replied",
          contactId: contact?.id ?? conv?.contactId ?? null,
          data: { enrollmentId, from },
        });
      }
    });
    for (const event of events) await this.events.emit(scope, event);
  }

  private async recordBounce(
    tx: Tx,
    scope: Scope,
    mailbox: MailboxRow,
    bounce: BounceInfo,
    events: DomainEvent[],
  ) {
    if (!bounce.recipient) return;
    // Which of our emails bounced? The latest one we sent to that address from this mailbox.
    const [sent] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, mailbox.id),
          eq(messages.direction, "out"),
          eq(messages.toEmail, bounce.recipient),
        ),
      )
      .orderBy(desc(messages.at))
      .limit(1);
    if (!sent) return; // a bounce for something we did not send
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(eq(contacts.email, bounce.recipient));
    await tx.insert(emailEvents).values({
      workspaceId: scope.workspaceId,
      type: bounce.hard ? "bounce_hard" : "bounce_soft",
      contactId: contact?.id ?? null,
      enrollmentId: sent.enrollmentId,
      messageId: sent.id,
      data: { reason: bounce.reason, source: "dsn" },
    });
    if (bounce.hard) {
      await tx
        .insert(suppressions)
        .values({
          workspaceId: scope.workspaceId,
          email: bounce.recipient,
          reason: "hard_bounce",
        })
        .onConflictDoNothing();
      if (sent.enrollmentId)
        await tx
          .update(enrollments)
          .set({ status: "bounced", nextSendAt: null })
          .where(
            and(
              eq(enrollments.id, sent.enrollmentId),
              eq(enrollments.status, "active"),
            ),
          );
    }
    events.push({
      type: "email.bounced",
      contactId: contact?.id ?? null,
      data: {
        enrollmentId: sent.enrollmentId,
        hard: bounce.hard,
        recipient: bounce.recipient,
      },
    });
  }
}
