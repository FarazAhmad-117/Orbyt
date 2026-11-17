import { describe, expect, it } from "vitest";
import { effectiveDailyLimit, warmupDailyLimit } from "./warmup";

const day0 = new Date("2026-01-01T00:00:00Z");
const after = (days: number) => new Date(day0.getTime() + days * 86_400_000);

describe("warm-up ramp", () => {
  it("starts small, grows every day and never exceeds the target", () => {
    expect(warmupDailyLimit(day0, after(0), 100)).toBe(5);
    const week = warmupDailyLimit(day0, after(7), 1000);
    expect(week).toBeGreaterThan(15);
    expect(week).toBeLessThan(25);
    let prev = 0;
    for (let d = 0; d < 30; d++) {
      const v = warmupDailyLimit(day0, after(d), 50);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(50);
      prev = v;
    }
    expect(warmupDailyLimit(day0, after(60), 50)).toBe(50);
  });

  it("a clock before the start date does not go negative", () => {
    expect(warmupDailyLimit(day0, after(-3), 40)).toBe(5);
  });

  it("only applies while warm-up is on", () => {
    const base = { dailyLimit: 40, warmupStartedAt: day0 };
    expect(
      effectiveDailyLimit({ ...base, warmupEnabled: true }, after(0)),
    ).toBe(5);
    expect(
      effectiveDailyLimit({ ...base, warmupEnabled: false }, after(0)),
    ).toBe(40);
    expect(
      effectiveDailyLimit(
        { dailyLimit: 40, warmupEnabled: true, warmupStartedAt: null },
        after(0),
      ),
    ).toBe(40);
  });
});
