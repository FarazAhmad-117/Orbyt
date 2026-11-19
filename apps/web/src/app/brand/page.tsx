import type { Metadata } from "next";
import { cn } from "cn";
import { OrbitMark, Wordmark } from "@/components/brand";
import { H2, SiteFooter, SiteHeader } from "@/components/marketing";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = {
  title: "Brand · Orbyt",
  description:
    "The Orbyt mark, colours, type and voice: a timetable for outbound.",
};

// Values mirror :root in globals.css; hex is the sRGB approximation for people who cannot read oklch.
const COLOURS = [
  [
    "Ink",
    "bg-ink",
    "#101419",
    "oklch(0.19 0.012 255)",
    "Sign fields, text, the sidebar.",
  ],
  [
    "Paper",
    "bg-background",
    "#F4F6F8",
    "oklch(0.972 0.004 250)",
    "The page. A cool white, never pure.",
  ],
  [
    "Signal",
    "bg-signal",
    "#D40C1A",
    "oklch(0.55 0.22 27)",
    "One marker, one main action per screen, the selected item. Nothing else.",
  ],
  [
    "Board amber",
    "bg-board-amber",
    "#FDC010",
    "oklch(0.84 0.17 85)",
    "Live numbers, on ink only.",
  ],
  [
    "Board green",
    "bg-board-green",
    "#66DA85",
    "oklch(0.8 0.16 150)",
    "Done and OK, on ink only.",
  ],
] as const;

const VOICE = [
  ["Sequence step 2 sends in 12 min.", "Supercharge your outreach."],
  ["Reply detected. Sequence stopped.", "Magic happens when leads reply!"],
  [
    "Prebuilt images are not published yet.",
    "Enterprise-grade and battle-tested.",
  ],
] as const;

const NEVER = [
  "Gradients, glass, 3D shapes or stock faces.",
  "A second accent colour, or red as decoration.",
  "Invented customers, logos, quotes or numbers.",
  "Recolouring the dot, or filling the gap in the orbit.",
  "Text under 12px, or grey on grey.",
] as const;

function Part({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4 border-b border-border py-10 md:grid-cols-[6rem_1fr] md:gap-8">
      <span className="tabular text-4xl font-extrabold font-stretch-condensed">
        {n}
      </span>
      <div className="grid gap-6">
        <h2 className={cn(H2, "text-3xl sm:text-3xl")}>{title}</h2>
        {children}
      </div>
    </section>
  );
}

