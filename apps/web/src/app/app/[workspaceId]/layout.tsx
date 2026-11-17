"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, authClient, type Workspace } from "@/lib/api";

const NAV = [
  ["contacts", "Contacts"],
  ["inbox", "Inbox"],
  ["sequences", "Sequences"],
  ["workflows", "Workflows"],
  ["mailboxes", "Mailboxes"],
  ["deals", "Deals"],
  ["tasks", "Tasks"],
  ["settings", "Settings"],
] as const;

export default function Shell({ children }: { children: React.ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const session = authClient.useSession();
  const qc = useQueryClient();
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<Workspace[]>("/api/me/workspaces"),
    enabled: !!session.data,
  });

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace("/sign-in");
  }, [session.isPending, session.data, router]);

  if (session.isPending || workspaces.isLoading)
    return <p className="p-6 text-zinc-500">Loading…</p>;
  if (!session.data) return null;

  const current = workspaces.data?.find((w) => w.id === workspaceId);
  const section = pathname.split("/")[3];

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex w-full flex-col gap-4 border-b p-4 md:w-56 md:border-r md:border-b-0">
        <Link href="/app" className="text-lg font-semibold">
          Orbyt
        </Link>
        <label className="grid gap-1 text-xs text-zinc-500">
          Workspace
          <select
            aria-label="Workspace"
            className="rounded-md border bg-transparent p-2 text-sm text-inherit"
            value={workspaceId}
            onChange={(e) =>
              router.push(`/app/${e.target.value}/${section ?? "contacts"}`)
            }
          >
            {!current && <option value={workspaceId}>Unknown workspace</option>}
            {workspaces.data?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        {current && (
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const name = window.prompt(
                "Name of the new workspace (e.g. a client)",
              );
              if (!name?.trim()) return;
              try {
                const ws = await api<Workspace>(
                  `/api/orgs/${current.organizationId}/workspaces`,
                  { body: { name: name.trim() } },
                );
                await qc.invalidateQueries({ queryKey: ["workspaces"] });
                router.push(`/app/${ws.id}/${section ?? "contacts"}`);
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          >
            New workspace
          </Button>
        )}
        <nav className="flex gap-1 md:flex-col">
          {NAV.map(([slug, label]) => (
            <Link
              key={slug}
              href={`/app/${workspaceId}/${slug}`}
              aria-current={section === slug ? "page" : undefined}
              className={`rounded-md px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                section === slug
                  ? "bg-zinc-100 font-medium dark:bg-zinc-800"
                  : ""
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto grid gap-2 text-xs text-zinc-500">
          <span className="truncate">{session.data.user.email}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await authClient.signOut();
              router.push("/sign-in");
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
