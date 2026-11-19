"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api, type Check, type Mailbox } from "@/lib/api";

const STATUS_STYLE: Record<Check["status"], string> = {
  pass: "text-ok",
  warn: "text-warn",
  fail: "text-destructive",
  info: "text-muted-foreground",
};

function Server({
  prefix,
  defaultPort,
  title,
}: {
  prefix: "smtp" | "imap";
  defaultPort: number;
  title: string;
}) {
  return (
    <fieldset className="grid gap-3 rounded-md border p-4 sm:grid-cols-2">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      <div className="grid gap-2">
        <Label htmlFor={`${prefix}-host`}>{title} host</Label>
        <Input
          id={`${prefix}-host`}
          name={`${prefix}Host`}
          required
          placeholder={`${prefix}.example.com`}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${prefix}-port`}>{title} port</Label>
        <Input
          id={`${prefix}-port`}
          name={`${prefix}Port`}
          type="number"
          required
          defaultValue={defaultPort}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${prefix}-user`}>{title} username</Label>
        <Input
          id={`${prefix}-user`}
          name={`${prefix}User`}
          placeholder="defaults to the email address"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${prefix}-pass`}>{title} password</Label>
        <Input
          id={`${prefix}-pass`}
          name={`${prefix}Pass`}
          type="password"
          required
          autoComplete="off"
        />
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          name={`${prefix}Secure`}
          defaultChecked={prefix === "imap"}
        />
        Use TLS from the start (implicit TLS, usually ports 465 / 993)
      </label>
    </fieldset>
  );
}

export default function MailboxesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/api/w/${workspaceId}`;
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: [workspaceId, "mailboxes"] });
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [checks, setChecks] = useState<{
    domain: string;
    items: Check[];
  } | null>(null);

  const boxes = useQuery({
    queryKey: [workspaceId, "mailboxes"],
    queryFn: () => api<Mailbox[]>(`${base}/mailboxes`),
  });

  // "Connect Google / Microsoft": only offered when this server has the provider's credentials.
  const providers = useQuery({
    queryKey: [workspaceId, "mailbox-oauth"],
    queryFn: () =>
      api<{ provider: "google" | "microsoft"; configured: boolean }[]>(
        `${base}/mailboxes/oauth/providers`,
      ),
    retry: false,
  });
  const connectOAuth = useMutation({
    mutationFn: (provider: "google" | "microsoft") =>
      api<{ url: string }>(`${base}/mailboxes/oauth/start`, {
        body: { provider },
      }),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
    onError: (e: Error) => toast.error(e.message),
  });
  // The provider sends the browser back here with the result in the query string.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const connected = q.get("connected");
    const error = q.get("error");
    if (!connected && !error) return;
    if (connected) toast.success(`Connected ${connected}`);
    else toast.error(error!);
    window.history.replaceState(null, "", window.location.pathname);
    void qc.invalidateQueries({ queryKey: [workspaceId, "mailboxes"] });
  }, [qc, workspaceId]);

  const create = useMutation({
    mutationFn: (body: object) => api(`${base}/mailboxes`, { body }),
    onSuccess: () => {
      toast.success("Mailbox connected");
      setAdding(false);
      setFormError(null);
      void refresh();
    },
    onError: (e: Error) => {
      const body =
        e instanceof ApiError
          ? (e.body as
              { smtp?: string | null; imap?: string | null } | undefined)
          : undefined;
      setFormError(
        [
          e.message,
          body?.smtp && `SMTP: ${body.smtp}`,
          body?.imap && `IMAP: ${body.imap}`,
        ]
          .filter(Boolean)
          .join(" — "),
      );
    },
  });
  const test = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; smtp: string | null; imap: string | null }>(
        `${base}/mailboxes/${id}/test`,
        { body: {} },
      ),
    onSuccess: (r) => {
      if (r.ok) toast.success("Both logins work");
      else toast.error(r.smtp ?? r.imap ?? "Connection failed");
      void refresh();
    },
  });
  const setStatus = useMutation({
    mutationFn: (v: {
      id: string;
      status?: "active" | "paused";
      warmup?: boolean;
    }) =>
      api(`${base}/mailboxes/${v.id}`, {
        method: "PATCH",
        body: { status: v.status, warmup: v.warmup },
      }),
    onSuccess: () => void refresh(),
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`${base}/mailboxes/${id}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
  });
  const check = useMutation({
    mutationFn: (v: { domain: string; selector: string }) =>
      api<{ checks: Check[] }>(
        `${base}/deliverability?domain=${encodeURIComponent(v.domain)}${v.selector ? `&selector=${encodeURIComponent(v.selector)}` : ""}`,
      ),
    onSuccess: (r, v) => setChecks({ domain: v.domain, items: r.checks }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="grid max-w-3xl gap-6">
      <div className="flex items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold">Mailboxes</h1>
        {providers.data
          ?.filter((p) => p.configured)
          .map((p) => (
            <Button
              key={p.provider}
              variant="outline"
              disabled={connectOAuth.isPending}
              onClick={() => connectOAuth.mutate(p.provider)}
            >
              Connect {p.provider === "google" ? "Google" : "Microsoft"}
            </Button>
          ))}
        <Button
          variant={adding ? "outline" : "signal"}
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? "Cancel" : "Connect mailbox"}
        </Button>
      </div>

      {adding && (
        <Card>
          <CardHeader>
            <CardTitle>Connect a mailbox</CardTitle>
            <CardDescription>
              Use an SMTP + IMAP account (Google Workspace and Microsoft 365
              work with an app password). Credentials are stored encrypted and
              never shown again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const email = String(f.get("email"));
                const end = (p: "smtp" | "imap") => ({
                  host: String(f.get(`${p}Host`)),
                  port: Number(f.get(`${p}Port`)),
                  secure: f.get(`${p}Secure`) === "on",
                  user: String(f.get(`${p}User`) || email),
                  password: String(f.get(`${p}Pass`)),
                });
                create.mutate({
                  email,
                  displayName: String(f.get("displayName") ?? "") || null,
                  smtp: end("smtp"),
                  imap: end("imap"),
                  dailyLimit: Number(f.get("dailyLimit")),
                  hourlyLimit: Number(f.get("hourlyLimit")),
                });
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="mb-email">Email address</Label>
                  <Input id="mb-email" name="email" type="email" required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mb-name">Sender name</Label>
                  <Input
                    id="mb-name"
                    name="displayName"
                    placeholder="Alex from Acme"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mb-daily">Daily send limit</Label>
                  <Input
                    id="mb-daily"
                    name="dailyLimit"
                    type="number"
                    min={1}
                    max={2000}
                    defaultValue={30}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mb-hourly">Hourly send limit</Label>
                  <Input
                    id="mb-hourly"
                    name="hourlyLimit"
                    type="number"
                    min={1}
                    max={500}
                    defaultValue={10}
                  />
                </div>
              </div>
              <Server prefix="smtp" defaultPort={587} title="SMTP" />
              <Server prefix="imap" defaultPort={993} title="IMAP" />
              {formError && (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              )}
              <Button
                type="submit"
                disabled={create.isPending}
                className="justify-self-start"
              >
                {create.isPending ? "Testing connection…" : "Test and save"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3">
        {boxes.data?.length === 0 && (
          <EmptyState
            title="No mailboxes yet."
            actions={
              <Button onClick={() => setAdding(true)}>Connect a mailbox</Button>
            }
          >
            Connect the mailbox you send from. Credentials are stored encrypted
            and never shown again.
          </EmptyState>
        )}
        {boxes.data?.map((m) => (
          <Card key={m.id}>
            <CardContent className="flex flex-wrap items-center gap-3 pt-6 text-sm">
              <div className="mr-auto">
                <div className="font-medium">{m.email}</div>
                <div className="text-muted-foreground">
                  {m.dailyLimit}/day · {m.hourlyLimit}/hour · {m.smtpHost}
                  {m.authType !== "password" ? ` · ${m.authType} login` : ""}
                  {m.warmupEnabled ? " · warming up" : ""}
                </div>
                {m.lastError && (
                  <div className="text-destructive">{m.lastError}</div>
                )}
              </div>
              <Badge variant={m.status === "active" ? "secondary" : "default"}>
                {m.status}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={() => test.mutate(m.id)}
              >
                Test
              </Button>
              <Button
                size="sm"
                variant="outline"
                title="Ramp the daily limit up gradually so a new mailbox is not flagged"
                onClick={() =>
                  setStatus.mutate({ id: m.id, warmup: !m.warmupEnabled })
                }
              >
                {m.warmupEnabled ? "Stop warm-up" : "Warm up"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setStatus.mutate({
                    id: m.id,
                    status: m.status === "paused" ? "active" : "paused",
                  })
                }
              >
                {m.status === "paused" ? "Resume" : "Pause"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (confirm(`Remove ${m.email}?`)) remove.mutate(m.id);
                }}
              >
                Remove
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Deliverability check</CardTitle>
          <CardDescription>
            Checks the DNS records receivers look at (SPF, DKIM, DMARC, MX,
            blocklist). Passing does not guarantee inbox placement.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              check.mutate({
                domain: String(f.get("domain")).trim(),
                selector: String(f.get("selector") ?? "").trim(),
              });
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="dc-domain">Domain</Label>
              <Input
                id="dc-domain"
                name="domain"
                required
                placeholder="example.com"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dc-selector">DKIM selector (optional)</Label>
              <Input id="dc-selector" name="selector" placeholder="google" />
            </div>
            <Button type="submit" disabled={check.isPending}>
              Check
            </Button>
          </form>
          {checks && (
            <ul
              className="grid gap-2 text-sm"
              aria-label={`Results for ${checks.domain}`}
            >
              {checks.items.map((c) => (
                <li key={c.name} className="grid gap-1 rounded-md border p-3">
                  <span className={`font-medium ${STATUS_STYLE[c.status]}`}>
                    {c.name}: {c.status}
                  </span>
                  <span>{c.detail}</span>
                  {c.record && (
                    <code className="break-all text-xs text-muted-foreground">
                      {c.record}
                    </code>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
