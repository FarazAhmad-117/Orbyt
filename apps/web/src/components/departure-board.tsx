"use client";

import { useSyncExternalStore } from "react";

// The viewer's own clock, as minutes since midnight. The server (and the first hydration pass) use a
// fixed 09:41 so nothing mismatches; the browser then swaps in the real time.
const subscribeToMinutes = (notify: () => void) => {
  const id = setInterval(notify, 1000);
  return () => clearInterval(id);
};
const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};
const SERVER_MINUTES = 9 * 60 + 41;

const hhmm = (total: number) => {
  const m = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

type Tone = "ok" | "amber" | "idle";
// Sample rows, placed relative to "now" so the board always agrees with its own clock: what already
// happened is in the past, what is scheduled is in the future. Each is something the product really
// does (send, detect a reply, run a workflow, capture a form, wait for a window, ramp a mailbox).
// The data is illustrative and labelled as such.
const ROWS: [
  offsetMinutes: number,
  service: string,
  to: string,
  status: string,
  tone: Tone,
][] = [
  [-142, "Sequence “Spring outreach”, step 1", "120 contacts", "Sent", "ok"],
  [
    -128,
    "Reply detected, sequence stopped",
    "Inbox · M. Okafor",
    "Replied",
    "amber",
  ],
  [-127, "Workflow “Interested → task”", "Task created for you", "Done", "ok"],
  [-39, "Form “Book a call”", "New contact, tagged", "Captured", "ok"],
  [
    12,
    "Sequence step 2, follow-up",
    "86 contacts, 9–17 window",
    "Waiting",
    "idle",
  ],
  [49, "Mailbox warm-up ramp", "Limit 18 a day", "Ramping", "amber"],
];

const TONE: Record<Tone, string> = {
  ok: "bg-board-green/15 text-board-green",
  amber: "bg-board-amber/15 text-board-amber",
  idle: "bg-white/10 text-white/70",
};

export function DepartureBoard() {
  const now = useSyncExternalStore(
    subscribeToMinutes,
    nowMinutes,
    () => SERVER_MINUTES,
  );
  return (
    <section
      aria-label="Sample departure board"
      className="overflow-hidden rounded-lg bg-ink text-white shadow-[0_24px_48px_-24px_oklch(0.19_0.012_255/0.5)]"
    >
      <div className="flex items-center gap-3 border-b-2 border-white/25 px-4 py-3 sm:px-6">
        <h2 className="text-lg font-extrabold tracking-[-0.01em] font-stretch-condensed sm:text-xl">
          Today’s departures
        </h2>
        <span className="rounded-sm border border-board-amber/50 px-1.5 py-0.5 text-[0.68rem] font-bold tracking-wider text-board-amber uppercase">
          Sample data
        </span>
        <span className="tabular ml-auto text-2xl font-bold tracking-tight text-board-amber sm:text-3xl">
          {hhmm(now)}
        </span>
      </div>
      <div
        className="hidden grid-cols-[4.5rem_1.3fr_1fr_6.5rem] gap-4 px-6 py-2 text-[0.68rem] font-bold tracking-[0.08em] text-white/55 uppercase sm:grid"
        aria-hidden
      >
        <span>Time</span>
        <span>Service</span>
        <span>Destination</span>
        <span>Status</span>
      </div>
      <ol>
        {ROWS.map(([offset, service, to, status, tone], i) => (
          <li
            key={service}
            style={{ ["--i" as string]: i }}
            className="board-flip grid grid-cols-[3.6rem_1fr_auto] items-center gap-x-3 gap-y-0.5 border-t border-white/12 px-4 py-3 sm:grid-cols-[4.5rem_1.3fr_1fr_6.5rem] sm:gap-x-4 sm:px-6"
          >
            <span
              className={`tabular row-span-2 text-base font-bold sm:row-span-1 sm:text-lg ${offset > 0 ? "text-white" : "text-board-amber"}`}
            >
              {hhmm(now + offset)}
            </span>
            <span className="min-w-0 text-sm font-semibold sm:text-base">
              {service}
            </span>
            <span
              className={`row-span-2 justify-self-end rounded-sm px-2 py-1 text-center text-[0.7rem] font-bold tracking-wider uppercase sm:order-last sm:row-span-1 sm:w-full ${TONE[tone]}`}
            >
              {status}
            </span>
            <span className="col-start-2 text-xs text-white/70 sm:col-start-auto sm:text-sm">
              {to}
              {offset > 0 && (
                <span className="tabular text-board-amber">
                  {" "}
                  · in {offset} min
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
