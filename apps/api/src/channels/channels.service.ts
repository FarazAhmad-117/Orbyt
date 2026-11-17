import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  channelAccounts,
  contacts,
  conversations,
  desc,
  eq,
  messages,
  sql,
  suppressions,
  uuidv7,
  type Tx,
} from "@orbyt/db";
import { DbService } from "../db.service";
import { decryptJson } from "../email/secrets";
import { publicBase } from "../email/scheduler.service";
import { EventsService } from "../events.service";
import { systemScope, type Scope } from "../scope";
import {
  ChannelError,
  START_WORDS,
  STOP_WORDS,
  normalizePhone,
  retellCall,
  twilioSend,
  verifyTwilioSignature,
} from "./providers";

export type Account = typeof channelAccounts.$inferSelect;
export type ChannelKind = "sms" | "whatsapp" | "voice";
const kindOf = (a: Account): ChannelKind =>
  a.type === "twilio_sms"
    ? "sms"
    : a.type === "twilio_whatsapp"
      ? "whatsapp"
      : "voice";
const optOutKey = (phone: string) => `tel:${phone}`;

interface TwilioCfg {
  accountSid: string;
  authToken: string;
}
interface RetellCfg {
  apiKey: string;
}
export interface RetellEvent {
  event?: string;
  call?: {
    call_id?: string;
    direction?: "inbound" | "outbound";
    from_number?: string;
    to_number?: string;
    transcript?: string;
    call_analysis?: { call_summary?: string };
  };
}

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /** Where the provider must POST inbound events (must match what is configured at the provider). */
  webhookUrl(account: Pick<Account, "type" | "webhookToken">) {
    const kind = account.type === "retell" ? "retell" : "twilio";
    return `${publicBase()}/api/channels/${kind}/${account.webhookToken}`;
  }

  private async load(scope: Scope, id: string): Promise<Account> {
    const [a] = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(channelAccounts).where(eq(channelAccounts.id, id)),
    );
    if (!a) throw new NotFoundException("Channel not found");
    return a;
  }

  /** Finds (or starts) the conversation for a number on one channel account, linking a CRM contact by phone. */
  private async conversationFor(
    tx: Tx,
    scope: Scope,
    account: Account,
    phone: string,
    subject: string,
  ) {
    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        sql`regexp_replace(${contacts.phone}, '[^0-9+]', '', 'g') = ${phone}`,
      )
      .limit(1);
    const [existing] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.channelAccountId, account.id),
          contact
            ? eq(conversations.contactId, contact.id)
            : eq(conversations.subject, phone),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1);
    if (existing) return { conv: existing, contactId: contact?.id ?? null };
    const [conv] = await tx
      .insert(conversations)
      .values({
        workspaceId: scope.workspaceId,
        contactId: contact?.id ?? null,
        channel: kindOf(account),
        channelAccountId: account.id,
        subject: contact ? subject : phone,
      })
      .returning();
    return { conv: conv!, contactId: contact?.id ?? null };
  }

  private async record(
    tx: Tx,
    scope: Scope,
    account: Account,
    phone: string,
    dir: "in" | "out",
    providerId: string,
    text: string,
    at = new Date(),
  ) {
    // Providers retry webhooks: the same provider id must not create a second message.
    const dup = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.messageId, providerId),
          eq(messages.channel, kindOf(account)),
        ),
      );
    if (dup.length) return null;
    const { conv, contactId } = await this.conversationFor(
      tx,
      scope,
      account,
      phone,
      `${kindOf(account).toUpperCase()} with ${phone}`,
    );
    const ours = account.address.replace(/^whatsapp:/i, "");
    await tx.insert(messages).values({
      workspaceId: scope.workspaceId,
      conversationId: conv.id,
      direction: dir,
      channel: kindOf(account),
      messageId: providerId,
      fromEmail: dir === "in" ? phone : ours,
      toEmail: dir === "in" ? ours : phone,
      subject: conv.subject,
      bodyText: text,
      at,
    });
    await tx
      .update(conversations)
      .set({
        lastMessageAt: at,
        status: "open",
        ...(dir === "in" ? { hasUnread: true } : { hasUnread: false }),
      })
      .where(eq(conversations.id, conv.id));
    return { conversationId: conv.id, contactId };
  }

  // ---- outbound ----

  async send(scope: Scope, accountId: string, toRaw: string, body: string) {
    const account = await this.load(scope, accountId);
    if (account.type === "retell")
      throw new BadRequestException("This channel makes calls; use /call");
    const to = normalizePhone(toRaw);
    const [blocked] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, optOutKey(to))),
    );
    if (blocked)
      throw new BadRequestException(
        `${to} has opted out of messages (they replied STOP)`,
      );
    const cfg = decryptJson<TwilioCfg>(account.configEnc);
    const wa = account.type === "twilio_whatsapp";
    let sid: string;
    try {
      ({ sid } = await twilioSend(
        cfg,
        wa
          ? `whatsapp:${account.address.replace(/^whatsapp:/i, "")}`
          : account.address,
        wa ? `whatsapp:${to}` : to,
        body,
      ));
    } catch (err) {
      if (err instanceof ChannelError)
        throw new BadGatewayException(err.message);
      throw err;
    }
    const saved = await this.dbs.inWorkspace(scope, (tx) =>
      this.record(tx, scope, account, to, "out", sid, body),
    );
    await this.events.emit(scope, {
      type: `${kindOf(account)}.sent`,
      contactId: saved?.contactId,
      data: { to, sid },
    });
    return { sid, to, conversationId: saved?.conversationId ?? null };
  }

  /** Reply inside an existing SMS/WhatsApp conversation (used by the inbox). */
  async reply(scope: Scope, conversationId: string, text: string) {
    const target = await this.dbs.inWorkspace(scope, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      if (!conv?.channelAccountId)
        throw new BadRequestException(
          "This conversation has no channel to reply on",
        );
      const [last] = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.direction, "in"),
          ),
        )
        .orderBy(desc(messages.at))
        .limit(1);
      const to = last?.fromEmail ?? conv.subject;
      return { accountId: conv.channelAccountId, to };
    });
    return this.send(scope, target.accountId, target.to, text);
  }

  async call(
    scope: Scope,
    accountId: string,
    toRaw: string,
    opts: { agentId?: string; contactId?: string | null } = {},
  ) {
    const account = await this.load(scope, accountId);
    if (account.type !== "retell")
      throw new BadRequestException("This channel sends messages; use /send");
    const to = normalizePhone(toRaw);
    const cfg = decryptJson<RetellCfg>(account.configEnc);
    try {
      const { callId } = await retellCall(cfg, account.address, to, {
        agentId: opts.agentId,
        metadata: {
          workspaceId: scope.workspaceId,
          contactId: opts.contactId ?? null,
        },
      });
      await this.events.emit(scope, {
        type: "call.started",
        contactId: opts.contactId,
        data: { to, callId },
      });
      return { callId, to };
    } catch (err) {
      if (err instanceof ChannelError)
        throw new BadGatewayException(err.message);
      throw err;
    }
  }

  // ---- inbound (public webhooks) ----

  private async byToken(
    token: string,
    type: "twilio" | "retell",
  ): Promise<Account> {
    // System lookup on the bare connection (channel_accounts is RLS-enabled, not forced, for this).
    const [a] = await this.dbs.db
      .select()
      .from(channelAccounts)
      .where(eq(channelAccounts.webhookToken, token));
    if (!a || (type === "twilio") === (a.type === "retell"))
      throw new NotFoundException();
    return a;
  }

  async receiveTwilio(
    token: string,
    params: Record<string, string>,
    signature: string | undefined,
  ) {
    const account = await this.byToken(token, "twilio");
    const cfg = decryptJson<TwilioCfg>(account.configEnc);
    if (
      !verifyTwilioSignature(
        cfg.authToken,
        this.webhookUrl(account),
        params,
        signature,
      )
    )
      return false;

    const from = normalizePhone(params.From ?? "");
    const text = (params.Body ?? "").trim();
    const sid = params.MessageSid || params.SmsSid || uuidv7();
    const scope = systemScope(account.workspaceId);
    const word = text.toUpperCase();

    const saved = await this.dbs.inWorkspace(scope, async (tx) => {
      // Carrier rules: STOP must stop, START resumes. We keep the opt-out list ourselves.
      if (STOP_WORDS.has(word))
        await tx
          .insert(suppressions)
          .values({
            workspaceId: scope.workspaceId,
            email: optOutKey(from),
            reason: "unsubscribe",
          })
          .onConflictDoNothing();
      else if (START_WORDS.has(word))
        await tx
          .delete(suppressions)
          .where(eq(suppressions.email, optOutKey(from)));
      return this.record(tx, scope, account, from, "in", sid, text);
    });
    if (saved) {
      const kind = kindOf(account);
      await this.events.emit(scope, {
        type: `${kind}.received`,
        contactId: saved.contactId,
        data: { from, text: text.slice(0, 500) },
      });
      if (STOP_WORDS.has(word))
        await this.events.emit(scope, {
          type: "contact.unsubscribed",
          contactId: saved.contactId,
          data: { phone: from },
        });
    }
    return true;
  }

  async receiveRetell(token: string, payload: RetellEvent) {
    const account = await this.byToken(token, "retell");
    const call = payload.call;
    // Transcripts arrive with call_ended / call_analyzed; call_started carries nothing worth storing.
    if (
      !call?.call_id ||
      !["call_ended", "call_analyzed"].includes(payload.event ?? "")
    )
      return;
    const scope = systemScope(account.workspaceId);
    const outbound = call.direction !== "inbound";
    const phone = normalizePhone(
      String(outbound ? call.to_number : call.from_number),
    );
    const summary = call.call_analysis?.call_summary
      ? `Summary: ${call.call_analysis.call_summary}\n\n`
      : "";
    const text = `${summary}${call.transcript ?? "(no transcript)"}`;
    const saved = await this.dbs.inWorkspace(scope, (tx) =>
      this.record(
        tx,
        scope,
        account,
        phone,
        outbound ? "out" : "in",
        String(call.call_id),
        text,
      ),
    );
    if (saved)
      await this.events.emit(scope, {
        type: "call.completed",
        contactId: saved.contactId,
        data: {
          callId: call.call_id,
          phone,
          direction: outbound ? "out" : "in",
        },
      });
  }
}
