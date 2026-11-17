import { createAuthClient } from "better-auth/react";

// Talks to /api/auth/* on this origin (proxied to the API).
export const authClient = createAuthClient();

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: { path: string; message: string }[],
    public body?: unknown,
  ) {
    super(message);
  }
}

/** JSON fetch against the same-origin API. Throws ApiError with the server's message. */
export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; raw?: string; type?: string } = {},
): Promise<T> {
  const res = await fetch(path, {
    method:
      init.method ??
      (init.body !== undefined || init.raw !== undefined ? "POST" : "GET"),
    credentials: "same-origin",
    headers:
      init.body !== undefined
        ? { "content-type": "application/json" }
        : init.raw !== undefined
          ? { "content-type": init.type ?? "text/csv" }
          : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : init.raw,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && "message" in data
        ? String((data as { message: unknown }).message)
        : null) ?? res.statusText;
    throw new ApiError(
      res.status,
      message,
      (data as { issues?: { path: string; message: string }[] } | null)?.issues,
      data,
    );
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface Workspace {
  id: string;
  name: string;
  organizationId: string;
}
export interface Tag {
  id: string;
  name: string;
  color: string | null;
}
export interface Contact {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  source: string | null;
  companyId: string | null;
  customFields: Record<string, unknown>;
  tags: Tag[];
  createdAt: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface Stage {
  id: string;
  name: string;
  position: number;
}
export interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
}
export interface Deal {
  id: string;
  pipelineId: string;
  stageId: string;
  title: string;
  valueCents: number;
  currency: string;
  status: "open" | "won" | "lost";
  contactId: string | null;
}
export interface Task {
  id: string;
  title: string;
  dueAt: string | null;
  doneAt: string | null;
  contactId: string | null;
}
export interface Note {
  id: string;
  body: string;
  createdAt: string;
}
export interface Activity {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface Mailbox {
  id: string;
  email: string;
  displayName: string | null;
  smtpHost: string;
  imapHost: string;
  dailyLimit: number;
  hourlyLimit: number;
  status: "active" | "paused" | "error";
  lastError: string | null;
  lastSyncAt: string | null;
}
export interface SequenceStep {
  id?: string;
  position?: number;
  delayHours: number;
  subject: string;
  body: string;
}
export interface Sequence {
  id: string;
  name: string;
  status: "draft" | "active" | "paused";
  mailboxIds: string[];
  timezone: string;
  windowStartHour: number;
  windowEndHour: number;
  sendDays: number[];
  stopOnReply: boolean;
  trackOpens: boolean;
  trackClicks: boolean;
  footer: string | null;
  steps: SequenceStep[];
}
export interface Conversation {
  id: string;
  subject: string;
  status: "open" | "closed";
  hasUnread: boolean;
  lastMessageAt: string;
  contactEmail: string | null;
  contactName: string | null;
  lastDirection: "in" | "out" | null;
  snippet: string;
  aiLabel: string | null;
  aiSummary: string | null;
  channel: "email" | "sms" | "whatsapp" | "voice";
}
export interface Member {
  userId: string;
  name: string;
  email: string;
  role: "admin" | "member";
  via: "workspace" | "organization";
}
export interface Channel {
  id: string;
  type: "twilio_sms" | "twilio_whatsapp" | "retell";
  name: string;
  address: string;
  webhookUrl: string;
}
export interface AiProvider {
  id: string;
  name: string;
  provider: "anthropic" | "openai" | "gemini" | "ollama";
  model: string;
  baseUrl: string | null;
  isDefault: boolean;
  hasKey: boolean;
}
export interface AiUsage {
  month: string;
  totalTokens: number;
  monthlyTokenCap: number | null;
}
export interface MailMessage {
  id: string;
  direction: "in" | "out";
  fromEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string | null;
  at: string;
}
export interface Check {
  name: string;
  status: "pass" | "warn" | "fail" | "info";
  detail: string;
  record?: string;
}

export const money = (cents: number, currency = "USD") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    cents / 100,
  );
