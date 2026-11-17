import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { eq, mailboxes } from "@orbyt/db";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { DbService } from "../db.service";
import { AuditService } from "../enterprise/audit.service";
import { EntitlementsService } from "../enterprise/entitlements.service";
import { parse } from "../http";
import {
  AdminGuard,
  Ctx,
  type Scope,
  systemScope,
  WorkspaceGuard,
} from "../scope";
import {
  emailFromIdToken,
  exchangeCode,
  isOAuthProvider,
  providerConfig,
  redirectUri,
  type OAuthProvider,
} from "./oauth";
import { encryptJson, signToken, verifyToken } from "./secrets";

const STATE_MINUTES = 10;
const webBase = () =>
  (
    process.env.PUBLIC_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");

interface State extends Record<string, unknown> {
  w: string; // workspace
  u: string | null; // who started it
  p: OAuthProvider;
  hint: string | null;
  exp: number;
  n: string;
}

/** Start of "Connect Google / Microsoft": returns the provider's consent URL. */
@Controller("api/w/:workspaceId/mailboxes/oauth")
@UseGuards(WorkspaceGuard, AdminGuard)
export class MailboxOAuthController {
  constructor(
    @Inject(EntitlementsService) private readonly ent: EntitlementsService,
  ) {}

  /** Which providers this installation has credentials for (the UI hides the others). */
  @Get("providers")
  providers() {
    return (["google", "microsoft"] as const).map((provider) => {
      const c = providerConfig(provider);
      return { provider, configured: !!c.clientId && !!c.clientSecret };
    });
  }

  @Post("start")
  @HttpCode(200)
  async start(@Ctx() scope: Scope, @Body() body: unknown) {
    const d = parse(
      z.object({
        provider: z.enum(["google", "microsoft"]),
        loginHint: z.string().trim().toLowerCase().pipe(z.email()).optional(),
      }),
      body,
    );
    const cfg = providerConfig(d.provider);
    if (!cfg.clientId || !cfg.clientSecret)
      throw new BadRequestException(
        `${d.provider} login is not configured on this server (set ${d.provider.toUpperCase()}_CLIENT_ID and ${d.provider.toUpperCase()}_CLIENT_SECRET)`,
      );
    await this.ent.assertCanAddMailbox(scope.workspaceId);
    const state = signToken({
      w: scope.workspaceId,
      u: scope.userId,
      p: d.provider,
      hint: d.loginHint ?? null,
      exp: Date.now() + STATE_MINUTES * 60_000,
      n: randomBytes(8).toString("hex"),
    } satisfies State);
    const url = new URL(cfg.authUrl);
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: cfg.scope,
      state,
      ...(d.loginHint ? { login_hint: d.loginHint } : {}),
      ...cfg.extraAuthParams,
    }).toString();
    return { url: url.toString() };
  }
}

/**
 * Where the provider sends the browser back. Authenticity comes from the signed, expiring `state`
 * we issued in start(); the mailbox address comes from the provider's id_token, never from the user.
 */
@Controller("api/oauth")
export class OAuthCallbackController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EntitlementsService) private readonly ent: EntitlementsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get("callback")
  async callback(
    @Query() q: Record<string, string | undefined>,
    @Res() reply: FastifyReply,
  ) {
    const state = q.state ? verifyToken<State>(q.state) : null;
    if (!state || typeof state.exp !== "number" || state.exp < Date.now())
      return this.done(reply, null, {
        error: "This login link expired. Try again.",
      });
    const back = (params: Record<string, string>) =>
      this.done(reply, state.w, params);
    if (q.error) return back({ error: q.error_description ?? q.error });
    if (!q.code || !isOAuthProvider(state.p))
      return back({ error: "The provider sent no authorization code" });

    try {
      const tokens = await exchangeCode(state.p, q.code);
      const email = emailFromIdToken(tokens.idToken);
      if (!email)
        return back({
          error: "The provider did not tell us the mailbox address",
        });
      if (state.hint && state.hint !== email)
        return back({
          error: `You signed in as ${email}, but asked to connect ${state.hint}`,
        });

      const cfg = providerConfig(state.p);
      const scope = systemScope(state.w);
      const credentialsEnc = encryptJson({ refreshToken: tokens.refreshToken });
      const login = {
        authType: state.p,
        credentialsEnc,
        smtpHost: cfg.smtp.host,
        smtpPort: cfg.smtp.port,
        smtpSecure: cfg.smtp.secure,
        smtpUser: email,
        imapHost: cfg.imap.host,
        imapPort: cfg.imap.port,
        imapSecure: cfg.imap.secure,
        imapUser: email,
      };
      const [existing] = await this.dbs.inWorkspace(scope, (tx) =>
        tx.select().from(mailboxes).where(eq(mailboxes.email, email)),
      );
      if (existing) {
        // Reconnecting a mailbox (e.g. after access was revoked) replaces its login and revives it.
        await this.dbs.inWorkspace(scope, (tx) =>
          tx
            .update(mailboxes)
            .set({ ...login, status: "active", lastError: null })
            .where(eq(mailboxes.id, existing.id)),
        );
      } else {
        await this.ent.assertCanAddMailbox(state.w);
        await this.dbs.inWorkspace(scope, (tx) =>
          tx
            .insert(mailboxes)
            .values({ workspaceId: state.w, email, ...login }),
        );
      }
      await this.audit.record(
        { workspaceId: state.w, userId: state.u, via: "session" },
        "mailboxes.connect_oauth",
        { type: "mailboxes" },
        { provider: state.p, email },
      );
      return back({ connected: email });
    } catch (err) {
      return back({
        error:
          err instanceof Error ? err.message : "Could not connect the mailbox",
      });
    }
  }

  private done(
    reply: FastifyReply,
    workspaceId: string | null,
    params: Record<string, string>,
  ) {
    const page = workspaceId ? `/app/${workspaceId}/mailboxes` : "/app";
    return reply
      .status(302)
      .header("location", `${webBase()}${page}?${new URLSearchParams(params)}`)
      .send();
  }
}
