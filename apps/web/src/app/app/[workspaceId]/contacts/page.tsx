"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, type Contact, type Page } from "@/lib/api";

export default function ContactsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/api/w/${workspaceId}`;
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  const contacts = useInfiniteQuery({
    queryKey: [workspaceId, "contacts", q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<Page<Contact>>(
        `${base}/contacts?limit=25${q ? `&q=${encodeURIComponent(q)}` : ""}${pageParam ? `&cursor=${pageParam}` : ""}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const create = useMutation({
    mutationFn: (body: { email: string; name?: string; tags?: string[] }) =>
      api(`${base}/contacts`, { body }),
    onSuccess: () => {
      toast.success("Contact created");
      setAdding(false);
      void qc.invalidateQueries({ queryKey: [workspaceId, "contacts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function importCsv(file: File) {
    try {
      const r = await api<{
        created: number;
        updated: number;
        errors: unknown[];
      }>(`${base}/contacts/import`, { raw: await file.text() });
      toast.success(
        `Imported: ${r.created} new, ${r.updated} updated, ${r.errors.length} errors`,
      );
      void qc.invalidateQueries({ queryKey: [workspaceId, "contacts"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const rows = contacts.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end gap-2">
        <div className="mr-auto grid gap-1.5">
          <h1>Contacts</h1>
          <p className="text-sm text-muted-foreground">
            Everyone you can reach from this workspace
            {rows.length > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="tabular font-semibold text-foreground">
                  {rows.length}
                  {contacts.hasNextPage ? "+" : ""}
                </span>{" "}
                {q ? "found" : "listed"}
              </>
            )}
            .
          </p>
        </div>
        <Input
          aria-label="Search contacts"
          placeholder="Search by email or name"
          className="w-64"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="inline-flex h-9 cursor-pointer items-center rounded-md border border-input bg-card px-3.5 text-sm font-semibold transition-colors hover:bg-muted focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-signal">
          Import CSV
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            aria-label="Import CSV"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importCsv(f);
              e.target.value = "";
            }}
          />
        </label>
        <a
          href={`${base}/contacts/export`}
          className="inline-flex h-9 items-center rounded-md border border-input bg-card px-3.5 text-sm font-semibold transition-colors hover:bg-muted"
        >
          Export CSV
        </a>
        <Button
          variant={adding ? "outline" : "signal"}
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? "Cancel" : "Add contact"}
        </Button>
      </div>

      {adding && (
        <Card>
          <CardHeader>
            <CardTitle>New contact</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 sm:grid-cols-4 sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const tags = String(f.get("tags") ?? "")
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean);
                create.mutate({
                  email: String(f.get("email")),
                  name: String(f.get("name") ?? "") || undefined,
                  tags,
                });
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="c-email">Email</Label>
                <Input id="c-email" name="email" type="email" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="c-name">Name</Label>
                <Input id="c-name" name="name" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="c-tags">Tags (comma separated)</Label>
                <Input id="c-tags" name="tags" />
              </div>
              <Button type="submit" disabled={create.isPending}>
                Save
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {!contacts.isLoading && rows.length === 0 ? (
        <div className="grid max-w-2xl gap-5 rounded-lg border border-dashed border-input bg-card p-8">
          <div className="grid gap-1.5">
            <p className="text-xl font-extrabold tracking-[-0.01em] font-stretch-condensed">
              {q ? `Nothing matches “${q}”.` : "No contacts yet."}
            </p>
            <p className="text-sm text-muted-foreground">
              {q
                ? "Check the spelling, or search by part of an email address."
                : "Add people one by one, import a CSV (GoHighLevel exports work too), or let a form on your website collect them."}
            </p>
          </div>
          {!q && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setAdding(true)}>Add a contact</Button>
              <Link
                href={`/app/${workspaceId}/forms`}
                className="inline-flex h-9 items-center rounded-md border border-input bg-card px-3.5 text-sm font-semibold transition-colors hover:bg-muted"
              >
                Create a form
              </Link>
            </div>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Tags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">
                  <Link
                    className="decoration-signal underline-offset-4 hover:underline"
                    href={`/app/${workspaceId}/contacts/${c.id}`}
                  >
                    {c.email}
                  </Link>
                </TableCell>
                <TableCell>{c.name}</TableCell>
                <TableCell className="space-x-1">
                  {c.tags.map((t) => (
                    <Badge key={t.id} variant="secondary">
                      {t.name}
                    </Badge>
                  ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {contacts.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => contacts.fetchNextPage()}
          disabled={contacts.isFetchingNextPage}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
