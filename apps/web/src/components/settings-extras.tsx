"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Entitlements } from "@/lib/api";

const fail = (e: Error) => toast.error(e.message);

export function useEntitlements(workspaceId: string) {
  return useQuery({
    queryKey: [workspaceId, "entitlements"],
    queryFn: () => api<Entitlements>(`/api/w/${workspaceId}/entitlements`),
  });
}

/** Invite people by email: they get a link (emailed if the server has SMTP configured, always shown here). */
export function InvitationsCard({ workspaceId }: { workspaceId: string }) {
  const base = `/api/w/${workspaceId}`;
  const qc = useQueryClient();
  const key = [workspaceId, "invitations"];
  const [sent, setSent] = useState<{
    email: string;
    url: string;
    emailed: boolean;
  } | null>(null);
  const pending = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ id: string; email: string; role: string; expiresAt: string }[]>(
        `${base}/invitations`,
      ),
  });
  const invite = useMutation({
    mutationFn: (body: { email: string; role: string }) =>
      api<{ acceptUrl: string; emailed: boolean }>(`${base}/invitations`, {
        body,
      }),
    onSuccess: (res, vars) => {
      setSent({ email: vars.email, url: res.acceptUrl, emailed: res.emailed });
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: fail,
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`${base}/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: fail,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite people</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            invite.mutate({
              email: String(f.get("email")),
              role: String(f.get("role")),
            });
            e.currentTarget.reset();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="inv-email">Email</Label>
            <Input
              id="inv-email"
              name="email"
              type="email"
              required
              className="w-64"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="inv-role">Role</Label>
            <select
              id="inv-role"
              name="role"
              className="rounded-md border bg-transparent p-2 text-sm"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <Button type="submit" disabled={invite.isPending}>
            Send invitation
          </Button>
        </form>
        {sent && (
          <div role="status" className="rounded-md border p-3 text-sm">
            <p>
              {sent.emailed
                ? `An email with the link was sent to ${sent.email}.`
                : `This server does not send email (ORBYT_SMTP_URL is not set). Send ${sent.email} this link yourself:`}
            </p>
            <code
              className="mt-2 block rounded bg-muted p-2 break-all"
              data-testid="invite-link"
            >
              {sent.url}
            </code>
          </div>
        )}
        {pending.data?.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span>{p.email}</span>
            <span className="rounded-full border px-2 py-0.5 text-xs">
              {p.role}
            </span>
            <span className="text-muted-foreground">
              expires {new Date(p.expiresAt).toLocaleDateString()}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => revoke.mutate(p.id)}
            >
              Revoke
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Plan and billing. Cloud installs sell plans through Stripe; self-hosted ones show their license. */
export function PlanCard({ workspaceId }: { workspaceId: string }) {
  const ent = useEntitlements(workspaceId);
  const orgId = ent.data?.organizationId;
  const billing = useQuery({
    queryKey: [workspaceId, "billing"],
    queryFn: () =>
      api<{
        enabled: boolean;
        plan: string;
        status: string;
        hasCustomer: boolean;
      }>(`/api/orgs/${orgId}/billing`),
    enabled: !!orgId && !!ent.data?.cloud,
    retry: false,
  });
  const go = useMutation({
    mutationFn: (path: { url: string; body?: object }) =>
      api<{ url: string }>(path.url, { body: path.body ?? {} }),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
    onError: fail,
  });
  const e = ent.data;
  if (!e) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>
          <span className="font-medium capitalize" data-testid="plan-name">
            {e.cloud ? e.plan : "Self-hosted community edition"}
          </span>
          {e.cloud && billing.data && billing.data.status !== "none" && (
            <span className="text-muted-foreground">
              {" "}
              · {billing.data.status}
            </span>
          )}
        </p>
        <p className="text-muted-foreground">
          {e.maxWorkspaces === null
            ? "No workspace or mailbox limits."
            : `Up to ${e.maxWorkspaces} workspace(s) and ${e.maxMailboxes} mailbox(es).`}{" "}
          {e.features.length > 0
            ? `Includes: ${e.features.join(", ")}.`
            : "No paid features unlocked."}
        </p>
        {e.cloud && orgId && (
          <div className="flex flex-wrap gap-2">
            {(["pro", "agency"] as const).map((plan) => (
              <Button
                key={plan}
                size="sm"
                variant={e.plan === plan ? "secondary" : "outline"}
                disabled={e.plan === plan || go.isPending}
                onClick={() =>
                  go.mutate({
                    url: `/api/orgs/${orgId}/billing/checkout`,
                    body: { plan },
                  })
                }
              >
                {e.plan === plan ? `Current: ${plan}` : `Upgrade to ${plan}`}
              </Button>
            ))}
            {billing.data?.hasCustomer && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  go.mutate({ url: `/api/orgs/${orgId}/billing/portal` })
                }
              >
                Manage billing
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** White-label: only for plans/licenses that include it. */
export function BrandingCard({ workspaceId }: { workspaceId: string }) {
  const ent = useEntitlements(workspaceId);
  const orgId = ent.data?.organizationId;
  const enabled = !!orgId && !!ent.data?.features.includes("white_label");
  const qc = useQueryClient();
  const key = [workspaceId, "branding"];
  const brand = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{
        brandName: string | null;
        brandLogoUrl: string | null;
        brandColor: string | null;
        customDomain: string | null;
      }>(`/api/orgs/${orgId}/branding`),
    enabled,
  });
  const save = useMutation({
    mutationFn: (body: object) =>
      api(`/api/orgs/${orgId}/branding`, { method: "PUT", body }),
    onSuccess: () => {
      toast.success("Branding saved");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: fail,
  });
  if (!enabled || !brand.data) return null;
  const b = brand.data;
  const nullIfEmpty = (v: FormDataEntryValue | null) =>
    String(v ?? "").trim() || null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>White-label</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            save.mutate({
              brandName: nullIfEmpty(f.get("brandName")),
              brandLogoUrl: nullIfEmpty(f.get("brandLogoUrl")),
              brandColor: nullIfEmpty(f.get("brandColor")),
              customDomain: nullIfEmpty(f.get("customDomain")),
            });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="br-name">Product name</Label>
            <Input
              id="br-name"
              name="brandName"
              defaultValue={b.brandName ?? ""}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="br-color">Accent color (#1a73e8)</Label>
            <Input
              id="br-color"
              name="brandColor"
              defaultValue={b.brandColor ?? ""}
            />
          </div>
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor="br-logo">Logo URL</Label>
            <Input
              id="br-logo"
              name="brandLogoUrl"
              type="url"
              defaultValue={b.brandLogoUrl ?? ""}
            />
          </div>
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor="br-domain">
              Custom domain (point its DNS at this server)
            </Label>
            <Input
              id="br-domain"
              name="customDomain"
              defaultValue={b.customDomain ?? ""}
              placeholder="app.youragency.com"
            />
          </div>
          <Button
            type="submit"
            className="justify-self-start"
            disabled={save.isPending}
          >
            Save branding
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Who did what in this workspace (entitlement: audit_logs). */
export function AuditCard({ workspaceId }: { workspaceId: string }) {
  const ent = useEntitlements(workspaceId);
  const enabled = !!ent.data?.features.includes("audit_logs");
  const log = useQuery({
    queryKey: [workspaceId, "audit"],
    queryFn: () =>
      api<{
        items: {
          id: string;
          action: string;
          actorVia: string;
          createdAt: string;
        }[];
      }>(`/api/w/${workspaceId}/audit-logs?limit=25`),
    enabled,
  });
  if (!enabled) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1 text-sm">
        {log.data?.items.length === 0 && (
          <p className="text-muted-foreground">Nothing recorded yet.</p>
        )}
        {log.data?.items.map((l) => (
          <div key={l.id} className="flex flex-wrap gap-3">
            <span className="font-mono text-xs">{l.action}</span>
            <span className="text-muted-foreground">{l.actorVia}</span>
            <span className="ml-auto text-muted-foreground">
              {new Date(l.createdAt).toLocaleString()}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

interface ImportResult {
  created?: number;
  updated?: number;
  skipped?: number;
  contactsCreated?: number;
  errors: { row: number; message: string }[];
}

/** Move over from GoHighLevel: upload its Contacts and Opportunities CSV exports. */
export function ImportCard({ workspaceId }: { workspaceId: string }) {
  const base = `/api/w/${workspaceId}`;
  const qc = useQueryClient();
  const [result, setResult] = useState<{
    what: string;
    r: ImportResult;
  } | null>(null);
  const run = useMutation({
    mutationFn: async ({
      kind,
      file,
    }: {
      kind: "contacts" | "opportunities";
      file: File;
    }) => ({
      what: kind,
      r: await api<ImportResult>(`${base}/import/ghl/${kind}`, {
        raw: await file.text(),
        type: "text/csv",
      }),
    }),
    onSuccess: (res) => {
      setResult(res);
      void qc.invalidateQueries({ queryKey: [workspaceId] });
    },
    onError: fail,
  });
  const pick =
    (kind: "contacts" | "opportunities") =>
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      if (file) run.mutate({ kind, file });
      ev.target.value = "";
    };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import from GoHighLevel</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="text-muted-foreground">
          In GoHighLevel export your Contacts and Opportunities as CSV, then
          upload them here (contacts first). Safe to run again: nothing is
          duplicated.
        </p>
        <div className="flex flex-wrap gap-4">
          <div className="grid gap-2">
            <Label htmlFor="ghl-contacts">Contacts CSV</Label>
            <Input
              id="ghl-contacts"
              type="file"
              accept=".csv,text/csv"
              onChange={pick("contacts")}
              disabled={run.isPending}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ghl-opps">Opportunities CSV</Label>
            <Input
              id="ghl-opps"
              type="file"
              accept=".csv,text/csv"
              onChange={pick("opportunities")}
              disabled={run.isPending}
            />
          </div>
        </div>
        {result && (
          <div
            role="status"
            data-testid="import-result"
            className="rounded-md border p-3"
          >
            <p className="font-medium">Imported {result.what}</p>
            <p>
              {result.r.created ?? 0} created
              {result.r.updated !== undefined
                ? `, ${result.r.updated} updated`
                : ""}
              {result.r.skipped ? `, ${result.r.skipped} already there` : ""}
              {result.r.errors.length
                ? `, ${result.r.errors.length} rows skipped`
                : ""}
              .
            </p>
            {result.r.errors.slice(0, 5).map((er) => (
              <p key={er.row} className="text-muted-foreground">
                Row {er.row}: {er.message}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
