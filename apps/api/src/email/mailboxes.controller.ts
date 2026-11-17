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
import { desc, eq, mailboxes } from "@orbyt/db";
import { z } from "zod";
import { DbService } from "../db.service";
import { idParam, notFoundIfEmpty, parse } from "../http";
import { AdminGuard, Ctx, type Scope, WorkspaceGuard } from "../scope";
import { MailService, type MailboxRow } from "./mail.service";
import { encryptJson } from "./secrets";

// Never includes credentials_enc.
export const publicMailbox = {
  id: mailboxes.id,
  email: mailboxes.email,
  displayName: mailboxes.displayName,
  smtpHost: mailboxes.smtpHost,
  smtpPort: mailboxes.smtpPort,
  smtpSecure: mailboxes.smtpSecure,
  smtpUser: mailboxes.smtpUser,
  imapHost: mailboxes.imapHost,
  imapPort: mailboxes.imapPort,
  imapSecure: mailboxes.imapSecure,
  imapUser: mailboxes.imapUser,
  dailyLimit: mailboxes.dailyLimit,
  hourlyLimit: mailboxes.hourlyLimit,
  status: mailboxes.status,
  lastError: mailboxes.lastError,
  lastSyncAt: mailboxes.lastSyncAt,
  createdAt: mailboxes.createdAt,
};

const endpoint = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  user: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(500),
});
const createInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  displayName: z.string().trim().max(100).nullish(),
  smtp: endpoint,
  imap: endpoint,
  dailyLimit: z.number().int().min(1).max(2000).default(30),
  hourlyLimit: z.number().int().min(1).max(500).default(10),
  // Set false to save without contacting the servers (e.g. while they are being set up).
  verify: z.boolean().default(true),
});
const patchInput = z.object({
  displayName: z.string().trim().max(100).nullish(),
  dailyLimit: z.number().int().min(1).max(2000).optional(),
  hourlyLimit: z.number().int().min(1).max(500).optional(),
  status: z.enum(["active", "paused"]).optional(),
  smtp: endpoint.partial().optional(),
  imap: endpoint.partial().optional(),
});

@Controller("api/w/:workspaceId/mailboxes")
@UseGuards(WorkspaceGuard)
export class MailboxesController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  private async hostsAllowed(...hosts: (string | undefined)[]) {
    for (const host of hosts)
      if (host)
        try {
          await this.mail.assertHostAllowed(host);
        } catch (err) {
          throw new BadRequestException(`${host}: ${(err as Error).message}`);
        }
  }

  @Get()
  list(@Ctx() scope: Scope) {
    return this.dbs.inWorkspace(scope, (tx) =>
      tx.select(publicMailbox).from(mailboxes).orderBy(desc(mailboxes.id)),
    );
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(createInput, body);
    await this.hostsAllowed(d.smtp.host, d.imap.host);
    const values = {
      workspaceId: scope.workspaceId,
      email: d.email,
      displayName: d.displayName ?? null,
      smtpHost: d.smtp.host,
      smtpPort: d.smtp.port,
      smtpSecure: d.smtp.secure,
      smtpUser: d.smtp.user,
      imapHost: d.imap.host,
      imapPort: d.imap.port,
      imapSecure: d.imap.secure,
      imapUser: d.imap.user,
      credentialsEnc: encryptJson({
        smtpPass: d.smtp.password,
        imapPass: d.imap.password,
      }),
      dailyLimit: d.dailyLimit,
      hourlyLimit: d.hourlyLimit,
    };
    if (d.verify) {
      const result = await this.mail.verify({
        ...values,
        id: "",
        status: "active",
      } as MailboxRow);
      if (result.smtp || result.imap)
        throw new BadRequestException({
          message: "Could not connect to the mail servers",
          smtp: result.smtp,
          imap: result.imap,
        });
    }
    const [row] = await this.dbs.inWorkspace(scope, (tx) =>
      tx.insert(mailboxes).values(values).returning(publicMailbox),
    );
    return row;
  }

  @Patch(":id")
  @UseGuards(AdminGuard)
  async update(
    @Ctx() scope: Scope,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const id = idParam(rawId);
    const d = parse(patchInput, body);
    await this.hostsAllowed(d.smtp?.host, d.imap?.host);
    return this.dbs.inWorkspace(scope, async (tx) => {
      const [current] = await tx
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.id, id));
      if (!current) notFoundIfEmpty([], "Mailbox");
      const set: Partial<typeof mailboxes.$inferInsert> = {};
      if (d.displayName !== undefined) set.displayName = d.displayName;
      if (d.dailyLimit !== undefined) set.dailyLimit = d.dailyLimit;
      if (d.hourlyLimit !== undefined) set.hourlyLimit = d.hourlyLimit;
      if (d.status !== undefined) {
        set.status = d.status;
        if (d.status === "active") set.lastError = null;
      }
      if (d.smtp) {
        if (d.smtp.host !== undefined) set.smtpHost = d.smtp.host;
        if (d.smtp.port !== undefined) set.smtpPort = d.smtp.port;
        if (d.smtp.secure !== undefined) set.smtpSecure = d.smtp.secure;
        if (d.smtp.user !== undefined) set.smtpUser = d.smtp.user;
      }
      if (d.imap) {
        if (d.imap.host !== undefined) set.imapHost = d.imap.host;
        if (d.imap.port !== undefined) set.imapPort = d.imap.port;
        if (d.imap.secure !== undefined) set.imapSecure = d.imap.secure;
        if (d.imap.user !== undefined) set.imapUser = d.imap.user;
      }
      if (d.smtp?.password || d.imap?.password) {
        const creds = this.mail.credentials(current!);
        set.credentialsEnc = encryptJson({
          smtpPass: d.smtp?.password ?? creds.smtpPass,
          imapPass: d.imap?.password ?? creds.imapPass,
        });
      }
      if (Object.keys(set).length === 0)
        return (
          await tx
            .select(publicMailbox)
            .from(mailboxes)
            .where(eq(mailboxes.id, id))
        )[0]!;
      return (
        await tx
          .update(mailboxes)
          .set(set)
          .where(eq(mailboxes.id, id))
          .returning(publicMailbox)
      )[0]!;
    });
  }

  /** Tries both logins now; updates the mailbox status/last error accordingly. */
  @Post(":id/test")
  @HttpCode(200)
  async test(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const [mailbox] = await this.dbs.inWorkspace(scope, (tx) =>
      tx.select().from(mailboxes).where(eq(mailboxes.id, id)),
    );
    if (!mailbox) notFoundIfEmpty([], "Mailbox");
    const result = await this.mail.verify(mailbox!);
    const error = result.smtp ?? result.imap;
    await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .update(mailboxes)
        .set({ status: error ? "error" : "active", lastError: error })
        .where(eq(mailboxes.id, id)),
    );
    return { ok: !error, ...result };
  }

  @Delete(":id")
  @HttpCode(204)
  @UseGuards(AdminGuard)
  async remove(@Ctx() scope: Scope, @Param("id") rawId: string) {
    const id = idParam(rawId);
    const rows = await this.dbs.inWorkspace(scope, (tx) =>
      tx
        .delete(mailboxes)
        .where(eq(mailboxes.id, id))
        .returning({ id: mailboxes.id }),
    );
    notFoundIfEmpty(rows, "Mailbox");
  }
}
