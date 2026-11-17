import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { channelAccounts, desc, eq } from "@orbyt/db";
import { z } from "zod";
import { DbService } from "../db.service";
import { encryptJson } from "../email/secrets";
import { idParam, notFoundIfEmpty, parse } from "../http";
import { AdminGuard, Ctx, type Scope, WorkspaceGuard } from "../scope";
import { ChannelsService } from "./channels.service";
import { normalizePhone } from "./providers";

const publicAccount = {
  id: channelAccounts.id,
  type: channelAccounts.type,
  name: channelAccounts.name,
  address: channelAccounts.address,
  webhookToken: channelAccounts.webhookToken,
  createdAt: channelAccounts.createdAt,
};

const createInput = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["twilio_sms", "twilio_whatsapp"]),
    name: z.string().trim().min(1).max(100),
    address: z.string().trim().min(5).max(40),
    accountSid: z
      .string()
      .trim()
      .regex(/^AC[0-9a-zA-Z]{8,64}$/, "Looks like AC…"),
    authToken: z.string().min(8).max(200),
  }),
  z.object({
    type: z.literal("retell"),
    name: z.string().trim().min(1).max(100),
    address: z.string().trim().min(5).max(40),
    apiKey: z.string().min(8).max(300),
  }),
]);

@Controller("api/w/:workspaceId/channels")
@UseGuards(WorkspaceGuard)
export class ChannelsController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(ChannelsService) private readonly channels: ChannelsService,
  ) {}

  private view(
    row: { type: string; webhookToken: string } & Record<string, unknown>,
  ) {
    const { webhookToken, ...rest } = row;
    // The token is part of the URL you paste into Twilio/Retell; it is not returned on its own.
    return {
      ...rest,
      webhookUrl: this.channels.webhookUrl({ type: row.type, webhookToken }),
    };
  }

  @Get()
  async list(@Ctx() scope: Scope) {
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .select(publicAccount)
        .from(channelAccounts)
        .orderBy(desc(channelAccounts.id)),
    );
    return rows.map((r) => this.view(r));
  }

  // Credentials are managed by signed-in users only; API keys may send but not connect accounts.
  @Post()
  @UseGuards(AdminGuard)
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(createInput, body);
    const whatsapp = d.type === "twilio_whatsapp";
    const address = (whatsapp ? "whatsapp:" : "") + normalizePhone(d.address);
    const config =
      d.type === "retell"
        ? { apiKey: d.apiKey }
        : { accountSid: d.accountSid, authToken: d.authToken };
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .insert(channelAccounts)
        .values({
          workspaceId: scope.workspaceId,
          type: d.type,
          name: d.name,
          address,
          configEnc: encryptJson(config),
          webhookToken: randomBytes(24).toString("base64url"),
        })
        .returning(publicAccount),
    );
    return this.view(row!);
  }

  @Delete(":id")
  @HttpCode(204)
  @UseGuards(AdminGuard)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .delete(channelAccounts)
        .where(eq(channelAccounts.id, id))
        .returning({ id: channelAccounts.id }),
    );
    notFoundIfEmpty(rows, "Channel");
  }

  @Post(":id/send")
  @HttpCode(200)
  send(@Ctx() scope: Scope, @Param("id") rawId: string, @Body() body: unknown) {
    const d = parse(
      z.object({
        to: z.string().trim().min(5).max(40),
        body: z.string().trim().min(1).max(1600),
      }),
      body,
    );
    return this.channels.send(scope, idParam(rawId), d.to, d.body);
  }

  @Post(":id/call")
  @HttpCode(200)
  call(@Ctx() scope: Scope, @Param("id") rawId: string, @Body() body: unknown) {
    const d = parse(
      z.object({
        to: z.string().trim().min(5).max(40),
        agentId: z.string().trim().max(100).optional(),
        contactId: z.uuid().optional(),
      }),
      body,
    );
    return this.channels.call(scope, idParam(rawId), d.to, {
      agentId: d.agentId,
      contactId: d.contactId,
    });
  }
}

/** Public inbound webhooks. Twilio's are authenticated by its request signature, Retell's by the secret URL token. */
@Controller("api/channels")
export class ChannelWebhooksController {
  constructor(
    @Inject(ChannelsService) private readonly channels: ChannelsService,
  ) {}

  @Post("twilio/:token")
  @HttpCode(200)
  @Header("content-type", "text/xml; charset=utf-8")
  async twilio(
    @Param("token") token: string,
    @Body() body: unknown,
    @Headers("x-twilio-signature") signature?: string,
  ) {
    if (!body || typeof body !== "object") throw new BadRequestException();
    const params = Object.fromEntries(
      Object.entries(body as Record<string, unknown>).map(([k, v]) => [
        k,
        String(v),
      ]),
    );
    if (!(await this.channels.receiveTwilio(token, params, signature)))
      throw new ForbiddenException("Bad signature");
    // An empty TwiML response: we do not auto-reply.
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  }

  @Post("retell/:token")
  @HttpCode(200)
  async retell(@Param("token") token: string, @Body() body: unknown) {
    if (!body || typeof body !== "object") throw new BadRequestException();
    await this.channels.receiveRetell(token, body as never);
    return { ok: true };
  }
}
