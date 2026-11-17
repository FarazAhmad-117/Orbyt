import {
  All,
  Controller,
  Get,
  HttpException,
  Inject,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AUTH, ssoConfigured, toHeaders, type Auth } from "./auth";
import { EntitlementsService } from "./enterprise/entitlements.service";

// Bridges Nest/Fastify to better-auth's web-standard handler (sign-up, sign-in, sessions, ...).
@Controller("api/auth")
export class AuthController {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(EntitlementsService) private readonly ent: EntitlementsService,
  ) {}

  @All("*")
  async handle(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    // Single sign-on is a licensed feature: its endpoints stay closed without the "sso" license.
    // (Better Auth serves generic OAuth providers through its social-login routes.)
    const path = req.url.split("?")[0]!;
    const provider = (req.body as { provider?: unknown } | null)?.provider;
    const usesSso =
      path === "/api/auth/callback/sso" ||
      ((path === "/api/auth/sign-in/social" ||
        path === "/api/auth/link-social") &&
        provider === "sso");
    if (usesSso && !this.ent.ssoAllowed())
      throw new HttpException(
        "Single sign-on needs a license with the sso feature",
        402,
      );
    const url = new URL(req.url, `${req.protocol}://${req.headers.host}`);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const res = await this.auth.handler(
      new Request(url, {
        method: req.method,
        headers: toHeaders(req),
        body:
          hasBody && req.body != null ? JSON.stringify(req.body) : undefined,
      }),
    );
    reply.status(res.status);
    res.headers.forEach((value, key) => {
      if (key !== "set-cookie") reply.header(key, value);
    });
    const cookies = res.headers.getSetCookie(); // several cookies must stay separate headers
    if (cookies.length) reply.header("set-cookie", cookies);
    return reply.send(Buffer.from(await res.arrayBuffer()));
  }
}

/** Lets the sign-in page decide whether to show the "Sign in with SSO" button. */
@Controller("api/sso")
export class SsoController {
  constructor(
    @Inject(EntitlementsService) private readonly ent: EntitlementsService,
  ) {}

  @Get("status")
  status() {
    return {
      enabled: ssoConfigured() && this.ent.ssoAllowed(),
      name: process.env.ORBYT_SSO_NAME || "SSO", // (|| not ??: compose passes unset variables as "")
    };
  }
}
