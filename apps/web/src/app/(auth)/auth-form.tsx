"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
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
import { api, authClient } from "@/lib/api";

/** Where to go after signing in: only same-site paths (blocks `?next=https://evil.test` and `//evil.test`). */
function safeNext(raw: string | null): string {
  return raw && /^\/(?![/\\])/.test(raw) ? raw : "/app";
}
const nextParam = () =>
  safeNext(new URLSearchParams(window.location.search).get("next"));

interface Brand {
  brandName: string | null;
  brandLogoUrl: string | null;
  brandColor: string | null;
}

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<{ enabled: boolean; name: string } | null>(
    null,
  );
  const [brand, setBrand] = useState<Brand | null>(null);
  // Keeps `?next=` when switching between sign-in and sign-up ("" on the server and when absent).
  const nextSuffix = useSyncExternalStore(
    () => () => undefined,
    () => {
      const next = nextParam();
      return next === "/app" ? "" : `?next=${encodeURIComponent(next)}`;
    },
    () => "",
  );
  const signUp = mode === "sign-up";

  // Public, optional extras: SSO availability and the white-label brand for this host.
  useEffect(() => {
    api<{ enabled: boolean; name: string }>("/api/sso/status")
      .then(setSso)
      .catch(() => undefined);
    api<Brand>("/api/branding")
      .then(setBrand)
      .catch(() => undefined);
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    const result = signUp
      ? await authClient.signUp.email({
          email,
          password,
          name: String(form.get("name")),
        })
      : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "Something went wrong");
      return;
    }
    router.push(nextParam());
  }

  async function signInWithSso() {
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/api/auth/sign-in/social", {
        body: { provider: "sso", callbackURL: nextParam() },
      });
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const product = brand?.brandName ?? "Orbyt";

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card
        className="w-full max-w-sm"
        style={
          brand?.brandColor
            ? { borderTop: `3px solid ${brand.brandColor}` }
            : undefined
        }
      >
        <CardHeader>
          {brand?.brandLogoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- the logo is an arbitrary customer URL
            <img
              src={brand.brandLogoUrl}
              alt={product}
              className="mb-2 h-10 w-auto self-start"
            />
          )}
          <CardTitle>
            {signUp ? "Create your account" : `Sign in to ${product}`}
          </CardTitle>
          <CardDescription>
            {signUp ? "Start with a free workspace." : "Welcome back."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            {signUp && (
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required autoComplete="name" />
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete={signUp ? "new-password" : "current-password"}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? "Please wait…" : signUp ? "Create account" : "Sign in"}
            </Button>
            {sso?.enabled && !signUp && (
              <Button type="button" variant="outline" onClick={signInWithSso}>
                Sign in with {sso.name}
              </Button>
            )}
          </form>
          <p className="mt-4 text-center text-sm text-zinc-600 dark:text-zinc-400">
            {signUp ? (
              <>
                Already have an account?{" "}
                <Link href={`/sign-in${nextSuffix}`} className="underline">
                  Sign in
                </Link>
              </>
            ) : (
              <>
                New here?{" "}
                <Link href={`/sign-up${nextSuffix}`} className="underline">
                  Create an account
                </Link>
              </>
            )}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
