import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import {
  and,
  emailEvents,
  enrollments,
  eq,
  inArray,
  suppressions,
  withWorkspace,
} from "@orbyt/db";
import type { FastifyReply } from "fastify";
import { DbService } from "../db.service";
import { EventsService } from "../events.service";
import { systemScope } from "../scope";
import { verifyToken } from "./secrets";

// 1x1 transparent GIF.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

interface LinkToken extends Record<string, unknown> {
  k: "o" | "c" | "u";
  w: string; // workspace
  m?: string; // message
  e?: string; // enrollment
  c?: string; // contact
  u?: string; // click target
  em?: string; // email (unsubscribe)
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">${body}</body></html>`;

/**
 * Public, unauthenticated endpoints reached from emails. Every link carries an HMAC-signed token
 * (workspace, message, contact, ...), so nothing here can be forged or used to read data.
 */
@Controller("api")
export class PublicController {
  constructor(
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private token(raw: string, kind: LinkToken["k"]): LinkToken {
    const t = verifyToken<LinkToken>(raw);
    if (!t || t.k !== kind || typeof t.w !== "string")
      throw new NotFoundException();
    return t;
  }

  private record(
    t: LinkToken,
    type: "open" | "click",
    data: Record<string, unknown>,
  ) {
    return withWorkspace(this.dbs.db, t.w, (tx) =>
      tx.insert(emailEvents).values({
        workspaceId: t.w,
        type,
        contactId: t.c ?? null,
        enrollmentId: t.e ?? null,
        messageId: t.m ?? null,
        data,
      }),
    ).catch(() => undefined); // a deleted message/contact must not break the pixel or the redirect
  }

  @Get("t/o/:token")
  async open(@Param("token") raw: string, @Res() reply: FastifyReply) {
    const t = this.token(raw, "o");
    await this.record(t, "open", {});
    return reply
      .header("content-type", "image/gif")
      .header("cache-control", "no-store, max-age=0")
      .send(PIXEL);
  }

  @Get("t/c/:token")
  async click(@Param("token") raw: string, @Res() reply: FastifyReply) {
    const t = this.token(raw, "c");
    // The target is inside the signed token, so this cannot be abused as an open redirect.
    if (typeof t.u !== "string" || !/^https?:\/\//i.test(t.u))
      throw new BadRequestException();
    await this.record(t, "click", { url: t.u });
    return reply.redirect(t.u, 302);
  }

  // GET only shows a confirmation button: mail scanners that pre-fetch links must not unsubscribe people.
  @Get("u/:token")
  @Header("content-type", "text/html; charset=utf-8")
  unsubscribePage(@Param("token") raw: string) {
    const t = this.token(raw, "u");
    return page(
      "Unsubscribe",
      `<h1>Unsubscribe</h1><p>Stop all emails to <b>${String(t.em ?? "").replace(/[<>&"]/g, "")}</b>?</p>` +
        `<form method="post"><button type="submit" style="padding:.6rem 1rem">Yes, unsubscribe me</button></form>`,
    );
  }

  // RFC 8058 one-click: mail clients POST `List-Unsubscribe=One-Click` here; the page form does too.
  @Post("u/:token")
  @HttpCode(200)
  @Header("content-type", "text/html; charset=utf-8")
  async unsubscribe(@Param("token") raw: string) {
    const t = this.token(raw, "u");
    const email = String(t.em ?? "").toLowerCase();
    if (!email) throw new BadRequestException();
    await withWorkspace(this.dbs.db, t.w, async (tx) => {
      await tx
        .insert(suppressions)
        .values({ workspaceId: t.w, email, reason: "unsubscribe" })
        .onConflictDoNothing();
      if (t.c)
        await tx
          .update(enrollments)
          .set({ status: "unsubscribed", nextSendAt: null })
          .where(
            and(
              eq(enrollments.contactId, t.c),
              inArray(enrollments.status, ["active", "paused"]),
            ),
          );
      await tx.insert(emailEvents).values({
        workspaceId: t.w,
        type: "unsubscribe",
        contactId: t.c ?? null,
        enrollmentId: t.e ?? null,
        messageId: t.m ?? null,
        data: { email },
      });
    });
    await this.events.emit(systemScope(t.w), {
      type: "contact.unsubscribed",
      contactId: t.c ?? null,
      data: { email },
    });
    return page(
      "Unsubscribed",
      `<h1>You are unsubscribed</h1><p>${email.replace(/[<>&"]/g, "")} will not receive further emails.</p>`,
    );
  }
}
