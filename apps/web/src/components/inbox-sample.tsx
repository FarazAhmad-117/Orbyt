import { Button } from "@/components/ui/button";

// A rendered slice of the real inbox, with sample content: the thread list, a reply, and an AI draft
// that waits for a human. Labelled as sample data; nothing here is a customer or a measurement.
const THREADS = [
  [
    "M. Okafor",
    "Re: Spring outreach",
    "Sounds interesting, can you do Thursday?",
    true,
  ],
  [
    "J. Lindqvist",
    "Re: Quick question",
    "Not right now, check back in Q3.",
    false,
  ],
  ["Auto-reply", "Out of office", "I am away until the 24th.", false],
] as const;

export function InboxSample() {
  return (
    <section
      aria-label="Sample inbox"
      className="overflow-hidden rounded-lg bg-card ring-1 ring-foreground/20"
    >
      <div className="flex items-center gap-3 border-b-2 border-ink px-4 py-3 sm:px-6">
        <h3 className="text-lg font-extrabold tracking-[-0.01em] font-stretch-condensed">
          Inbox
        </h3>
        <span className="rounded-sm border border-ink/40 px-1.5 py-0.5 text-[0.68rem] font-bold tracking-wider text-muted-foreground uppercase">
          Sample data
        </span>
      </div>
      <div className="grid md:grid-cols-[18rem_1fr]">
        <ul className="border-b border-border md:border-r md:border-b-0">
          {THREADS.map(([who, subject, snippet, unread], i) => (
            <li
              key={who}
              className={`grid gap-0.5 border-t border-border px-4 py-3 first:border-t-0 sm:px-5 ${
                i === 0 ? "bg-muted" : ""
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-bold">
                {unread && (
                  <span
                    className="size-2 rounded-[2px] bg-signal"
                    aria-label="Unread"
                  />
                )}
                {who}
              </span>
              <span className="text-sm">{subject}</span>
              <span className="truncate text-xs text-muted-foreground">
                {snippet}
              </span>
            </li>
          ))}
        </ul>
        <div className="grid gap-4 p-4 sm:p-6">
          <div className="grid gap-1">
            <span className="text-sm font-bold">M. Okafor</span>
            <p className="text-sm text-pretty">
              Sounds interesting, can you do Thursday? Happy to look at the
              pricing beforehand if you have it.
            </p>
          </div>
          <div className="grid gap-3 rounded-md border border-dashed border-input p-4">
            <span className="text-xs font-bold tracking-wider text-muted-foreground uppercase">
              Draft reply · written by AI from your knowledge base · not sent
            </span>
            <p className="text-sm text-pretty">
              Thursday works. I can do 10:00 or 14:30, whichever suits you. I
              have attached the pricing sheet so you can read it first.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" tabIndex={-1}>
                Send
              </Button>
              <Button size="sm" variant="outline" tabIndex={-1}>
                Edit
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
