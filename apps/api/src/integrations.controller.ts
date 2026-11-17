import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { apiKeys, desc, eq, webhooks } from "@orbyt/db";
import { z } from "zod";
import { generateApiKey } from "./apikeys";
import { DbService } from "./db.service";
import { idParam, notFoundIfEmpty, parse } from "./http";
import { AdminGuard, Ctx, type Scope, WorkspaceGuard } from "./scope";
import { assertPublicUrl } from "./ssrf";
import { deliverWebhook, eventPayload } from "./webhooks.service";

// Managing keys/webhooks needs a signed-in user: an API key must not be able to mint more keys.
@Controller("api/w/:workspaceId/api-keys")
@UseGuards(WorkspaceGuard, AdminGuard)
export class ApiKeysController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, (tx) =>
      tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          lastUsedAt: apiKeys.lastUsedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .orderBy(desc(apiKeys.id)),
    );
  }

  /** The raw key is returned exactly once; only its hash is stored. */
  @Post()
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const { name } = parse(
      z.object({ name: z.string().trim().min(1).max(100) }),
      body,
    );
    const key = generateApiKey();
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .insert(apiKeys)
        .values({
          workspaceId: scope.workspaceId,
          name,
          prefix: key.prefix,
          hash: key.hash,
          createdBy: scope.userId,
        })
        .returning({
          id: apiKeys.id,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
        }),
    );
    return { ...row!, key: key.raw };
  }

  @Delete(":id")
  @HttpCode(204)
  async revoke(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .delete(apiKeys)
        .where(eq(apiKeys.id, id))
        .returning({ id: apiKeys.id }),
    );
    notFoundIfEmpty(rows, "API key");
  }
}

const eventName = z
  .string()
  .regex(/^(\*|[a-z_]+\.[a-z_]+)$/, "Use `*` or an event like contact.created");
const hookInput = z.object({
  url: z.url(),
  events: z.array(eventName).min(1).max(50),
});

async function safeUrl(url: string) {
  try {
    await assertPublicUrl(url);
  } catch (err) {
    throw new BadRequestException((err as Error).message);
  }
}

const publicHook = {
  id: webhooks.id,
  url: webhooks.url,
  events: webhooks.events,
  active: webhooks.active,
  createdAt: webhooks.createdAt,
};

@Controller("api/w/:workspaceId/webhooks")
@UseGuards(WorkspaceGuard, AdminGuard)
export class WebhooksController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, (tx) =>
      tx.select(publicHook).from(webhooks).orderBy(desc(webhooks.id)),
    );
  }

  /** The signing secret is returned exactly once, here. */
  @Post()
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const data = parse(hookInput, body);
    await safeUrl(data.url);
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .insert(webhooks)
        .values({
          workspaceId: scope.workspaceId,
          url: data.url,
          events: data.events,
          secret,
        })
        .returning(publicHook),
    );
    return { ...row!, secret };
  }

  @Patch(":id")
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const data = parse(
      hookInput.partial().extend({ active: z.boolean().optional() }),
      body,
    );
    if (data.url) await safeUrl(data.url);
    const set: Partial<typeof webhooks.$inferInsert> = {};
    if (data.url !== undefined) set.url = data.url;
    if (data.events !== undefined) set.events = data.events;
    if (data.active !== undefined) set.active = data.active;
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      Object.keys(set).length
        ? tx
            .update(webhooks)
            .set(set)
            .where(eq(webhooks.id, id))
            .returning(publicHook)
        : tx.select(publicHook).from(webhooks).where(eq(webhooks.id, id)),
    );
    return notFoundIfEmpty(rows, "Webhook");
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .delete(webhooks)
        .where(eq(webhooks.id, id))
        .returning({ id: webhooks.id }),
    );
    notFoundIfEmpty(rows, "Webhook");
  }

  /** Sends a signed `webhook.test` event right now and reports what the receiver answered. */
  @Post(":id/test")
  async test(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(webhooks).where(eq(webhooks.id, id)),
    );
    const hook = notFoundIfEmpty(rows, "Webhook");
    return deliverWebhook(
      hook,
      eventPayload(scope, { type: "webhook.test", data: { hookId: id } }),
      1,
    );
  }
}
