"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  const session = authClient.useSession();
  useEffect(() => {
    if (session.data) router.replace("/app");
  }, [session.data, router]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">Orbyt</h1>
      <p className="max-w-md text-zinc-600 dark:text-zinc-400">
        Open-source CRM, email outreach, automation and AI agents. Self-host it
        or use the cloud.
      </p>
      <div className="flex gap-3">
        <Link href="/sign-up">
          <Button>Create an account</Button>
        </Link>
        <Link href="/sign-in">
          <Button variant="outline">Sign in</Button>
        </Link>
      </div>
    </main>
  );
}
