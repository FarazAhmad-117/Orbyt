import {
  and,
  contacts,
  contactTags,
  customFieldDefs,
  eq,
  inArray,
  notes,
  tags,
  tasks,
  type Tx,
} from "@orbyt/db";
import { enrollContacts } from "../email/enroll";
import {
  mergeCustomFields,
  validateCustomFields,
  type FieldValues,
} from "../custom-fields";
import type { DomainEvent } from "../events.service";
import type { Scope } from "../scope";
import { assertPublicUrl } from "../ssrf";
import { evaluate, renderCtx, type WorkflowNode } from "./graph";

export interface RunEnv {
  tx: Tx;
  scope: Scope;
  now: Date;
  executionId: string;
  nodeId: string;
  contactId: string | null;
  depth: number;
  /** { contact, event, steps } for {{templates}}. */
  ctx: Record<string, unknown>;
  /** Domain events to publish after the transaction commits. */
  emit: (event: DomainEvent) => void;
  /** Send an SMS/WhatsApp message or place a call through a connected channel account. */
  channels: {
    send: (
      channelId: string,
      to: string,
      body: string,
    ) => Promise<{ sid: string }>;
    call: (
      channelId: string,
      to: string,
      agentId?: string,
    ) => Promise<{ callId: string }>;
  };
  /** One metered model call using the workspace's AI provider. */
  ai: (o: {
    system?: string;
    user: string;
    json?: boolean;
    providerId?: string;
  }) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

export interface NodeResult {
  output?: Record<string, unknown>;
  branch?: "true" | "false";
  waitMinutes?: number;
}

const needContact = (env: RunEnv) => {
  if (!env.contactId)
    throw new Error(
      "This step needs a contact, but the workflow was not started for one",
    );
  return env.contactId;
};

/** Executes one node. Throws to signal failure (the engine retries, then fails the execution). */
export async function runNode(
  node: WorkflowNode,
  env: RunEnv,
): Promise<NodeResult> {
  const { tx, scope } = env;
  // Events produced by workflow actions count one hop deeper: the engine stops loops at depth 3.
  const hop = { depth: env.depth + 1 };
  const render = (s: string) => renderCtx(s, env.ctx);

  switch (node.type) {
    case "trigger":
      return {};

    case "wait":
      return {
        waitMinutes: node.config.minutes,
        output: { minutes: node.config.minutes },
      };

    case "condition": {
      const left = render(node.config.left);
      const right = render(node.config.right ?? "");
      const result = evaluate(node.config.op, left, right);
      return {
        branch: result ? "true" : "false",
        output: { left, right, result },
      };
    }

    case "tag": {
      const contactId = needContact(env);
      const add = node.config.add.map(render).filter(Boolean);
      const remove = node.config.remove.map(render).filter(Boolean);
      let changed = false;
      if (add.length) {
        await tx
          .insert(tags)
          .values(add.map((name) => ({ workspaceId: scope.workspaceId, name })))
          .onConflictDoNothing();
        const rows = await tx
          .select()
          .from(tags)
          .where(inArray(tags.name, add));
        const inserted = await tx
          .insert(contactTags)
          .values(
            rows.map((t) => ({
              workspaceId: scope.workspaceId,
              contactId,
              tagId: t.id,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: contactTags.tagId });
        changed ||= inserted.length > 0;
      }
      if (remove.length) {
        const rows = await tx
          .select({ id: tags.id })
          .from(tags)
          .where(inArray(tags.name, remove));
        if (rows.length) {
          const gone = await tx
            .delete(contactTags)
            .where(
              and(
                eq(contactTags.contactId, contactId),
                inArray(
                  contactTags.tagId,
                  rows.map((r) => r.id),
                ),
              ),
            )
            .returning({ id: contactTags.tagId });
          changed ||= gone.length > 0;
        }
      }
      if (changed)
        env.emit({
          type: "contact.tagged",
          contactId,
          data: { added: add, removed: remove },
          origin: hop,
        });
      return { output: { added: add, removed: remove, changed } };
    }

    case "update_contact": {
      const contactId = needContact(env);
      const [current] = await tx
        .select()
        .from(contacts)
        .where(eq(contacts.id, contactId));
      if (!current) throw new Error("The contact no longer exists");
      const set: Partial<typeof contacts.$inferInsert> = {};
      const custom: FieldValues = {};
      const defs = new Map(
        (await tx.select().from(customFieldDefs)).map((d) => [d.key, d]),
      );
      for (const [field, raw] of Object.entries(node.config.fields)) {
        const value = render(raw);
        if (field === "name" || field === "phone" || field === "source")
          set[field] = value || null;
        else if (field.startsWith("custom.")) {
          const key = field.slice(7);
          const def = defs.get(key);
          if (!def) throw new Error(`Unknown custom field "${key}"`);
          custom[key] =
            value === ""
              ? null
              : def.type === "number"
                ? Number(value)
                : def.type === "boolean"
                  ? /^(true|yes|1|y)$/i.test(value)
                  : value;
        } else
          throw new Error(
            `Cannot update "${field}" (use name, phone, source or custom.<key>)`,
          );
      }
      if (Object.keys(custom).length) {
        await validateCustomFields(tx, custom);
        set.customFields = mergeCustomFields(current.customFields, custom);
      }
      if (Object.keys(set).length)
        await tx.update(contacts).set(set).where(eq(contacts.id, contactId));
      env.emit({
        type: "contact.updated",
        contactId,
        data: { fields: Object.keys(node.config.fields) },
        origin: hop,
      });
      return { output: { updated: Object.keys(node.config.fields) } };
    }

    case "create_task": {
      const [task] = await tx
        .insert(tasks)
        .values({
          workspaceId: scope.workspaceId,
          title: render(node.config.title),
          contactId: env.contactId,
          dueAt:
            node.config.dueInHours === undefined
              ? null
              : new Date(
                  env.now.getTime() + node.config.dueInHours * 3_600_000,
                ),
        })
        .returning();
      env.emit({
        type: "task.created",
        contactId: env.contactId,
        data: { id: task!.id, title: task!.title },
        origin: hop,
      });
      return { output: { taskId: task!.id } };
    }

    case "add_note": {
      const contactId = needContact(env);
      const [note] = await tx
        .insert(notes)
        .values({
          workspaceId: scope.workspaceId,
          contactId,
          body: render(node.config.body),
        })
        .returning();
      env.emit({
        type: "note.added",
        contactId,
        data: { id: note!.id },
        origin: hop,
      });
      return { output: { noteId: note!.id } };
    }

    case "http": {
      // The same SSRF guard as webhooks: no private or reserved addresses.
      const url = await assertPublicUrl(render(node.config.url));
      const headers: Record<string, string> = {
        // Receivers can de-duplicate: delivery is at-least-once.
        "idempotency-key": `${env.executionId}:${env.nodeId}`,
        "user-agent": "Orbyt-Workflows/1",
      };
      for (const [k, v] of Object.entries(node.config.headers))
        headers[k.toLowerCase()] = render(v);
      const hasBody =
        node.config.method !== "GET" && node.config.body !== undefined;
      if (hasBody && !headers["content-type"])
        headers["content-type"] = "application/json";
      const res = await fetch(url, {
        method: node.config.method,
        headers,
        body: hasBody ? render(node.config.body!) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.text()).slice(0, 1000);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.host}`);
      return { output: { status: res.status, body } };
    }

    case "send_sms": {
      const r = await env.channels.send(
        node.config.channelId,
        render(node.config.to),
        render(node.config.body),
      );
      return { output: { sid: r.sid } };
    }

    case "voice_call": {
      const r = await env.channels.call(
        node.config.channelId,
        render(node.config.to),
        node.config.agentId,
      );
      return { output: { callId: r.callId } };
    }

    case "ai": {
      // The answer is available to later steps as {{steps.<id>.output.text}}.
      const r = await env.ai({
        system: node.config.system ? render(node.config.system) : undefined,
        user: render(node.config.prompt),
        json: node.config.json,
        providerId: node.config.providerId,
      });
      return {
        output: {
          text: r.text,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
        },
      };
    }

    case "enroll_sequence": {
      const contactId = needContact(env);
      const result = await enrollContacts(tx, scope, node.config.sequenceId, [
        contactId,
      ]);
      if (result.enrolled)
        env.emit({
          type: "sequence.enrolled",
          contactId,
          data: { id: node.config.sequenceId, count: 1 },
          origin: hop,
        });
      return {
        output: {
          enrolled: result.enrolled,
          skipped: result.skipped.map((s) => s.reason),
        },
      };
    }
  }
}
