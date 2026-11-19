"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AuditCard,
  BrandingCard,
  ImportCard,
  InvitationsCard,
  PlanCard,
} from "@/components/settings-extras";
import {
  api,
  type AiProvider,
  type AiUsage,
  type Channel,
  type Member,
  type Tag,
} from "@/lib/api";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
}
interface Hook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
}
interface Field {
  id: string;
  key: string;
  label: string;
  type: string;
}

const DEFAULT_MODELS: Record<AiProvider["provider"], string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-5",
  gemini: "gemini-2.5-pro",
  ollama: "llama3.1",
};

// Bring-your-own-key AI: keys are encrypted on the server and never shown again.
function AiCard({ base, workspaceId }: { base: string; workspaceId: string }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: [workspaceId, "ai"] });
  const fail = (e: Error) => toast.error(e.message);
  const [kind, setKind] = useState<AiProvider["provider"]>("anthropic");
  const providers = useQuery({
    queryKey: [workspaceId, "ai", "providers"],
    queryFn: () => api<AiProvider[]>(`${base}/ai/providers`),
  });
  const usage = useQuery({
    queryKey: [workspaceId, "ai", "usage"],
    queryFn: () => api<AiUsage>(`${base}/ai/usage`),
  });

  const add = useMutation({
    mutationFn: (body: object) => api(`${base}/ai/providers`, { body }),
    onSuccess: () => {
      toast.success("Provider added");
      void refresh();
    },
    onError: fail,
  });
  const test = useMutation({
    mutationFn: (id: string) =>
      api<{ reply: string; model: string }>(`${base}/ai/providers/${id}/test`, {
        body: {},
      }),
    onSuccess: (r) => {
      toast.success(`${r.model} answered: ${r.reply}`);
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`${base}/ai/providers/${id}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) =>
      api(`${base}/ai/providers/${id}`, {
        method: "PATCH",
        body: { isDefault: true },
      }),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const setCap = useMutation({
    mutationFn: (cap: number | null) =>
      api(`${base}/ai/settings`, {
        method: "PUT",
        body: { monthlyTokenCap: cap },
      }),
    onSuccess: () => {
      toast.success("Cap saved");
      void refresh();
    },
    onError: fail,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI providers</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          Use your own key to classify replies, draft answers and add AI steps
          to workflows. Anthropic, OpenAI, Gemini, or a self-hosted Ollama.
        </p>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            add.mutate({
              name: String(f.get("name")),
              provider: kind,
              model: String(f.get("model")),
              apiKey: String(f.get("apiKey") ?? "") || undefined,
              baseUrl: String(f.get("baseUrl") ?? "") || undefined,
            });
            e.currentTarget.reset();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="ai-name">Name</Label>
            <Input id="ai-name" name="name" required placeholder="My Claude" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ai-kind">Provider</Label>
            <select
              id="ai-kind"
              className="rounded-md border bg-transparent p-2 text-sm"
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as AiProvider["provider"])
              }
            >
              {Object.keys(DEFAULT_MODELS).map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ai-model">Model</Label>
            <Input
              id="ai-model"
              name="model"
              required
              key={kind}
              defaultValue={DEFAULT_MODELS[kind]}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ai-key">
              API key{kind === "ollama" ? " (optional)" : ""}
            </Label>
            <Input
              id="ai-key"
              name="apiKey"
              type="password"
              autoComplete="off"
              required={kind !== "ollama"}
            />
          </div>
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor="ai-url">Custom endpoint (optional)</Label>
            <Input
              id="ai-url"
              name="baseUrl"
              type="url"
              placeholder="https://… (self-hosted or compatible server)"
            />
          </div>
          <Button
            type="submit"
            className="justify-self-start"
            disabled={add.isPending}
          >
            Add provider
          </Button>
        </form>

        {providers.data?.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{p.name}</span>
            <code className="text-muted-foreground">
              {p.provider} · {p.model}
            </code>
            {p.isDefault ? (
              <span className="rounded-full border px-2 py-0.5 text-xs">
                default
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => makeDefault.mutate(p.id)}
              >
                Make default
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => test.mutate(p.id)}
            >
              Test
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => remove.mutate(p.id)}
            >
              Remove
            </Button>
          </div>
        ))}

        <form
          className="flex flex-wrap items-end gap-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            const v = String(
              new FormData(e.currentTarget).get("cap") ?? "",
            ).trim();
            setCap.mutate(v === "" ? null : Number(v));
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="ai-cap">Monthly token cap (blank = no cap)</Label>
            <Input
              id="ai-cap"
              name="cap"
              type="number"
              min={0}
              key={usage.data?.monthlyTokenCap ?? "none"}
              defaultValue={usage.data?.monthlyTokenCap ?? ""}
              className="w-44"
            />
          </div>
          <Button type="submit" variant="outline">
            Save cap
          </Button>
          {usage.data && (
            <span
              className="text-muted-foreground"
              aria-label="AI usage this month"
            >
              {usage.data.totalTokens.toLocaleString()} tokens used in{" "}
              {usage.data.month}
            </span>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// Who can use this workspace. Adding by email here needs an existing Orbyt account; the Invite card below
// works for people who do not have one yet.
function TeamCard({
  base,
  workspaceId,
}: {
  base: string;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: [workspaceId, "members"] });
  const fail = (e: Error) => toast.error(e.message);
  const members = useQuery({
    queryKey: [workspaceId, "members"],
    queryFn: () => api<Member[]>(`${base}/members`),
  });
  const add = useMutation({
    mutationFn: (body: { email: string; role: string }) =>
      api(`${base}/members`, { body }),
    onSuccess: () => {
      toast.success("Member added");
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      api(`${base}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
    onError: fail,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            add.mutate({
              email: String(f.get("email")),
              role: String(f.get("role")),
            });
            e.currentTarget.reset();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="tm-email">Email of an existing user</Label>
            <Input
              id="tm-email"
              name="email"
              type="email"
              required
              className="w-64"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tm-role">Role</Label>
            <select
              id="tm-role"
              name="role"
              className="rounded-md border bg-transparent p-2 text-sm"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <Button type="submit" disabled={add.isPending}>
            Add
          </Button>
        </form>
        {members.data?.map((m) => (
          <div
            key={m.userId}
            className="flex flex-wrap items-center gap-3 text-sm"
          >
            <span className="font-medium">{m.name}</span>
            <span className="text-muted-foreground">{m.email}</span>
            <span className="rounded-full border px-2 py-0.5 text-xs">
              {m.role}
              {m.via === "organization" ? " · agency" : ""}
            </span>
            {m.via === "workspace" && (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => remove.mutate(m.userId)}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// SMS / WhatsApp (Twilio) and AI voice calls (Retell). Credentials are encrypted server-side.
function ChannelsCard({
  base,
  workspaceId,
}: {
  base: string;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: [workspaceId, "channels"] });
  const fail = (e: Error) => toast.error(e.message);
  const [type, setType] = useState<Channel["type"]>("twilio_sms");
  const channels = useQuery({
    queryKey: [workspaceId, "channels"],
    queryFn: () => api<Channel[]>(`${base}/channels`),
  });
  const add = useMutation({
    mutationFn: (body: object) => api(`${base}/channels`, { body }),
    onSuccess: () => {
      toast.success("Channel connected");
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`${base}/channels/${id}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
    onError: fail,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Messaging &amp; calls</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          Connect Twilio for SMS and WhatsApp, or Retell for AI voice calls.
          After connecting, paste the webhook URL into the provider so replies
          and call results arrive in your Inbox.
        </p>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            add.mutate({
              type,
              name: String(f.get("name")),
              address: String(f.get("address")),
              ...(type === "retell"
                ? { apiKey: String(f.get("apiKey")) }
                : {
                    accountSid: String(f.get("accountSid")),
                    authToken: String(f.get("authToken")),
                  }),
            });
            e.currentTarget.reset();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="ch-type">Type</Label>
            <select
              id="ch-type"
              className="rounded-md border bg-transparent p-2 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value as Channel["type"])}
            >
              <option value="twilio_sms">Twilio SMS</option>
              <option value="twilio_whatsapp">Twilio WhatsApp</option>
              <option value="retell">Retell voice</option>
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ch-name">Name</Label>
            <Input id="ch-name" name="name" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ch-address">Your phone number (+14155550100)</Label>
            <Input
              id="ch-address"
              name="address"
              required
              placeholder="+14155550100"
            />
          </div>
          {type === "retell" ? (
            <div className="grid gap-2">
              <Label htmlFor="ch-key">Retell API key</Label>
              <Input
                id="ch-key"
                name="apiKey"
                type="password"
                required
                autoComplete="off"
              />
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="ch-sid">Twilio Account SID</Label>
                <Input
                  id="ch-sid"
                  name="accountSid"
                  required
                  placeholder="AC…"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ch-token">Twilio Auth Token</Label>
                <Input
                  id="ch-token"
                  name="authToken"
                  type="password"
                  required
                  autoComplete="off"
                />
              </div>
            </>
          )}
          <Button
            type="submit"
            className="justify-self-start"
            disabled={add.isPending}
          >
            Connect
          </Button>
        </form>
        {channels.data?.map((c) => (
          <div key={c.id} className="grid gap-1 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{c.name}</span>
              <code className="text-muted-foreground">
                {c.type} · {c.address}
              </code>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => remove.mutate(c.id)}
              >
                Remove
              </Button>
            </div>
            <code className="break-all text-xs text-muted-foreground">
              Webhook URL: {c.webhookUrl}
            </code>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** A hairline-and-heavy-rule label that groups the cards below it, like a table head. */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 border-b-2 border-ink pb-2 text-[0.72rem] font-bold tracking-[0.08em] text-muted-foreground uppercase font-stretch-semi-condensed">
      {children}
    </p>
  );
}

export default function SettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/api/w/${workspaceId}`;
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: [workspaceId, "settings"] });
  const fail = (e: Error) => toast.error(e.message);
  // Secrets are shown exactly once, right after creation.
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(
    null,
  );

  const keys = useQuery({
    queryKey: [workspaceId, "settings", "keys"],
    queryFn: () => api<ApiKey[]>(`${base}/api-keys`),
  });
  const hooks = useQuery({
    queryKey: [workspaceId, "settings", "hooks"],
    queryFn: () => api<Hook[]>(`${base}/webhooks`),
  });
  const fields = useQuery({
    queryKey: [workspaceId, "settings", "fields"],
    queryFn: () => api<Field[]>(`${base}/custom-fields`),
  });
  const tags = useQuery({
    queryKey: [workspaceId, "settings", "tags"],
    queryFn: () => api<Tag[]>(`${base}/tags`),
  });

  const createKey = useMutation({
    mutationFn: (name: string) =>
      api<{ key: string }>(`${base}/api-keys`, { body: { name } }),
    onSuccess: (r) => {
      setSecret({ label: "API key", value: r.key });
      void refresh();
    },
    onError: fail,
  });
  const del = useMutation({
    mutationFn: (path: string) => api(`${base}/${path}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const createHook = useMutation({
    mutationFn: (body: { url: string; events: string[] }) =>
      api<{ secret: string }>(`${base}/webhooks`, { body }),
    onSuccess: (r) => {
      setSecret({ label: "Webhook signing secret", value: r.secret });
      void refresh();
    },
    onError: fail,
  });
  const testHook = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; status?: number; error?: string }>(
        `${base}/webhooks/${id}/test`,
        { body: {} },
      ),
    onSuccess: (r) =>
      r.ok
        ? toast.success(`Receiver answered ${r.status}`)
        : toast.error(r.error ?? `Receiver answered ${r.status}`),
    onError: fail,
  });
  const createField = useMutation({
    mutationFn: (body: object) => api(`${base}/custom-fields`, { body }),
    onSuccess: () => void refresh(),
    onError: fail,
  });

  return (
    <div className="grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      {secret && (
        <div role="status" className="rounded-md bg-ink p-4 text-sm text-white">
          <p className="font-medium">
            {secret.label} — copy it now, it will not be shown again.
          </p>
          <code
            className="mt-2 block rounded bg-black/30 p-2 font-mono break-all text-board-amber"
            data-testid="secret"
          >
            {secret.value}
          </code>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white"
            onClick={() => setSecret(null)}
          >
            Done
          </Button>
        </div>
      )}

      <GroupLabel>Connect and extend</GroupLabel>
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const el = e.currentTarget.elements.namedItem(
                "name",
              ) as HTMLInputElement;
              createKey.mutate(el.value);
              el.value = "";
            }}
          >
            <Input
              name="name"
              aria-label="API key name"
              placeholder="Key name"
              required
            />
            <Button type="submit">Create key</Button>
          </form>
          {keys.data?.map((k) => (
            <div key={k.id} className="flex items-center gap-3 text-sm">
              <span className="font-medium">{k.name}</span>
              <code className="text-muted-foreground">{k.prefix}…</code>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => del.mutate(`api-keys/${k.id}`)}
              >
                Revoke
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Webhooks</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <form
            className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              createHook.mutate({
                url: String(f.get("url")),
                events: String(f.get("events") || "*")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
              e.currentTarget.reset();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="wh-url">URL</Label>
              <Input
                id="wh-url"
                name="url"
                type="url"
                required
                placeholder="https://example.com/hook"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wh-events">Events (comma separated, or *)</Label>
              <Input
                id="wh-events"
                name="events"
                placeholder="contact.created, deal.won"
              />
            </div>
            <Button type="submit">Add webhook</Button>
          </form>
          {hooks.data?.map((h) => (
            <div
              key={h.id}
              className="flex flex-wrap items-center gap-3 text-sm"
            >
              <span className="break-all">{h.url}</span>
              <code className="text-muted-foreground">
                {h.events.join(", ")}
              </code>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => testHook.mutate(h.id)}
              >
                Send test
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => del.mutate(`webhooks/${h.id}`)}
              >
                Delete
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Custom fields</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <form
            className="grid gap-2 sm:grid-cols-4 sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const options = String(f.get("options") ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              createField.mutate({
                key: String(f.get("key")),
                label: String(f.get("label")),
                type: String(f.get("type")),
                ...(options.length ? { options } : {}),
              });
              e.currentTarget.reset();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="cf-key">Key</Label>
              <Input
                id="cf-key"
                name="key"
                required
                pattern="[a-z][a-z0-9_]*"
                placeholder="plan"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cf-label">Label</Label>
              <Input id="cf-label" name="label" required placeholder="Plan" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cf-type">Type</Label>
              <select
                id="cf-type"
                name="type"
                className="rounded-md border bg-transparent p-2 text-sm"
              >
                {["text", "number", "date", "boolean", "select"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cf-options">Options (select)</Label>
              <Input id="cf-options" name="options" placeholder="free, pro" />
            </div>
            <Button
              type="submit"
              className="sm:col-span-4 sm:justify-self-start"
            >
              Add field
            </Button>
          </form>
          {fields.data?.map((f) => (
            <div key={f.id} className="flex items-center gap-3 text-sm">
              <span className="font-medium">{f.label}</span>
              <code className="text-muted-foreground">
                {f.key} · {f.type}
              </code>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => del.mutate(`custom-fields/${f.id}`)}
              >
                Delete
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <GroupLabel>People and plan</GroupLabel>
      <TeamCard base={base} workspaceId={workspaceId} />
      <InvitationsCard workspaceId={workspaceId} />
      <PlanCard workspaceId={workspaceId} />
      <BrandingCard workspaceId={workspaceId} />
      <AuditCard workspaceId={workspaceId} />
      <GroupLabel>Providers and channels</GroupLabel>
      <AiCard base={base} workspaceId={workspaceId} />
      <ChannelsCard base={base} workspaceId={workspaceId} />
      <GroupLabel>Your data</GroupLabel>
      <ImportCard workspaceId={workspaceId} />

      <Card>
        <CardHeader>
          <CardTitle>Tags</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {tags.data?.length === 0 && (
            <span className="text-sm text-muted-foreground">
              No tags yet. Add them on a contact.
            </span>
          )}
          {tags.data?.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm"
            >
              {t.name}
              <button
                aria-label={`Delete tag ${t.name}`}
                onClick={() => del.mutate(`tags/${t.id}`)}
              >
                ×
              </button>
            </span>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
