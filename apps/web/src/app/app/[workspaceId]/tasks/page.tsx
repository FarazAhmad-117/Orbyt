"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type Page, type Task } from "@/lib/api";

export default function TasksPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/api/w/${workspaceId}`;
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: [workspaceId, "tasks"] });
  const fail = (e: Error) => toast.error(e.message);

  const open = useQuery({
    queryKey: [workspaceId, "tasks", "open"],
    queryFn: () => api<Page<Task>>(`${base}/tasks?done=false&limit=100`),
  });
  const add = useMutation({
    mutationFn: (title: string) => api(`${base}/tasks`, { body: { title } }),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const complete = useMutation({
    mutationFn: (id: string) =>
      api(`${base}/tasks/${id}`, { method: "PATCH", body: { done: true } }),
    onSuccess: () => void refresh(),
    onError: fail,
  });

  return (
    <div className="grid max-w-2xl gap-4">
      <h1 className="text-2xl font-semibold">Tasks</h1>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const el = e.currentTarget.elements.namedItem(
            "title",
          ) as HTMLInputElement;
          if (el.value.trim()) add.mutate(el.value.trim());
          el.value = "";
        }}
      >
        <Input name="title" aria-label="New task" placeholder="Add a task…" />
        <Button type="submit">Add</Button>
      </form>
      <ul className="grid gap-2">
        {open.data?.items.map((t) => (
          <li
            key={t.id}
            className="flex items-center gap-3 rounded-md border p-3 text-sm"
          >
            <input
              type="checkbox"
              aria-label={`Complete ${t.title}`}
              onChange={() => complete.mutate(t.id)}
            />
            <span>{t.title}</span>
            {t.dueAt && (
              <span className="ml-auto text-muted-foreground">
                {new Date(t.dueAt).toLocaleDateString()}
              </span>
            )}
          </li>
        ))}
        {open.data && open.data.items.length === 0 && (
          <li className="text-muted-foreground">Nothing to do. 🎉</li>
        )}
      </ul>
    </div>
  );
}