export default function BrandPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="mx-auto w-full max-w-6xl px-4 pt-12 pb-12 sm:px-6 sm:pt-20">
          <h1 className="max-w-4xl text-[clamp(2.5rem,8vw,5rem)] leading-[0.95] font-extrabold tracking-[-0.012em] text-balance font-stretch-condensed">
            A timetable for outbound.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-pretty text-muted-foreground sm:text-xl">
            Orbyt is the board that says what is sending, what replied and what
            leaves next. The brand is built the same way: plain signage, exact
            times, one red signal.
          </p>
        </section>

        <div className="mx-auto w-full max-w-6xl border-t-2 border-ink px-4 sm:px-6">
          <Part n="01" title="The mark">
            <p className="max-w-2xl text-pretty">
              An orbit, which is also a station clock face, opened for a moment
              at one o’clock. The red dot is the one thing leaving now. Draw it
              once and never redraw it: use the files below.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid place-items-center rounded-lg bg-card p-10 ring-1 ring-foreground/15">
                <OrbitMark title="Orbyt mark" className="size-32 text-ink" />
              </div>
              <div className="grid place-items-center rounded-lg bg-ink p-10">
                <OrbitMark
                  title="Orbyt mark on ink"
                  className="size-32 text-white"
                />
              </div>
              <div className="grid place-items-center rounded-lg bg-card p-8 ring-1 ring-foreground/15">
                <Wordmark className="scale-150 text-ink" />
              </div>
              <div className="grid place-items-center rounded-lg bg-ink p-8">
                <Wordmark className="scale-150 text-white" />
              </div>
            </div>
            <ul className="grid gap-2 text-sm text-pretty sm:grid-cols-2">
              <li>
                <b>Clear space:</b> keep one dot’s width clear on every side.
              </li>
              <li>
                <b>Smallest size:</b> 16px for the mark alone, 80px wide with
                the name.
              </li>
              <li>
                <b>On photos or colour:</b> don’t. Use ink or paper behind it.
              </li>
              <li className="flex flex-wrap gap-x-4">
                <b>Files:</b>
                {[
                  ["/brand/orbyt-mark-ink.svg", "Mark, ink"],
                  ["/brand/orbyt-mark-white.svg", "Mark, white"],
                  ["/brand/orbyt-app-icon.svg", "App icon"],
                ].map(([href, label]) => (
                  <a
                    key={href}
                    href={href}
                    download
                    className="underline decoration-border underline-offset-4 hover:decoration-signal"
                  >
                    {label}
                  </a>
                ))}
              </li>
            </ul>
          </Part>

          <Part n="02" title="Colour">
            <p className="max-w-2xl text-pretty">
              Ink and paper do almost all the work. Signal is rare on purpose:
              when something is red, it matters.
            </p>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {COLOURS.map(([name, cls, hex, oklch, role]) => (
                <li
                  key={name}
                  className="grid content-start overflow-hidden rounded-lg ring-1 ring-foreground/15"
                >
                  <div className={cn("h-24", cls)} />
                  <div className="grid gap-1 bg-card p-3">
                    <b>{name}</b>
                    <span className="tabular font-mono text-xs">{hex}</span>
                    <span className="font-mono text-[0.7rem] text-muted-foreground">
                      {oklch}
                    </span>
                    <span className="text-xs text-pretty text-muted-foreground">
                      {role}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Part>

          <Part n="03" title="Type">
            <p className="max-w-2xl text-pretty">
              One family, Archivo, used at two widths. Headings are condensed
              and heavy like station signs. Text is normal width. All numbers
              and times use tabular figures so columns line up.
            </p>
            <div className="grid gap-6 md:grid-cols-[1.4fr_1fr] md:items-end">
              <p className="text-5xl leading-[0.95] font-extrabold tracking-[-0.012em] text-balance font-stretch-condensed sm:text-6xl">
                Every send, reply and follow-up, on schedule.
              </p>
              <div className="grid gap-3">
                <p className="text-pretty">
                  Body text is regular width at 16px, with a measure of 60 to 75
                  characters.
                </p>
                <p className="tabular text-2xl font-bold">
                  09:41 · 12:30 · 18:05
                </p>
              </div>
            </div>
          </Part>

          <Part n="04" title="Signature devices">
            <p className="max-w-2xl text-pretty">
              Three small things make it recognisably ours. Use them where they
              say something true.
            </p>
            <div className="grid gap-6 md:grid-cols-3">
              <div className="grid content-start gap-3">
                <span className="tabular inline-grid size-12 place-items-center rounded-sm bg-ink text-xl font-extrabold text-white font-stretch-condensed">
                  01
                </span>
                <b>Platform number</b>
                <p className="text-sm text-pretty text-muted-foreground">
                  A square ink tile with a number, for steps and stops in order.
                </p>
              </div>
              <div className="grid content-start gap-3">
                <span className="tabular w-fit rounded-sm bg-ink px-2 py-1 text-xl font-bold text-board-amber">
                  09:41
                </span>
                <b>Time stamp</b>
                <p className="text-sm text-pretty text-muted-foreground">
                  A 24-hour time on ink, in amber, for anything that happened or
                  will happen.
                </p>
              </div>
              <div className="grid content-start gap-3">
                <span className="flex flex-wrap gap-2">
                  <Badge variant="ok">Sent</Badge>
                  <Badge variant="warn">Waiting</Badge>
                  <Badge variant="destructive">Failed</Badge>
                </span>
                <b>State tile</b>
                <p className="text-sm text-pretty text-muted-foreground">
                  A square tile whose colour always comes with a word.
                </p>
              </div>
            </div>
          </Part>

          <Part n="05" title="Voice">
            <p className="max-w-2xl text-pretty">
              Say what happened and when. Name the thing, not the benefit. Use a
              number only if we can back it.
            </p>
            <div>
              <div
                className="hidden grid-cols-2 gap-8 border-b-2 border-ink pb-2 text-[0.72rem] font-bold tracking-[0.08em] text-muted-foreground uppercase md:grid"
                aria-hidden
              >
                <span>We say</span>
                <span>We don’t</span>
              </div>
              <ul>
                {VOICE.map(([say, dont]) => (
                  <li
                    key={say}
                    className="grid gap-1 border-b border-border py-4 md:grid-cols-2 md:gap-8"
                  >
                    <p className="text-lg font-semibold">{say}</p>
                    <p className="text-lg text-muted-foreground line-through decoration-1">
                      {dont}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </Part>

          <Part n="06" title="Never">
            <ul className="grid gap-2">
              {NEVER.map((n) => (
                <li key={n} className="flex gap-3">
                  <span
                    aria-hidden
                    className="mt-2 size-2 shrink-0 rounded-[2px] bg-ink"
                  />
                  {n}
                </li>
              ))}
            </ul>
          </Part>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
