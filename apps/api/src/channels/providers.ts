import { createHmac, timingSafeEqual } from "node:crypto";
import { BadRequestException } from "@nestjs/common";

// Provider base URLs come from the operator's environment (never from a workspace), so they are
// not SSRF-checked; they exist so tests and proxies can redirect them.
const twilioBase = () =>
  (process.env.TWILIO_API_BASE ?? "https://api.twilio.com").replace(/\/+$/, "");
const retellBase = () =>
  (process.env.RETELL_API_BASE ?? "https://api.retellai.com").replace(
    /\/+$/,
    "",
  );

export class ChannelError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** E.164-style: "+", then 8-15 digits. Spaces, dashes and brackets are ignored; `whatsapp:` is stripped. */
export function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/^whatsapp:/i, "").replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(cleaned))
    throw new BadRequestException(
      "Use an international phone number such as +14155550123",
    );
  return cleaned;
}

export const STOP_WORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
export const START_WORDS = new Set(["START", "UNSTOP", "YES"]);

/** Twilio's request signature: base64(HMAC-SHA1(authToken, url + sorted "key"+"value" pairs)). */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function twilioSend(
  cfg: { accountSid: string; authToken: string },
  from: string,
  to: string,
  body: string,
): Promise<{ sid: string }> {
  let res: Response;
  try {
    res = await fetch(
      `${twilioBase()}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch (err) {
    throw new ChannelError(
      `Could not reach Twilio: ${(err as Error).message}`,
      0,
    );
  }
  const data = (await res.json().catch(() => ({}))) as {
    sid?: string;
    message?: string;
    code?: number;
  };
  if (!res.ok || !data.sid)
    throw new ChannelError(
      `Twilio answered ${res.status}: ${data.message ?? "unknown error"}${data.code ? ` (code ${data.code})` : ""}`,
      res.status,
    );
  return { sid: data.sid };
}

export async function retellCall(
  cfg: { apiKey: string },
  from: string,
  to: string,
  opts: { agentId?: string; metadata?: Record<string, unknown> } = {},
): Promise<{ callId: string }> {
  let res: Response;
  try {
    res = await fetch(`${retellBase()}/v2/create-phone-call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from_number: from,
        to_number: to,
        ...(opts.agentId ? { override_agent_id: opts.agentId } : {}),
        metadata: opts.metadata ?? {},
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ChannelError(
      `Could not reach Retell: ${(err as Error).message}`,
      0,
    );
  }
  const data = (await res.json().catch(() => ({}))) as {
    call_id?: string;
    message?: string;
  };
  if (!res.ok || !data.call_id)
    throw new ChannelError(
      `Retell answered ${res.status}: ${data.message ?? "unknown error"}`,
      res.status,
    );
  return { callId: data.call_id };
}
