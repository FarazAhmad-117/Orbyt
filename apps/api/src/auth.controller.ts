import { All, Controller, Inject, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AUTH, toHeaders, type Auth } from "./auth";

// Bridges Nest/Fastify to better-auth's web-standard handler (sign-up, sign-in, sessions, ...).
@Controller("api/auth")
export class AuthController {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  @All("*")
  async handle(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
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
