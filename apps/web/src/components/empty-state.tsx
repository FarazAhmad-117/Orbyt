import { cn } from "cn";

/** What a screen says when there is nothing in it yet: what this is for, and the first thing to do. */
export function EmptyState({
  title,
  children,
  actions,
  className,
}: {
  title: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid max-w-2xl gap-4 rounded-lg border border-dashed border-input bg-card p-6 sm:p-8",
        className,
      )}
    >
      <div className="grid gap-1.5">
        <p className="text-xl font-extrabold tracking-[-0.01em] font-stretch-condensed">
          {title}
        </p>
        {children && (
          <p className="text-sm text-pretty text-muted-foreground">
            {children}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
