import { cn } from "cn";

/**
 * The Orbyt mark: an orbit (also a station clock's face) with the red departure dot riding in its gap.
 * Drawn once, scales from favicon to hero, takes its colour from currentColor. The same geometry is
 * in public/brand/*.svg and src/app/icon.svg; change all together.
 */
export function OrbitMark({
  className,
  title,
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-6 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* An orbit (r=11) opened for 60° at one o'clock, with the departure dot riding in the gap. */}
      <path
        d="M26.63 13.15A11 11 0 1 1 18.85 5.37"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <circle cx="23.78" cy="8.22" r="3.2" fill="var(--signal)" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <OrbitMark />
      <span className="text-[1.15rem] leading-none font-extrabold tracking-[-0.02em] font-stretch-semi-condensed">
        Orbyt
      </span>
    </span>
  );
}
