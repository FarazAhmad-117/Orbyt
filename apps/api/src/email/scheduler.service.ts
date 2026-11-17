import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  and,
  asc,
  companies,
  contacts,
  conversations,
  desc,
  emailEvents,
  enrollments,
  eq,
  gte,
  inArray,
  lte,
  mailboxes,
  messages,
  sequences,
  sequenceSteps,
  sql,
  suppressions,
  uuidv7,
  workspaces,
  type Tx,
} from "@orbyt/db";
import { DbService } from "../db.service";
import { EventsService, type DomainEvent } from "../events.service";
import { systemScope, type Scope } from "../scope";
import { MailService, SendError, type MailboxRow } from "./mail.service";
import { buildEmail, mergeVars, renderTemplate } from "./render";
import { signToken } from "./secrets";
import { metrics } from "../ops/metrics";
import { effectiveDailyLimit } from "./warmup";
import { inWindow, jitter, nextWindowStart, type SendWindow } from "./window";

const HOUR = 3_600_000;
const MAX_ATTEMPTS = 5;

/** Public base URL used in unsubscribe/tracking links (the web origin, which proxies /api). */
export function publicBase(): string {
  return (
    process.env.PUBLIC_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3001"
  ).replace(/\/+$/, "");
}

type Outcome = { kind: "none" | "sent" | "skipped"; events: DomainEvent[] };
type Enrollment = typeof enrollments.$inferSelect;
type Sequence = typeof sequences.$inferSelect;

