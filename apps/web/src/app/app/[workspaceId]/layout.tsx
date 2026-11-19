"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  CircleDollarSign,
  ClipboardList,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Mail,
  Send,
  Settings,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { api, authClient, type Workspace } from "@/lib/api";

// Grouped like a station's departure boards: what you grow, how you reach people, what runs by itself.
const NAV: { group: string; items: [string, string, LucideIcon][] }[] = [
  {
    group: "Grow",
    items: [
      ["contacts", "Contacts", Users],
      ["deals", "Deals", CircleDollarSign],
      ["tasks", "Tasks", ListChecks],
    ],
  },
  {
    group: "Reach",
    items: [
      ["inbox", "Inbox", Inbox],
      ["sequences", "Sequences", Send],
      ["mailboxes", "Mailboxes", Mail],
      ["forms", "Forms", ClipboardList],
    ],
  },
  {
    group: "Automate",
    items: [
      ["workflows", "Workflows", Workflow],
      ["knowledge", "Knowledge", BookOpen],
    ],
  },
];

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

  // White-label: the agency's own name/logo when this host is its custom domain.
  const brand = useQuery({
    queryKey: ["branding"],
    queryFn: () =>
      api<{
        brandName: string | null;
        brandLogoUrl: string | null;
        brandColor: string | null;
      }>("/api/branding"),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace("/sign-in");
  }, [session.isPending, session.data, router]);

  if (session.isPending || workspaces.isLoading)
    return <p className="p-6 text-muted-foreground">Loading…</p>;
  if (!session.data) return null;

  const current = workspaces.data?.find((w) => w.id === workspaceId);
  const section = pathname.split("/")[3];

  // slug "" is the overview ("Today") at /app/<workspace>.
  const navLink = (slug: string, label: string, Icon: LucideIcon) => {
    const active = slug ? section === slug : !section;
    return (
      <Link
        key={slug}
        href={`/app/${workspaceId}${slug ? `/${slug}` : ""}`}
        aria-current={active ? "page" : undefined}
        // On a phone the nav is a scrolling strip: keep the current page in view.
        ref={(el) => {
          if (active && el)
            el.scrollIntoView({ inline: "center", block: "nearest" });
        }}
        className={`flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
          active
            ? "bg-sidebar-foreground text-ink"
            : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        }`}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        {label}
        {active && (
          <span
            aria-hidden
            className="ml-auto size-1.5 rounded-[1px] bg-signal"
          />
        )}
      </Link>
    );
  };

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="relative flex w-full flex-col gap-3 bg-sidebar p-3 text-sidebar-foreground md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:gap-5 md:overflow-y-auto md:p-4">
        {/* Phones: sign out lives next to the logo instead of a footer that eats the first screen. */}
        <Button
          variant="outline"
          size="sm"
          className="absolute top-3 right-3 border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:hidden"
          onClick={async () => {
            await authClient.signOut();
            router.push("/sign-in");
          }}
        >
          Sign out
        </Button>
        <Link
          href="/app"
          className="flex items-center gap-2 text-sidebar-foreground"
          style={
            brand.data?.brandColor
              ? { color: brand.data.brandColor }
              : undefined
          }
        >
          {brand.data?.brandLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- the logo is an arbitrary customer URL
            <img src={brand.data.brandLogoUrl} alt="" className="h-6 w-auto" />
          ) : null}
          {brand.data?.brandName ? (
            <span className="text-lg font-extrabold tracking-[-0.02em]">
              {brand.data.brandName}
            </span>
          ) : (
            <Wordmark />
          )}
        </Link>

        <div className="flex items-end gap-2 md:grid">
          <label className="grid flex-1 gap-1.5 text-[0.7rem] font-bold tracking-[0.08em] text-sidebar-foreground/60 uppercase">
            Workspace
            <select
              aria-label="Workspace"
              className="h-9 rounded-md border border-sidebar-border bg-sidebar-accent px-2 text-sm font-medium tracking-normal text-sidebar-foreground normal-case"
              value={workspaceId}
              onChange={(e) =>
                router.push(`/app/${e.target.value}/${section ?? "contacts"}`)
              }
            >
              {!current && (
                <option value={workspaceId}>Unknown workspace</option>
              )}
              {workspaces.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          {current && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-start text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
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
              + New workspace
            </Button>
          )}
        </div>

        <nav
          aria-label="Main"
          className="-mx-1 flex gap-4 overflow-x-auto px-1 md:mx-0 md:flex-col md:gap-5 md:overflow-visible md:px-0"
        >
          <div className="flex shrink-0 gap-1 md:grid">
            {navLink("", "Today", LayoutDashboard)}
          </div>
          {NAV.map((g) => (
            <div key={g.group} className="flex shrink-0 gap-1 md:grid">
              <div className="hidden px-3 pb-1 text-[0.7rem] font-bold tracking-[0.08em] text-sidebar-foreground/55 uppercase md:block">
                {g.group}
              </div>
              {g.items.map(([slug, label, Icon]) => navLink(slug, label, Icon))}
            </div>
          ))}
          <div className="flex shrink-0 gap-1 md:grid md:border-t md:border-sidebar-border md:pt-3">
            {navLink("settings", "Settings", Settings)}
          </div>
        </nav>

        <div className="mt-auto hidden gap-2 text-xs text-sidebar-foreground/70 md:grid">
          <span className="truncate" title={session.data.user.email}>
            {session.data.user.email}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={async () => {
              await authClient.signOut();
              router.push("/sign-in");
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-10 [&_h1]:text-[2rem] [&_h1]:leading-none [&_h1]:font-extrabold [&_h1]:tracking-[-0.02em] [&_h1]:font-stretch-condensed">
        {children}
      </main>
    </div>
  );
}
