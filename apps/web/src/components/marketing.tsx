import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { buttonVariants } from "@/components/ui/button";

// Shared chrome for the public pages (landing, pricing, self-host).
const NAV = [
  ["Services", "/#services"],
  ["Pricing", "/pricing"],
  ["Self-host", "/self-host"],
] as const;

/** Section and page headings on the public pages: one size, condensed, tight. */
export const H2 =
  "text-4xl leading-none font-extrabold tracking-[-0.02em] text-balance font-stretch-condensed sm:text-5xl";

const navLink =
  "rounded-md px-3 py-2 font-medium text-white/75 transition-colors hover:text-white";

export function SiteHeader() {
  return (
    <header className="bg-ink text-white">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:gap-5 sm:px-6">
        <Link href="/" aria-label="Orbyt home">
          <Wordmark />
        </Link>
        <nav
          aria-label="Site"
          className="ml-auto flex items-center gap-1 text-sm"
        >
          {NAV.map(([label, href]) => (
            <Link
              key={href}
              href={href}
              className={`${navLink} hidden md:inline`}
            >
              {label}
            </Link>
          ))}
          <Link href="/sign-in" className={navLink}>
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className={buttonVariants({ variant: "signal", size: "sm" })}
          >
            Create account
          </Link>
        </nav>
      </div>
      {/* Phones have no room for the links beside the buttons, so they get their own row. */}
      <nav
        aria-label="Site sections"
        className="flex gap-1 border-t border-white/15 px-2 text-sm md:hidden"
      >
        {NAV.map(([label, href]) => (
          <Link key={href} href={href} className={navLink}>
            {label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="bg-ink text-white">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-6 text-sm text-white/70 sm:px-6">
        <Wordmark className="text-white" />
        <span className="sm:ml-auto">Open source under AGPL-3.0</span>
        {NAV.slice(1).map(([label, href]) => (
          <Link key={href} href={href} className="hover:text-white">
            {label}
          </Link>
        ))}
        <Link href="/brand" className="hover:text-white">
          Brand
        </Link>
        <Link href="/sign-in" className="hover:text-white">
          Sign in
        </Link>
      </div>
    </footer>
  );
}
