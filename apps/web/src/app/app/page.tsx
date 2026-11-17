"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api, authClient, type Workspace } from "@/lib/api";

// Entry point after sign-in: send the user to their first workspace.
export default function AppIndex() {
  const router = useRouter();
  const session = authClient.useSession();
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<Workspace[]>("/api/me/workspaces"),
    enabled: !!session.data,
  });

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace("/sign-in");
  }, [session.isPending, session.data, router]);
  useEffect(() => {
    const first = workspaces.data?.[0];
    if (first) router.replace(`/app/${first.id}/contacts`);
  }, [workspaces.data, router]);

  if (workspaces.data?.length === 0)
    return <p className="p-6">You do not belong to any workspace yet.</p>;
  return <p className="p-6 text-zinc-500">Loading…</p>;
}
