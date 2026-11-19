"use client";

import { useSyncExternalStore } from "react";
import { cn } from "cn";

// The viewer's own clock, in seconds since midnight. Server and first hydration pass use a fixed
// 09:41:00 so nothing mismatches; the browser then swaps in the real time and ticks every second.
const subscribe = (notify: () => void) => {
  const id = setInterval(notify, 1000);
  return () => clearInterval(id);
};
const secondsOfDay = () => {
  const d = new Date();
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
};
const SERVER_SECONDS = 9 * 3600 + 41 * 60;
const pad = (n: number) => String(n).padStart(2, "0");
const TICKS = Array.from({ length: 60 }, (_, i) => i);

/**
 * The brand's signature: a station clock showing the viewer's real time, with the red dot of the mark
 * stepping round the face once a minute like a second hand. Decorative apart from the time it states.
 */
export function StationClock({ className }: { className?: string }) {
  const s = useSyncExternalStore(subscribe, secondsOfDay, () => SERVER_SECONDS);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor(s / 60) % 60;
  const deg = (s % 60) * 6;
  return (
    <div
      role="img"
      aria-label={`Your local time, ${pad(hh)}:${pad(mm)}`}
      className={cn("relative aspect-square", className)}
    >
      <svg viewBox="-10 -10 220 220" className="size-full" aria-hidden>
        <circle
          cx="100"
          cy="100"
          r="97"
          fill="var(--card)"
          stroke="var(--ink)"
          strokeWidth="3"
        />
        {TICKS.map((i) => (
          <line
            key={i}
            x1="100"
            y1="10"
            x2="100"
            y2={i % 5 === 0 ? 25 : 17}
            transform={`rotate(${i * 6} 100 100)`}
            stroke="var(--ink)"
            strokeWidth={i % 5 === 0 ? 2.6 : 1}
          />
        ))}
        {/* Steps once a second like a station clock; no easing back when it wraps past 12. */}
        <g
          style={{
            transform: `rotate(${deg}deg)`,
            transformOrigin: "100px 100px",
            transition:
              deg === 0
                ? "none"
                : "transform 180ms cubic-bezier(0.3, 1.5, 0.5, 1)",
          }}
          className="motion-reduce:!transition-none"
        >
          <circle
            cx="100"
            cy="3"
            r="8"
            fill="var(--signal)"
            stroke="var(--card)"
            strokeWidth="4"
            paintOrder="stroke"
          />
        </g>
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center">
        <span className="tabular text-[clamp(2.5rem,5vw,4.25rem)] leading-none font-extrabold tracking-[-0.02em] font-stretch-condensed">
          {pad(hh)}:{pad(mm)}
        </span>
        <span className="mt-2 text-xs font-bold tracking-[0.08em] text-muted-foreground uppercase">
          Your time
        </span>
      </div>
    </div>
  );
}
