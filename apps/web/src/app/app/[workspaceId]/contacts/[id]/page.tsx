"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  type Activity,
  type Contact,
  type Note,
  type Page,
  type Task,
} from "@/lib/api";

export default function ContactPage() {
  const { workspaceId, id } = useParams<{ workspaceId: string; id: string }>();
  const base = `/api/w/${workspaceId}`;
  const router = useRouter();
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: [workspaceId, "contact", id] });
  const fail = (e: Error) => toast.error(e.message);

  const contact = useQuery({
    queryKey: [workspaceId, "contact", id],
    queryFn: () => api<Contact>(`${base}/contacts/${id}`),
  });
  const notes = useQuery({
    queryKey: [workspaceId, "contact", id, "notes"],
    queryFn: () => api<Page<Note>>(`${base}/notes?contactId=${id}`),
  });
  const tasks = useQuery({
    queryKey: [workspaceId, "contact", id, "tasks"],
    queryFn: () => api<Page<Task>>(`${base}/tasks?contactId=${id}`),
  });
  const timeline = useQuery({
    queryKey: [workspaceId, "contact", id, "timeline"],
    queryFn: () => api<Page<Activity>>(`${base}/timeline?contactId=${id}`),
  });

  const save = useMutation({
    mutationFn: (body: object) =>
      api(`${base}/contacts/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      toast.success("Saved");
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api(`${base}/contacts/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      // The list is cached, so it must be refreshed before we navigate back to it.
      await qc.invalidateQueries({ queryKey: [workspaceId, "contacts"] });
      router.push(`/app/${workspaceId}/contacts`);
    },
    onError: fail,
  });
  const addNote = useMutation({
    mutationFn: (body: string) =>
      api(`${base}/notes`, { body: { body, contactId: id } }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: [workspaceId, "contact", id] }),
    onError: fail,
  });
  const addTask = useMutation({
    mutationFn: (title: string) =>
      api(`${base}/tasks`, { body: { title, contactId: id } }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: [workspaceId, "contact", id] }),
    onError: fail,
  });
  const toggleTask = useMutation({
    mutationFn: (t: Task) =>
      api(`${base}/tasks/${t.id}`, {
        method: "PATCH",
        body: { done: !t.doneAt },
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: [workspaceId, "contact", id] }),
    onError: fail,
  });

  if (contact.isLoading)
    return <p className="text-muted-foreground">Loading…</p>;
  if (!contact.data) return <p>Contact not found.</p>;
  const c = contact.data;

  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/app/${workspaceId}/contacts`}
          className="text-sm underline"
        >
          ← Contacts
        </Link>
        <h1 className="mr-auto text-2xl font-semibold">{c.name || c.email}</h1>
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm("Delete this contact?")) remove.mutate();
          }}
        >
          Delete
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            key={c.id + (c.name ?? "")}
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              save.mutate({
                name: String(f.get("name")) || null,
                phone: String(f.get("phone")) || null,
                source: String(f.get("source")) || null,
                tags: String(f.get("tags"))
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              });
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="d-email">Email</Label>
              <Input id="d-email" value={c.email} disabled readOnly />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="d-name">Name</Label>
              <Input id="d-name" name="name" defaultValue={c.name ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="d-phone">Phone</Label>
              <Input id="d-phone" name="phone" defaultValue={c.phone ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="d-source">Source</Label>
              <Input
                id="d-source"
                name="source"
                defaultValue={c.source ?? ""}
              />
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="d-tags">Tags (comma separated)</Label>
              <Input
                id="d-tags"
                name="tags"
                defaultValue={c.tags.map((t) => t.name).join(", ")}
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={save.isPending}>
                Save changes
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <form
              className="grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const el = e.currentTarget.elements.namedItem(
                  "note",
                ) as HTMLTextAreaElement;
                if (el.value.trim()) addNote.mutate(el.value.trim());
                el.value = "";
              }}
            >
              <Textarea
                name="note"
                aria-label="New note"
                placeholder="Write a note…"
              />
              <Button type="submit" size="sm" className="justify-self-start">
                Add note
              </Button>
            </form>
            {notes.data?.items.map((n) => (
              <p key={n.id} className="rounded-md border p-3 text-sm">
                {n.body}
              </p>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tasks</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const el = e.currentTarget.elements.namedItem(
                  "task",
                ) as HTMLInputElement;
                if (el.value.trim()) addTask.mutate(el.value.trim());
                el.value = "";
              }}
            >
              <Input
                name="task"
                aria-label="New task"
                placeholder="Follow up…"
              />
              <Button type="submit" size="sm">
                Add
              </Button>
            </form>
            {tasks.data?.items.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!t.doneAt}
                  onChange={() => toggleTask.mutate(t)}
                />
                <span className={t.doneAt ? "line-through opacity-60" : ""}>
                  {t.title}
                </span>
              </label>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {timeline.data?.items.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-sm">
              <Badge variant="secondary">{a.type}</Badge>
              <span className="text-muted-foreground">
                {new Date(a.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
