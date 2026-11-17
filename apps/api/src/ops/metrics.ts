/**
 * A tiny in-process metrics registry rendered in the Prometheus text format (GET /api/metrics).
 * Counters and gauges are per API process: with several replicas, scrape each one and sum.
 */
type Labels = Record<string, string>;

const HELP: Record<string, { type: "counter" | "gauge"; help: string }> = {
  orbyt_emails_sent_total: {
    type: "counter",
    help: "Emails sent by the sequence scheduler",
  },
  orbyt_inbound_messages_total: {
    type: "counter",
    help: "Inbound messages processed by inbox sync",
  },
  orbyt_workflow_steps_total: {
    type: "counter",
    help: "Workflow steps executed",
  },
  orbyt_loop_errors_total: {
    type: "counter",
    help: "Unexpected errors in a background loop",
  },
  orbyt_loop_last_run_timestamp_seconds: {
    type: "gauge",
    help: "When a background loop last finished a pass",
  },
};

const key = (name: string, labels?: Labels) =>
  name +
  (labels && Object.keys(labels).length
    ? `{${Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "")}"`)
        .join(",")}}`
    : "");

export class Metrics {
  private readonly values = new Map<string, number>();

  inc(name: string, by = 1, labels?: Labels) {
    const k = key(name, labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  set(name: string, value: number, labels?: Labels) {
    this.values.set(key(name, labels), value);
  }

  get(name: string, labels?: Labels) {
    return this.values.get(key(name, labels));
  }

  /** Extra gauges computed at scrape time (db latency, uptime) are passed in by the controller. */
  render(extra: Record<string, number> = {}): string {
    const lines: string[] = [];
    const all = new Map([...this.values, ...Object.entries(extra)]);
    const names = [...new Set([...all.keys()].map((k) => k.split("{")[0]!))];
    for (const name of names.sort()) {
      const meta = HELP[name];
      lines.push(`# HELP ${name} ${meta?.help ?? name}`);
      lines.push(`# TYPE ${name} ${meta?.type ?? "gauge"}`);
      for (const [k, v] of all)
        if (k === name || k.startsWith(`${name}{`)) lines.push(`${k} ${v}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

export const metrics = new Metrics();
