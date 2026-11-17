import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchedulerService } from "../email/scheduler.service";
import { createTestApp, type TestApp } from "../test-utils";
import { WorkflowService } from "../workflows/workflow.service";
import { Metrics } from "./metrics";

describe("metrics registry", () => {
  it("renders counters and gauges with labels in the Prometheus text format", () => {
    const m = new Metrics();
    m.inc("orbyt_emails_sent_total", 2);
    m.inc("orbyt_emails_sent_total");
    m.inc("orbyt_loop_errors_total", 1, { loop: 'sched"uler' });
    m.set("orbyt_loop_last_run_timestamp_seconds", 1700000000, {
      loop: "sync",
    });
    const text = m.render({ orbyt_up: 1 });
    expect(text).toContain("# TYPE orbyt_emails_sent_total counter");
    expect(text).toContain("orbyt_emails_sent_total 3\n");
    expect(text).toContain('orbyt_loop_errors_total{loop="scheduler"} 1');
    expect(text).toContain(
      'orbyt_loop_last_run_timestamp_seconds{loop="sync"} 1700000000',
    );
    expect(text).toContain("# TYPE orbyt_up gauge\norbyt_up 1\n");
    expect(m.get("orbyt_emails_sent_total")).toBe(3);
  });
});

let t: TestApp;
const NO_WORKSPACE = "00000000-0000-4000-8000-000000000000";
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  delete process.env.ORBYT_METRICS_TOKEN;
  await t.cleanup();
});

describe("status and metrics endpoints", () => {
  it("reports readiness with the database check and when each loop last ran", async () => {
    const before = (await t.request("GET", "/api/status")).json();
    expect(before).toMatchObject({
      status: "ok",
      database: { ok: true },
      version: "dev",
    });
    expect(before.database.latencyMs).toBeGreaterThanOrEqual(0);

    await t.app.get(SchedulerService).tick(new Date(), NO_WORKSPACE);
    await t.app.get(WorkflowService).tick(new Date(), NO_WORKSPACE);
    const after = (await t.request("GET", "/api/status")).json();
    expect(after.loops.scheduler.lastRunAt).toMatch(/^\d{4}-/);
    expect(after.loops.workflows.lastRunAt).toMatch(/^\d{4}-/);
    // The cheap liveness probe is unchanged.
    expect((await t.request("GET", "/health")).json()).toEqual({
      status: "ok",
    });
  });

  it("serves Prometheus metrics only with the configured token", async () => {
    delete process.env.ORBYT_METRICS_TOKEN;
    expect((await t.request("GET", "/api/metrics")).statusCode).toBe(404);

    process.env.ORBYT_METRICS_TOKEN = "scrape-secret";
    expect((await t.request("GET", "/api/metrics")).statusCode).toBe(401);
    expect(
      (
        await t.request("GET", "/api/metrics", {
          headers: { authorization: "Bearer wrong-secret" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await t.request("GET", "/api/metrics", {
          headers: { authorization: "Bearer short" },
        })
      ).statusCode,
    ).toBe(401);

    await t.app.get(SchedulerService).tick(new Date(), NO_WORKSPACE);
    const ok = await t.request("GET", "/api/metrics", {
      headers: { authorization: "Bearer scrape-secret" },
    });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers["content-type"])).toContain("text/plain");
    expect(ok.body).toContain("orbyt_up 1");
    expect(ok.body).toContain("orbyt_database_up 1");
    expect(ok.body).toContain("orbyt_process_resident_memory_bytes");
    expect(ok.body).toContain(
      'orbyt_loop_last_run_timestamp_seconds{loop="scheduler"}',
    );
  });
});