/**
 * Postgres-backed sender. Every pass walks the workspaces and, per workspace, claims due
 * enrollments one at a time with `FOR UPDATE SKIP LOCKED`, so several API replicas can run it
 * safely. Delivery is at-least-once: if the process dies between sending and the commit, that one
 * email may be sent again. shortcut: the pass visits every workspace; add a "due work" index when
 * a deployment has thousands of workspaces.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  onModuleInit() {
    if (process.env.ORBYT_SCHEDULER === "off") return; // tests drive tick() themselves
    const every = Number(process.env.ORBYT_SCHEDULER_INTERVAL_MS ?? 30_000);
    this.timer = setInterval(
      () => void this.tick().catch((e) => console.error("[scheduler]", e)),
      every,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over all workspaces (or just `only`). Returns the number of emails sent. */
  async tick(now = new Date(), only?: string): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const rows = await this.dbs.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(only ? eq(workspaces.id, only) : undefined);
      let sent = 0;
      for (const { id } of rows) {
        // An unexpected failure in one workspace must not stall every workspace after it.
        try {
          for (let i = 0; i < 500; i++) {
            const kind = await this.processNext(id, now);
            if (kind === "none") break;
            if (kind === "sent") sent++;
          }
        } catch (err) {
          metrics.inc("orbyt_loop_errors_total", 1, { loop: "scheduler" });
          console.error(`[scheduler] workspace ${id}:`, err);
        }
      }
      metrics.inc("orbyt_emails_sent_total", sent);
      metrics.set("orbyt_loop_last_run_timestamp_seconds", Date.now() / 1000, {
        loop: "scheduler",
      });
      return sent;
    } finally {
      this.ticking = false;
    }
  }

  private async processNext(
    workspaceId: string,
    now: Date,
  ): Promise<Outcome["kind"]> {
    const scope = systemScope(workspaceId);
    const outcome = await this.dbs.inWorkspace(
      scope,
      async (tx): Promise<Outcome> => {
        const [due] = await tx
          .select({ e: enrollments, s: sequences })
          .from(enrollments)
          .innerJoin(sequences, eq(sequences.id, enrollments.sequenceId))
          .where(
            and(
              eq(enrollments.status, "active"),
              eq(sequences.status, "active"),
              lte(enrollments.nextSendAt, now),
            ),
          )
          .orderBy(asc(enrollments.nextSendAt))
          .limit(1)
          .for("update", { of: enrollments, skipLocked: true });
        if (!due) return { kind: "none", events: [] };
        return this.handle(tx, scope, due.e, due.s, now);
      },
    );
    for (const event of outcome.events) await this.events.emit(scope, event);
    return outcome.kind;
  }

  /**
   * ORBYT_NEW_TENANT_DAILY_LIMIT (default 0 = off): total emails a workspace younger than
   * ORBYT_NEW_TENANT_DAYS (default 7) may send per 24h, across all its mailboxes.
   */
  private async newTenantCapped(tx: Tx, scope: Scope, now: Date) {
    const limit = Number(process.env.ORBYT_NEW_TENANT_DAILY_LIMIT ?? 0);
    if (!limit) return false;
    const days = Number(process.env.ORBYT_NEW_TENANT_DAYS || 7); // (|| not ??: compose passes unset variables as "")
    const [ws] = await this.dbs.db
      .select({ createdAt: workspaces.createdAt })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId));
    if (!ws || now.getTime() - ws.createdAt.getTime() > days * 24 * HOUR)
      return false;
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.direction, "out"),
          gte(messages.at, new Date(now.getTime() - 24 * HOUR)),
        ),
      );
    return n >= limit;
  }

  private sentSince(tx: Tx, mailboxId: string, since: Date) {
    return tx
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, mailboxId),
          eq(messages.direction, "out"),
          gte(messages.at, since),
        ),
      )
      .then((r) => r[0]?.n ?? 0);
  }

  private async handle(
    tx: Tx,
    scope: Scope,
    e: Enrollment,
    s: Sequence,
    now: Date,
  ): Promise<Outcome> {
    const events: DomainEvent[] = [];
    const update = (set: Partial<typeof enrollments.$inferInsert>) =>
      tx.update(enrollments).set(set).where(eq(enrollments.id, e.id));
    const skipped = (): Outcome => ({ kind: "skipped", events });

    const [contact] = await tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, e.contactId));
    if (!contact) {
      await update({
        status: "error",
        lastError: "Contact no longer exists",
        nextSendAt: null,
      });
      return skipped();
    }

    const [suppressed] = await tx
      .select()
      .from(suppressions)
      .where(eq(suppressions.email, contact.email));
    if (suppressed) {
      await update({
        status:
          suppressed.reason === "hard_bounce" ? "bounced" : "unsubscribed",
        nextSendAt: null,
      });
      return skipped();
    }

    const window: SendWindow = {
      timezone: s.timezone,
      startHour: s.windowStartHour,
      endHour: s.windowEndHour,
      days: s.sendDays,
    };
    if (!inWindow(now, window)) {
      await update({ nextSendAt: nextWindowStart(now, window) });
      return skipped();
    }

    const steps = await tx
      .select()
      .from(sequenceSteps)
      .where(eq(sequenceSteps.sequenceId, s.id))
      .orderBy(asc(sequenceSteps.position));
    const step = steps[e.currentStep];
    if (!step) {
      await update({ status: "completed", nextSendAt: null });
      return skipped();
    }

    // Abuse control for hosted/shared installs: brand-new workspaces get a low total daily cap.
    if (await this.newTenantCapped(tx, scope, now)) {
      await update({ nextSendAt: new Date(now.getTime() + 15 * 60_000) });
      return skipped();
    }

    // Pick a mailbox: sticky once chosen, otherwise the least-used active one with capacity left.
    const candidates = e.mailboxId ? [e.mailboxId] : s.mailboxIds;
    const boxes = candidates.length
      ? await tx
          .select()
          .from(mailboxes)
          .where(
            and(
              inArray(mailboxes.id, candidates),
              eq(mailboxes.status, "active"),
            ),
          )
      : [];
    let mailbox: MailboxRow | undefined;
    let lowest = Infinity;
    for (const b of boxes) {
      const day = await this.sentSince(
        tx,
        b.id,
        new Date(now.getTime() - 24 * HOUR),
      );
      const hour = await this.sentSince(
        tx,
        b.id,
        new Date(now.getTime() - HOUR),
      );
      if (day >= effectiveDailyLimit(b, now) || hour >= b.hourlyLimit) continue;
      if (day < lowest) {
        mailbox = b;
        lowest = day;
      }
    }
    if (!mailbox) {
      await update({ nextSendAt: new Date(now.getTime() + 15 * 60_000) });
      return skipped();
    }

    // Follow-ups with an empty subject continue the previous thread ("Re: ...").
    const [prev] = e.currentStep
      ? await tx
          .select()
          .from(messages)
          .where(
            and(eq(messages.enrollmentId, e.id), eq(messages.direction, "out")),
          )
          .orderBy(desc(messages.at))
          .limit(1)
      : [];
    const [company] = contact.companyId
      ? await tx
          .select({ name: companies.name })
          .from(companies)
          .where(eq(companies.id, contact.companyId))
      : [];

    const id = uuidv7();
    const messageId = `${id}@${mailbox.email.split("@")[1]}`;
    const vars = mergeVars(contact, company?.name);
    const base = publicBase();
    const link = (payload: Record<string, unknown>) =>
      signToken({
        w: scope.workspaceId,
        m: id,
        e: e.id,
        c: contact.id,
        ...payload,
      });
    const unsubscribeUrl = `${base}/api/u/${link({ k: "u", em: contact.email })}`;
    const continuesThread = !!prev && !step.subject.trim();
    const subject = continuesThread
      ? `Re: ${prev!.subject.replace(/^(re:\s*)+/i, "")}`
      : renderTemplate(step.subject, vars);
    const built = buildEmail({
      subject,
      body: renderTemplate(step.body, vars),
      footer: s.footer,
      unsubscribeUrl,
      rewriteLink: s.trackClicks
        ? (url) => `${base}/api/t/c/${link({ k: "c", u: url })}`
        : undefined,
      openPixelUrl: s.trackOpens
        ? `${base}/api/t/o/${link({ k: "o" })}`
        : undefined,
    });

    try {
      await this.mail.send({
        mailbox,
        to: contact.email,
        subject: built.subject,
        text: built.text,
        html: built.html,
        messageId,
        inReplyTo: continuesThread ? prev!.messageId : undefined,
        references: continuesThread ? [prev!.messageId] : undefined,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
    } catch (err) {
      return this.failed(tx, scope, e, mailbox, err, now, events);
    }

    // Record it: thread, message, event, then move the enrollment to its next step.
    let [conversation] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.enrollmentId, e.id))
      .limit(1);
    if (conversation)
      await tx
        .update(conversations)
        .set({ lastMessageAt: now })
        .where(eq(conversations.id, conversation.id));
    else
      [conversation] = await tx
        .insert(conversations)
        .values({
          workspaceId: scope.workspaceId,
          contactId: contact.id,
          mailboxId: mailbox.id,
          enrollmentId: e.id,
          subject: built.subject,
          lastMessageAt: now,
        })
        .returning();
    await tx.insert(messages).values({
      id,
      workspaceId: scope.workspaceId,
      conversationId: conversation!.id,
      direction: "out",
      mailboxId: mailbox.id,
      messageId,
      inReplyTo: continuesThread ? prev!.messageId : null,
      fromEmail: mailbox.email,
      toEmail: contact.email,
      subject: built.subject,
      bodyText: built.text,
      bodyHtml: built.html,
      enrollmentId: e.id,
      stepId: step.id,
      at: now,
    });
    await tx.insert(emailEvents).values({
      workspaceId: scope.workspaceId,
      type: "sent",
      contactId: contact.id,
      enrollmentId: e.id,
      messageId: id,
      data: { step: e.currentStep, mailboxId: mailbox.id },
    });
    const next = steps[e.currentStep + 1];
    await update({
      currentStep: e.currentStep + 1,
      mailboxId: mailbox.id,
      attempts: 0,
      lastError: null,
      status: next ? "active" : "completed",
      nextSendAt: next
        ? new Date(now.getTime() + jitter(next.delayHours * HOUR))
        : null,
    });
    events.push({
      type: "email.sent",
      contactId: contact.id,
      data: { enrollmentId: e.id, step: e.currentStep, mailboxId: mailbox.id },
    });
    return { kind: "sent", events };
  }

  private async failed(
    tx: Tx,
    scope: Scope,
    e: Enrollment,
    mailbox: MailboxRow,
    err: unknown,
    now: Date,
    events: DomainEvent[],
  ): Promise<Outcome> {
    const error =
      err instanceof SendError
        ? err
        : new SendError((err as Error).message, "transient");
    const update = (set: Partial<typeof enrollments.$inferInsert>) =>
      tx.update(enrollments).set(set).where(eq(enrollments.id, e.id));
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, e.contactId));

    if (error.kind === "permanent") {
      // The server refused this recipient for good: never email them again.
      if (contact)
        await tx
          .insert(suppressions)
          .values({
            workspaceId: scope.workspaceId,
            email: contact.email,
            reason: "hard_bounce",
          })
          .onConflictDoNothing();
      await update({
        status: "bounced",
        lastError: error.message,
        nextSendAt: null,
      });
      await tx.insert(emailEvents).values({
        workspaceId: scope.workspaceId,
        type: "bounce_hard",
        contactId: e.contactId,
        enrollmentId: e.id,
        data: { reason: error.message, source: "smtp" },
      });
      events.push({
        type: "email.bounced",
        contactId: e.contactId,
        data: { enrollmentId: e.id, hard: true },
      });
    } else if (error.kind === "auth") {
      // Our login is broken: stop using the mailbox until someone fixes it, keep the enrollment.
      await tx
        .update(mailboxes)
        .set({ status: "error", lastError: error.message })
        .where(eq(mailboxes.id, mailbox.id));
      await update({
        nextSendAt: new Date(now.getTime() + 15 * 60_000),
        lastError: error.message,
      });
    } else {
      const attempts = e.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await update({
          status: "error",
          attempts,
          lastError: error.message,
          nextSendAt: null,
        });
        await tx.insert(emailEvents).values({
          workspaceId: scope.workspaceId,
          type: "failed",
          contactId: e.contactId,
          enrollmentId: e.id,
          data: { reason: error.message },
        });
      } else {
        const backoffMinutes = Math.min(5 * 2 ** (attempts - 1), 360);
        await update({
          attempts,
          lastError: error.message,
          nextSendAt: new Date(now.getTime() + backoffMinutes * 60_000),
        });
      }
    }
    return { kind: "skipped", events };
  }
}
