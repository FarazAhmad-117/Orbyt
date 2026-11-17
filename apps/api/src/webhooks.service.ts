import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { eq, uuidv7, webhooks } from "@orbyt/db";
import { DbService } from "./db.service";
import { EventsService, type DomainEvent } from "./events.service";
import type { Scope } from "./scope";
import { assertPublicUrl } from "./ssrf";

/**
 * Signature scheme (document this for receivers): header `x-orbyt-signature: t=<unix>,v1=<hex>`
 * where hex = HMAC-SHA256(secret, `${t}.${rawBody}`). Receivers should reject old timestamps.
 */
export function signWebhook(secret: string, timestamp: number, body: string) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  attempts: number;
  error?: string;
}

/**
 * POST a signed JSON payload, retrying network errors and 5xx/429 (delays: base, base*4).
 * shortcut: retries run in-process; they are lost on restart. Move to the BullMQ queue (Phase 3)
 * for durable, observable delivery.
 */
export async function deliverWebhook(
  hook: { url: string; secret: string },
  payload: { type: string } & Record<string, unknown>,
  attempts = 3,
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const base = Number(process.env.WEBHOOK_RETRY_BASE_MS ?? 500);
  let last: DeliveryResult = { ok: false, attempts: 0 };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const url = await assertPublicUrl(hook.url);
      const ts = Math.floor(Date.now() / 1000);
      const res = await fetch(url, {
        method: "POST",
        redirect: "manual", // a redirect could point at an internal address
        signal: AbortSignal.timeout(5000),
        headers: {
          "content-type": "application/json",
          "user-agent": "Orbyt-Webhooks/1",
          "x-orbyt-event": payload.type,
          "x-orbyt-signature": `t=${ts},v1=${signWebhook(hook.secret, ts, body)}`,
        },
        body,
      });
      last = { ok: res.ok, status: res.status, attempts: attempt };
      if (res.ok) return last;
      if (res.status < 500 && res.status !== 429) return last; // client error: retrying won't help
    } catch (err) {
      last = { ok: false, attempts: attempt, error: (err as Error).message };
      if (/private|Invalid URL|http\(s\)/.test(last.error!)) return last; // SSRF/URL: never retry
    }
    if (attempt < attempts)
      await new Promise((r) => setTimeout(r, base * 4 ** (attempt - 1)));
  }
  return last;
}

export function eventPayload(scope: Scope, event: DomainEvent) {
  return {
    id: uuidv7(),
    type: event.type,
    workspaceId: scope.workspaceId,
    createdAt: new Date().toISOString(),
    contactId: event.contactId ?? null,
    dealId: event.dealId ?? null,
    data: event.data ?? {},
  };
}

@Injectable()
export class WebhooksService {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EventsService) events: EventsService,
  ) {
    events.subscribe((scope, event) => this.dispatch(scope, event));
  }

  private async dispatch(scope: Scope, event: DomainEvent) {
    const hooks = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(webhooks).where(eq(webhooks.active, true)),
    );
    const matching = hooks.filter(
      (h) => h.events.includes("*") || h.events.includes(event.type),
    );
    if (matching.length === 0) return;
    const payload = eventPayload(scope, event);
    await Promise.allSettled(matching.map((h) => deliverWebhook(h, payload)));
  }
}
