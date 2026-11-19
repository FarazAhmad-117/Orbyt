"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

interface FormRow {
  id: string;
  name: string;
  status: "active" | "paused";
  tags: string[];
  submissions: number;
  url: string;
  embedHtml: string;
}
interface Submission {
  id: string;
  data: Record<string, string>;
  createdAt: string;
}

function Submissions({ base, id }: { base: string; id: string }) {
  const subs = useQuery({
    queryKey: [base, "form-submissions", id],
    queryFn: () =>
      api<{ items: Submission[] }>(`${base}/forms/${id}/submissions?limit=10`),
  });
  if (!subs.data?.items.length)
    return <p className="text-sm text-muted-foreground">No submissions yet.</p>;
  return (
    <div className="grid gap-1 text-sm">
      {subs.data.items.map((s) => (
        <div key={s.id} className="flex flex-wrap gap-3">
          <span className="font-medium">{s.data.email}</span>
          <span className="text-muted-foreground">
            {Object.entries(s.data)
              .filter(([k]) => k !== "email")
              .map(([, v]) => v)
              .join(" · ")}
          </span>
          <span className="ml-auto text-muted-foreground">
            {new Date(s.createdAt).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function FormsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/api/w/${workspaceId}`;
  const qc = useQueryClient();
  const key = [workspaceId, "forms"];
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({
    queryKey: key,
    queryFn: () => api<FormRow[]>(`${base}/forms`),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const fail = (e: Error) => toast.error(e.message);

  const create = useMutation({
    mutationFn: (body: object) => api<FormRow>(`${base}/forms`, { body }),
    onSuccess: (f) => {
      toast.success("Form created");
      setOpen(f.id);
      refresh();
    },
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) =>
      api(`${base}/forms/${id}`, { method: "PATCH", body }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`${base}/forms/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: fail,
  });

  return (
    <div className="grid max-w-3xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Forms</h1>
        <p className="text-sm text-muted-foreground">
          Collect leads from any website. Every submission becomes a contact (or
          updates the existing one), gets your tags and can start a workflow.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New form</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const fields = [
                {
                  name: "email",
                  label: "Email",
                  type: "email",
                  required: true,
                },
                ...(f.get("name")
                  ? [
                      {
                        name: "name",
                        label: "Your name",
                        type: "text",
                        required: false,
                      },
                    ]
                  : []),
                ...(f.get("phone")
                  ? [
                      {
                        name: "phone",
                        label: "Phone",
                        type: "tel",
                        required: false,
                      },
                    ]
                  : []),
                ...(f.get("message")
                  ? [
                      {
                        name: "message",
                        label: "Message",
                        type: "textarea",
                        required: true,
                      },
                    ]
                  : []),
              ];
              create.mutate({
                name: String(f.get("title")),
                fields,
                tags: String(f.get("tags") ?? "")
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              });
              e.currentTarget.reset();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="form-title">Name</Label>
              <Input id="form-title" name="title" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="form-tags">Tags to add (comma separated)</Label>
              <Input id="form-tags" name="tags" placeholder="lead, website" />
            </div>
            <fieldset className="flex flex-wrap gap-4 text-sm sm:col-span-2">
              <legend className="mb-1 text-muted-foreground">
                Ask for (email is always included)
              </legend>
              {[
                ["name", "Name"],
                ["phone", "Phone"],
                ["message", "Message"],
              ].map(([n, label]) => (
                <label key={n} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name={n}
                    defaultChecked={n !== "phone"}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <Button
              type="submit"
              className="justify-self-start"
              disabled={create.isPending}
            >
              Create form
            </Button>
          </form>
        </CardContent>
      </Card>

      {list.data?.length === 0 && (
        <EmptyState title="No forms yet.">
          A form on your website turns visitors into contacts, tagged and ready
          to start a workflow. Create one above.
        </EmptyState>
      )}
      {list.data?.map((f) => (
        <Card key={f.id}>
          <CardContent className="grid gap-3 pt-6 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="mr-auto text-base font-medium underline"
                onClick={() => setOpen(open === f.id ? null : f.id)}
              >
                {f.name}
              </button>
              <span className="text-muted-foreground">
                {f.submissions} submission(s)
              </span>
              <Badge variant={f.status === "active" ? "default" : "secondary"}>
                {f.status}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  patch.mutate({
                    id: f.id,
                    body: {
                      status: f.status === "active" ? "paused" : "active",
                    },
                  })
                }
              >
                {f.status === "active" ? "Pause" : "Resume"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => remove.mutate(f.id)}
              >
                Delete
              </Button>
            </div>
            {open === f.id && (
              <>
                <div className="grid gap-1">
                  <span className="text-muted-foreground">
                    Paste this into any web page:
                  </span>
                  <pre
                    className="overflow-x-auto rounded bg-muted p-3 text-xs"
                    data-testid="embed-html"
                  >
                    {f.embedHtml}
                  </pre>
                  <span className="text-muted-foreground">
                    Or post JSON to <code className="break-all">{f.url}</code>
                  </span>
                </div>
                <Submissions base={base} id={f.id} />
              </>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
