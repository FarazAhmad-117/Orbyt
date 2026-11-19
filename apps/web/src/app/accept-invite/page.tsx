"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api, authClient } from "@/lib/api";

interface Invite {
  email: string;
  role: string;
  workspaceName: string;
}

/** The page an invitation link opens: shows what it is for, then joins once the right person is signed in. */
export default function AcceptInvitePage() {
  const router = useRouter();
  const session = authClient.useSession();
  // The token lives in the query string; undefined on the server, read from the URL in the browser.
  const token = useSyncExternalStore(
    () => () => undefined,
    () => new URLSearchParams(window.location.search).get("token"),
    () => undefined,
  );

  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api<Invite>(`/api/invitations/${token}`),
    enabled: !!token,
    retry: false,
  });
  const join = useMutation({
    mutationFn: () =>
      api<{ workspaceId: string }>("/api/invitations/accept", {
        body: { token },
      }),
    onSuccess: (r) => router.push(`/app/${r.workspaceId}/contacts`),
    onError: (e: Error) => toast.error(e.message),
  });

  const back = `?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`;
  const me = session.data?.user.email.toLowerCase();

  let body: React.ReactNode;
  if (token === undefined || invite.isLoading || session.isPending)
    body = <p className="text-muted-foreground">Loading…</p>;
  else if (!token || invite.isError || !invite.data)
    body = (
      <p role="alert">
        This invitation is not valid any more. Ask whoever sent it to invite you
        again.
      </p>
    );
  else if (!session.data)
    body = (
      <div className="grid gap-3 text-sm">
        <p>
          Sign in or create an account with <b>{invite.data.email}</b> to join.
        </p>
        <div className="flex gap-2">
          <Link href={`/sign-up${back}`}>
            <Button>Create an account</Button>
          </Link>
          <Link href={`/sign-in${back}`}>
            <Button variant="outline">Sign in</Button>
          </Link>
        </div>
      </div>
    );
  else if (me !== invite.data.email)
    body = (
      <div className="grid gap-3 text-sm">
        <p role="alert">
          You are signed in as <b>{session.data.user.email}</b>, but this
          invitation is for <b>{invite.data.email}</b>.
        </p>
        <Button
          variant="outline"
          className="justify-self-start"
          onClick={async () => {
            await authClient.signOut();
            router.push(`/sign-in${back}`);
          }}
        >
          Sign out and switch account
        </Button>
      </div>
    );
  else
    body = (
      <Button onClick={() => join.mutate()} disabled={join.isPending}>
        Join {invite.data.workspaceName}
      </Button>
    );

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            {invite.data
              ? `Join ${invite.data.workspaceName}`
              : "Workspace invitation"}
          </CardTitle>
          <CardDescription>
            {invite.data
              ? `You were invited as ${invite.data.role}.`
              : "Accept an invitation to a shared workspace."}
          </CardDescription>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
    </main>
  );
}
