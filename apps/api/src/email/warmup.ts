const START_PER_DAY = 5;
const GROWTH_PER_DAY = 1.2;

/**
 * Daily send cap while a mailbox warms up: 5 on day one, growing 20% a day (about 18 after a
 * week, 64 after two, 230 after three), never above the mailbox's own dailyLimit. A new
 * mailbox that suddenly sends hundreds of cold emails gets throttled or flagged; this ramps it.
 * shortcut: a fixed curve; upgrade to one that slows down when bounce/spam rates rise.
 */
export function warmupDailyLimit(
  startedAt: Date,
  now: Date,
  target: number,
): number {
  const days = Math.max(
    0,
    Math.floor((now.getTime() - startedAt.getTime()) / 86_400_000),
  );
  return Math.min(target, Math.ceil(START_PER_DAY * GROWTH_PER_DAY ** days));
}

/** The limit the scheduler enforces today for this mailbox. */
export function effectiveDailyLimit(
  b: {
    dailyLimit: number;
    warmupEnabled: boolean;
    warmupStartedAt: Date | null;
  },
  now: Date,
): number {
  return b.warmupEnabled && b.warmupStartedAt
    ? warmupDailyLimit(b.warmupStartedAt, now, b.dailyLimit)
    : b.dailyLimit;
}
