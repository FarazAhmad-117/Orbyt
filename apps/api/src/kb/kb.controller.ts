import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Options,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { and, chatAgents, desc, eq, kbDocuments, sql } from "@orbyt/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ContactsService } from "../contacts.service";
import { DbService } from "../db.service";
import { EventsService } from "../events.service";
import { idParam, notFoundIfEmpty, parse } from "../http";
import {
  allowAnyOrigin,
  clientIp,
  publicBase,
  rateLimit,
} from "../public-endpoints";
import {
  AdminGuard,
  Ctx,
  type Scope,
  systemScope,
  WorkspaceGuard,
} from "../scope";
import { ChatService } from "./chat.service";

const MAX_DOCS = 500;
const docInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(100_000),
});
const turn = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2000),
});

@Controller("api/w/:workspaceId/kb")
@UseGuards(WorkspaceGuard)
export class KbController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(ChatService) private readonly chat: ChatService,
  ) {}

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, (tx) =>
      tx
        .select({
          id: kbDocuments.id,
          title: kbDocuments.title,
          size: sql<number>`length(${kbDocuments.body})`,
          updatedAt: kbDocuments.updatedAt,
        })
        .from(kbDocuments)
        .orderBy(desc(kbDocuments.updatedAt)),
    );
  }

  @Post()
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(docInput, body);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(kbDocuments);
      if (n >= MAX_DOCS)
        throw new BadRequestException(`At most ${MAX_DOCS} documents`);
      const [row] = await tx
        .insert(kbDocuments)
        .values({ workspaceId: scope.workspaceId, ...d })
        .returning();
      return row!;
    });
  }

  @Get(":id")
  async get(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(kbDocuments).where(eq(kbDocuments.id, id)),
    );
    return notFoundIfEmpty(rows, "Document");
  }

  @Patch(":id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const d = parse(docInput.partial(), body);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      Object.keys(d).length
        ? tx
            .update(kbDocuments)
            .set(d)
            .where(eq(kbDocuments.id, id))
            .returning()
        : tx.select().from(kbDocuments).where(eq(kbDocuments.id, id)),
    );
    return notFoundIfEmpty(rows, "Document");
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .delete(kbDocuments)
        .where(eq(kbDocuments.id, id))
        .returning({ id: kbDocuments.id }),
    );
    notFoundIfEmpty(rows, "Document");
  }

  /** Try the assistant from inside the app (same answer path as the public chat). */
  @Post("ask")
  @HttpCode(200)
  ask(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(
      z.object({
        question: z.string().trim().min(1).max(2000),
        history: z.array(turn).max(10).default([]),
      }),
      body,
    );
    return this.chat.answer(scope, {
      question: d.question,
      history: d.history,
    });
  }
}

const agentInput = z.object({
  name: z.string().trim().min(1).max(100),
  systemPrompt: z.string().max(4000).default(""),
  welcome: z.string().trim().min(1).max(300).optional(),
  status: z.enum(["active", "paused"]).optional(),
});
const presentAgent = (
  workspaceId: string,
  a: typeof chatAgents.$inferSelect,
) => ({
  id: a.id,
  name: a.name,
  systemPrompt: a.systemPrompt,
  welcome: a.welcome,
  status: a.status,
  publicToken: a.publicToken,
  url: `${publicBase()}/api/chat/${workspaceId}/${a.publicToken}`,
  createdAt: a.createdAt,
});

@Controller("api/w/:workspaceId/chat-agents")
@UseGuards(WorkspaceGuard)
export class ChatAgentsController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Get()
  async list(@Ctx() scope: Scope) {
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(chatAgents).orderBy(desc(chatAgents.id)),
    );
    return rows.map((a) => presentAgent(scope.workspaceId, a));
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(agentInput, body);
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .insert(chatAgents)
        .values({
          workspaceId: scope.workspaceId,
          name: d.name,
          systemPrompt: d.systemPrompt,
          ...(d.welcome ? { welcome: d.welcome } : {}),
          publicToken: randomBytes(24).toString("hex"),
        })
        .returning(),
    );
    return presentAgent(scope.workspaceId, row!);
  }

  @Patch(":id")
  @UseGuards(AdminGuard)
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const d = parse(agentInput.partial(), body);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      Object.keys(d).length
        ? tx.update(chatAgents).set(d).where(eq(chatAgents.id, id)).returning()
        : tx.select().from(chatAgents).where(eq(chatAgents.id, id)),
    );
    return presentAgent(scope.workspaceId, notFoundIfEmpty(rows, "Chat agent"));
  }

  @Delete(":id")
  @HttpCode(204)
  @UseGuards(AdminGuard)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .delete(chatAgents)
        .where(eq(chatAgents.id, id))
        .returning({ id: chatAgents.id }),
    );
    notFoundIfEmpty(rows, "Chat agent");
  }
}

/**
 * The visitor-facing chat endpoint (a website widget calls it). The unguessable token selects the
 * agent; the answer comes from the workspace's knowledge base and its own AI provider and cap.
 */
@Controller("api/chat")
export class PublicChatController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private async find(workspaceId: string, token: string) {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId) || !/^[0-9a-f]{48}$/.test(token))
      throw new NotFoundException();
    const [agent] = await this.dbs.inWorkspace(systemScope(workspaceId), (tx) =>
      tx
        .select()
        .from(chatAgents)
        .where(
          and(
            eq(chatAgents.publicToken, token),
            eq(chatAgents.status, "active"),
          ),
        ),
    );
    if (!agent) throw new NotFoundException();
    return agent;
  }

  @Options(":workspaceId/:token")
  @HttpCode(204)
  preflight(@Res({ passthrough: true }) reply: FastifyReply) {
    allowAnyOrigin(reply);
  }

  @Get(":workspaceId/:token")
  async info(
    @Param("workspaceId") workspaceId: string,
    @Param("token") token: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    allowAnyOrigin(reply);
    const a = await this.find(workspaceId, token);
    return { name: a.name, welcome: a.welcome };
  }

  @Post(":workspaceId/:token")
  @HttpCode(200)
  async message(
    @Param("workspaceId") workspaceId: string,
    @Param("token") token: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    allowAnyOrigin(reply);
    const agent = await this.find(workspaceId, token);
    rateLimit(`chat:${token}:${clientIp(req)}`, 20);
    const d = parse(
      z.object({
        message: z.string().trim().min(1).max(2000),
        history: z.array(turn).max(10).default([]),
        email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
        name: z.string().trim().min(1).max(200).optional(),
      }),
      body,
    );
    const scope = systemScope(workspaceId);
    let contactId: string | null = null;
    if (d.email) {
      const { contact } = await this.contacts.findOrCreate(scope, {
        email: d.email,
        name: d.name,
        source: `chat: ${agent.name}`.slice(0, 100),
      });
      contactId = contact.id;
    }
    let result;
    try {
      result = await this.chat.answer(scope, {
        question: d.message,
        history: d.history,
        instructions: agent.systemPrompt || undefined,
      });
    } catch (err) {
      // Never leak provider/config details to the public; only say whether to retry.
      if (err instanceof HttpException && err.getStatus() === 429)
        throw new HttpException("The assistant is busy, try again later", 429);
      console.error("[chat]", err);
      throw new HttpException("The assistant is unavailable right now", 503);
    }
    await this.events.emit(scope, {
      type: "chat.message",
      contactId,
      data: { agentId: agent.id, question: d.message.slice(0, 500) },
    });
    return result;
  }
}
