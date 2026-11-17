import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import {
  aiPrompts,
  aiProviders,
  aiSettings,
  asc,
  desc,
  eq,
  ne,
  sql,
} from "@orbyt/db";
import { z } from "zod";
import { DbService } from "../db.service";
import { encryptJson } from "../email/secrets";
import { idParam, notFoundIfEmpty, parse } from "../http";
import { AdminGuard, Ctx, type Scope, WorkspaceGuard } from "../scope";
import { assertPublicUrl } from "../ssrf";
import { AiService, PROMPT_DEFAULTS } from "./ai.service";

// The API key never leaves the server: only whether one is stored.
const publicProvider = {
  id: aiProviders.id,
  name: aiProviders.name,
  provider: aiProviders.provider,
  model: aiProviders.model,
  baseUrl: aiProviders.baseUrl,
  isDefault: aiProviders.isDefault,
  hasKey: sql<boolean>`${aiProviders.apiKeyEnc} is not null`,
  createdAt: aiProviders.createdAt,
};

const providerInput = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.enum(["anthropic", "openai", "gemini", "ollama"]),
  model: z.string().trim().min(1).max(200),
  baseUrl: z.url().max(500).nullish(),
  apiKey: z.string().min(1).max(500).nullish(),
  isDefault: z.boolean().optional(),
});

async function checkBaseUrl(url?: string | null) {
  if (!url) return;
  try {
    await assertPublicUrl(url);
  } catch (err) {
    throw new BadRequestException(`baseUrl: ${(err as Error).message}`);
  }
}

// Provider keys, caps and prompts are managed by signed-in users only (an API key must not read or
// change them).
@Controller("api/w/:workspaceId/ai")
@UseGuards(WorkspaceGuard, AdminGuard)
export class AiAdminController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  @Get("providers")
  providers(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, (tx) =>
      tx
        .select(publicProvider)
        .from(aiProviders)
        .orderBy(desc(aiProviders.isDefault), asc(aiProviders.createdAt)),
    );
  }

  @Post("providers")
  async createProvider(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(providerInput, body);
    if (d.provider !== "ollama" && !d.apiKey)
      throw new BadRequestException("apiKey is required for this provider");
    await checkBaseUrl(d.baseUrl);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const existing = await tx
        .select({ id: aiProviders.id })
        .from(aiProviders);
      const makeDefault = d.isDefault || existing.length === 0;
      if (makeDefault) await tx.update(aiProviders).set({ isDefault: false });
      const [row] = await tx
        .insert(aiProviders)
        .values({
          workspaceId: scope.workspaceId,
          name: d.name,
          provider: d.provider,
          model: d.model,
          baseUrl: d.baseUrl ?? null,
          apiKeyEnc: d.apiKey ? encryptJson({ key: d.apiKey }) : null,
          isDefault: makeDefault,
        })
        .returning(publicProvider);
      return row!;
    });
  }

  @Patch("providers/:id")
  async updateProvider(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const d = parse(providerInput.partial(), body);
    await checkBaseUrl(d.baseUrl);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const set: Partial<typeof aiProviders.$inferInsert> = {};
      if (d.name !== undefined) set.name = d.name;
      if (d.provider !== undefined) set.provider = d.provider;
      if (d.model !== undefined) set.model = d.model;
      if (d.baseUrl !== undefined) set.baseUrl = d.baseUrl;
      if (d.apiKey) set.apiKeyEnc = encryptJson({ key: d.apiKey });
      if (d.isDefault === true) {
        await tx
          .update(aiProviders)
          .set({ isDefault: false })
          .where(ne(aiProviders.id, id));
        set.isDefault = true;
      }
      const rows = Object.keys(set).length
        ? await tx
            .update(aiProviders)
            .set(set)
            .where(eq(aiProviders.id, id))
            .returning(publicProvider)
        : await tx
            .select(publicProvider)
            .from(aiProviders)
            .where(eq(aiProviders.id, id));
      return notFoundIfEmpty(rows, "Provider");
    });
  }

  @Delete("providers/:id")
  @HttpCode(204)
  async removeProvider(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .delete(aiProviders)
        .where(eq(aiProviders.id, id))
        .returning({ id: aiProviders.id }),
    );
    notFoundIfEmpty(rows, "Provider");
  }

  /** A tiny real call, so a wrong key/model shows up now rather than in the middle of a workflow. */
  @Post("providers/:id/test")
  @HttpCode(200)
  async testProvider(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const out = await this.ai.run(scope, {
      kind: "test",
      providerId: id,
      user: "Reply with the single word: pong",
      maxTokens: 16,
      temperature: 0,
    });
    return {
      ok: true,
      reply: out.text.trim().slice(0, 100),
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      model: out.model,
    };
  }

  @Get("usage")
  usage(@Ctx() scope: Scope) {
    return this.ai.usage(scope);
  }

  @Put("settings")
  async setSettings(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(
      z.object({
        monthlyTokenCap: z.number().int().min(0).max(2_000_000_000).nullable(),
      }),
      body,
    );
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .insert(aiSettings)
        .values({
          workspaceId: scope.workspaceId,
          monthlyTokenCap: d.monthlyTokenCap,
        })
        .onConflictDoUpdate({
          target: aiSettings.workspaceId,
          set: { monthlyTokenCap: d.monthlyTokenCap },
        })
        .returning(),
    );
    return { monthlyTokenCap: row!.monthlyTokenCap };
  }

  @Get("prompts")
  async prompts(@Ctx() scope: Scope) {
    const overrides = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(aiPrompts),
    );
    return Object.entries(PROMPT_DEFAULTS).map(([key, template]) => ({
      key,
      default: template,
      override: overrides.find((o) => o.key === key)?.template ?? null,
    }));
  }

  @Put("prompts/:key")
  async setPrompt(
    @Ctx() scope: Scope,
    @Param("key") key: string,
    @Body() body: unknown,
  ) {
    if (!(key in PROMPT_DEFAULTS))
      throw new NotFoundException("Unknown prompt");
    const { template } = parse(
      z.object({ template: z.string().trim().min(10).max(8000) }),
      body,
    );
    await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .insert(aiPrompts)
        .values({ workspaceId: scope.workspaceId, key, template })
        .onConflictDoUpdate({
          target: [aiPrompts.workspaceId, aiPrompts.key],
          set: { template },
        }),
    );
    return { key, override: template };
  }

  @Delete("prompts/:key")
  @HttpCode(204)
  async resetPrompt(@Ctx() scope: Scope, @Param("key") key: string) {
    await this.dbs.inWorkspace(scope, (tx) =>
      tx.delete(aiPrompts).where(eq(aiPrompts.key, key)),
    );
  }
}

// Usable with an API key too: running a feature is not the same as managing the provider.
@Controller("api/w/:workspaceId/ai/conversations")
@UseGuards(WorkspaceGuard)
export class AiFeaturesController {
  constructor(@Inject(AiService) private readonly ai: AiService) {}

  /** Labels the latest reply (interested / not interested / question / ...). Saved on the conversation by default. */
  @Post(":id/classify")
  @HttpCode(200)
  classify(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const { save } = parse(
      z.object({ save: z.boolean().default(true) }),
      body ?? {},
    );
    return this.ai.classifyReply(scope, idParam(rawId), save);
  }

  /** Drafts a reply. Nothing is sent: the draft goes into the reply box for a human to review. */
  @Post(":id/draft")
  @HttpCode(200)
  draft(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const { instruction } = parse(
      z.object({ instruction: z.string().trim().max(2000).optional() }),
      body ?? {},
    );
    return this.ai.draftReply(scope, idParam(rawId), instruction);
  }
}
