import { randomBytes } from "node:crypto";
import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { workflows, type WorkflowGraph } from "@orbyt/db";
import { z } from "zod";
import { DbService } from "../db.service";
import { parse } from "../http";
import { Ctx, type Scope, WorkspaceGuard } from "../scope";
import { graphSchema, validateGraph } from "./graph";

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  triggerType: "event" | "manual" | "webhook" | "schedule";
  triggerEvent?: string;
  scheduleMinutes?: number;
  graph: WorkflowGraph;
}

const t = { id: "t", type: "trigger", config: {} };

/**
 * Starting points to copy (a template-marketplace seed, and the way to rebuild GoHighLevel
 * workflows, which cannot be exported). Everything that needs a choice (which sequence, which
 * channel, which URL) is left out so a template is valid as it is and can be edited afterwards.
 */
export const TEMPLATES: WorkflowTemplate[] = [
  {
    key: "welcome-new-contact",
    name: "Welcome new contacts",
    description:
      "Tag every new contact and create a follow-up task for the next day.",
    triggerType: "event",
    triggerEvent: "contact.created",
    graph: {
      nodes: [
        t,
        { id: "tag", type: "tag", config: { add: ["new"], remove: [] } },
        {
          id: "task",
          type: "create_task",
          config: {
            title: "Say hello to {{contact.name | the new contact}}",
            dueInHours: 24,
          },
        },
      ],
      edges: [
        { from: "t", to: "tag" },
        { from: "tag", to: "task" },
      ],
    },
  },
  {
    key: "form-lead-followup",
    name: "Follow up form leads",
    description:
      "When someone fills in a form: tag them as a lead and create a task to call them.",
    triggerType: "event",
    triggerEvent: "form.submitted",
    graph: {
      nodes: [
        t,
        { id: "tag", type: "tag", config: { add: ["lead"], remove: [] } },
        {
          id: "task",
          type: "create_task",
          config: {
            title: "Call {{contact.email}} (form lead)",
            dueInHours: 4,
          },
        },
      ],
      edges: [
        { from: "t", to: "tag" },
        { from: "tag", to: "task" },
      ],
    },
  },
  {
    key: "interested-reply",
    name: "Handle replies",
    description:
      "When a prospect replies to a campaign: tag them and create a task so a human answers within a day.",
    triggerType: "event",
    triggerEvent: "email.replied",
    graph: {
      nodes: [
        t,
        { id: "tag", type: "tag", config: { add: ["replied"], remove: [] } },
        {
          id: "task",
          type: "create_task",
          config: {
            title: "Answer the reply from {{contact.email}}",
            dueInHours: 24,
          },
        },
      ],
      edges: [
        { from: "t", to: "tag" },
        { from: "tag", to: "task" },
      ],
    },
  },
  {
    key: "deal-won",
    name: "Celebrate won deals",
    description:
      "When a deal is won: tag the contact as a customer and note it on their timeline.",
    triggerType: "event",
    triggerEvent: "deal.won",
    graph: {
      nodes: [
        t,
        {
          id: "tag",
          type: "tag",
          config: { add: ["customer"], remove: ["lead"] },
        },
        {
          id: "note",
          type: "add_note",
          config: {
            body: "Became a customer. Welcome them and ask for a testimonial in 30 days.",
          },
        },
      ],
      edges: [
        { from: "t", to: "tag" },
        { from: "tag", to: "note" },
      ],
    },
  },
  {
    key: "inbound-webhook-lead",
    name: "Leads from another system",
    description:
      "Post JSON with an email address to this workflow's webhook URL (from Zapier, a landing page, anything) and get a tagged lead with a task.",
    triggerType: "webhook",
    graph: {
      nodes: [
        t,
        {
          id: "tag",
          type: "tag",
          config: { add: ["webhook-lead"], remove: [] },
        },
        {
          id: "task",
          type: "create_task",
          config: {
            title: "New lead from webhook: {{contact.email}}",
            dueInHours: 8,
          },
        },
      ],
      edges: [
        { from: "t", to: "tag" },
        { from: "tag", to: "task" },
      ],
    },
  },
  {
    key: "weekly-review-task",
    name: "Weekly pipeline review",
    description: "Every 7 days, create a task to review open deals.",
    triggerType: "schedule",
    scheduleMinutes: 7 * 24 * 60,
    graph: {
      nodes: [
        t,
        {
          id: "task",
          type: "create_task",
          config: {
            title: "Review the pipeline: chase deals stuck in a stage",
            dueInHours: 48,
          },
        },
      ],
      edges: [{ from: "t", to: "task" }],
    },
  },
];

@Controller("api/w/:workspaceId/workflow-templates")
@UseGuards(WorkspaceGuard)
export class WorkflowTemplatesController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Get()
  list() {
    return TEMPLATES.map(
      ({ key, name, description, triggerType, triggerEvent }) => ({
        key,
        name,
        description,
        triggerType,
        triggerEvent: triggerEvent ?? null,
      }),
    );
  }

  /** Copies the template into this workspace as a draft workflow (activate it after reviewing). */
  @Post(":key/use")
  async use(
    @Ctx() scope: Scope,
    @Param("key") key: string,
    @Body() body: unknown,
  ) {
    const tpl = TEMPLATES.find((x) => x.key === key);
    if (!tpl) throw new NotFoundException("Unknown template");
    const { name } = parse(
      z.object({ name: z.string().trim().min(1).max(200).optional() }),
      body ?? {},
    );
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .insert(workflows)
        .values({
          workspaceId: scope.workspaceId,
          name: name ?? tpl.name,
          triggerType: tpl.triggerType,
          triggerEvent: tpl.triggerEvent ?? null,
          scheduleMinutes: tpl.scheduleMinutes ?? null,
          webhookToken:
            tpl.triggerType === "webhook"
              ? randomBytes(24).toString("hex")
              : null,
          graph: structuredClone(tpl.graph),
        })
        .returning(),
    );
    return row!;
  }
}

/** Used by the tests: a template that does not pass the same validation as user workflows is a bug. */
export const templateProblems = (tpl: WorkflowTemplate) => {
  const parsed = graphSchema.safeParse(tpl.graph);
  return parsed.success
    ? validateGraph(tpl.graph)
    : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};
