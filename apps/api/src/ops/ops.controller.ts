import { timingSafeEqual } from "node:crypto";
import {
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  NotFoundException,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { sql } from "@orbyt/db";
import type { FastifyReply } from "fastify";
import { DbService } from "../db.service";
import { metrics } from "./metrics";

const startedAt = Date.now();

/** Health for humans and uptime monitors (the cheap liveness probe stays at GET /health). */
@Controller("api")
export class OpsController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  private async probeDb() {
    const t0 = performance.now();
    try {
      await this.dbs.db.execute(sql`select 1`);
      return { ok: true, latencyMs: Math.round(performance.now() - t0) };
    } catch {
      return { ok: false, latencyMs: null };
    }
  }

  /** Readiness + a status page's data source. 503 when the database cannot be reached. */
  @Get("status")
  async status() {
    const db = await this.probeDb();
    const loop = (name: string) => {
      const ts = metrics.get("orbyt_loop_last_run_timestamp_seconds", {
        loop: name,
      });
      return { lastRunAt: ts ? new Date(ts * 1000).toISOString() : null };
    };
    const body = {
      status: db.ok ? "ok" : "down",
      version: process.env.ORBYT_VERSION || "dev",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      database: db,
      loops: {
        scheduler: loop("scheduler"),
        sync: loop("sync"),
        workflows: loop("workflows"),
      },
    };
    if (!db.ok) throw new HttpException(body, 503);
    return body;
  }

  /**
   * Prometheus scrape endpoint. Off (404) unless ORBYT_METRICS_TOKEN is set; scrapers send it as
   * `Authorization: Bearer <token>`.
   */
  @Get("metrics")
  async scrape(
    @Headers("authorization") auth: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const token = process.env.ORBYT_METRICS_TOKEN;
    if (!token) throw new NotFoundException();
    const given = Buffer.from((auth ?? "").replace(/^Bearer /i, ""));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want))
      throw new UnauthorizedException();
    const db = await this.probeDb();
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return metrics.render({
      orbyt_up: 1,
      orbyt_database_up: db.ok ? 1 : 0,
      orbyt_process_uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
      orbyt_process_resident_memory_bytes: process.memoryUsage().rss,
    });
  }
}
