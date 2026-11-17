export interface SendWindow {
  timezone: string;
  startHour: number; // inclusive, 0-23
  endHour: number; // exclusive, 1-24
  days: number[]; // ISO weekdays, 1 = Monday ... 7 = Sunday
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function localParts(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const weekday =
    WEEKDAYS.indexOf(parts.find((p) => p.type === "weekday")!.value) + 1;
  return { hour, weekday };
}

/** Is `at` inside the recipient-agnostic sending window of the sequence's timezone? */
export function inWindow(at: Date, w: SendWindow): boolean {
  const { hour, weekday } = localParts(at, w.timezone);
  return w.days.includes(weekday) && hour >= w.startHour && hour < w.endHour;
}

/** Earliest moment (15-minute resolution) at or after `from` that is inside the window. */
export function nextWindowStart(from: Date, w: SendWindow): Date {
  const STEP = 15 * 60_000;
  let t = Math.ceil(from.getTime() / STEP) * STEP;
  for (let i = 0; i < 8 * 24 * 4; i++, t += STEP)
    if (inWindow(new Date(t), w)) return new Date(t);
  return new Date(from.getTime() + 24 * 3_600_000); // window can never open (e.g. no days): retry tomorrow
}

/** ±10% jitter so a batch of emails does not leave on the same second. */
export function jitter(ms: number): number {
  if (process.env.ORBYT_NO_JITTER === "true") return ms;
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}
