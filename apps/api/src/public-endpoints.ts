import { HttpException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Helpers for the endpoints visitors of a customer's website call directly (forms, chat widget).
 *
 * shortcut: the rate limiter is in memory, per API process (several replicas each count on their
 * own) and trusts X-Forwarded-For for the client address. Upgrade to a shared store (Redis) when
 * abuse of public endpoints becomes a problem.
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs = 60_000) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max)
    throw new HttpException("Too many requests, try again in a minute", 429);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000)
    for (const [k, v] of hits)
      if (v.every((t) => now - t >= windowMs)) hits.delete(k);
}

export const clientIp = (req: FastifyRequest) =>
  String(req.headers["x-forwarded-for"] ?? req.ip)
    .split(",")[0]!
    .trim();

/** Public endpoints are meant to be called from other sites' pages. */
export function allowAnyOrigin(reply: FastifyReply) {
  reply
    .header("access-control-allow-origin", "*")
    .header("access-control-allow-methods", "GET, POST, OPTIONS")
    .header("access-control-allow-headers", "content-type");
}

export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export const publicBase = () =>
  (
    process.env.PUBLIC_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
