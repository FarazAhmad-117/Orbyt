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
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">Contacts</h1>
        <Input
          aria-label="Search contacts"
          placeholder="Search…"
          className="w-56"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="inline-flex cursor-pointer items-center rounded-md border px-3 py-2 text-sm">
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
          className="rounded-md border px-3 py-2 text-sm"
        >
          Export CSV
        </a>
        <Button onClick={() => setAdding((v) => !v)}>
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
              <TableCell>
                <Link
                  className="underline"
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
          {!contacts.isLoading && rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-zinc-500">
                No contacts yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
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
