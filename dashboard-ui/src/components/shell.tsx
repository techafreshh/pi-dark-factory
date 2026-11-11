import type { ReactNode } from "react";
import { Activity, Boxes, ChevronRight, LayoutDashboard, ListOrdered, Network } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "#/", label: "Overview", icon: LayoutDashboard, match: (p: string) => p === "/" },
  { href: "#/projects", label: "Projects", icon: Boxes, match: (p: string) => p.startsWith("/projects") },
  { href: "#/laps", label: "Laps", icon: ListOrdered, match: (p: string) => p.startsWith("/laps") },
  { href: "#/scheduling", label: "Scheduling", icon: Network, match: (p: string) => p.startsWith("/scheduling") },
  { href: "#/activity", label: "Activity", icon: Activity, match: (p: string) => p.startsWith("/activity") },
];

/** app shell: a fixed sidebar on wide screens, a top tab bar on narrow ones */
export function Shell({ path, children }: { path: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border bg-card/40 px-3 py-4 md:flex">
        <a href="#/" className="mb-6 flex items-center gap-2 rounded px-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span aria-hidden className="grid size-6 place-items-center rounded-md bg-foreground text-[13px] text-background">π</span>
          pi-dark-factory
        </a>
        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {NAV.map(({ href, label, icon: Icon, match }) => (
            <a
              key={href}
              href={href}
              aria-current={match(path) ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                match(path) && "bg-muted text-foreground"
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </a>
          ))}
        </nav>
        <p className="mt-auto px-2 text-[11px] leading-relaxed text-muted-foreground">
          Read-only view of the factory ledger, receipts and session files.
        </p>
      </aside>
      <div className="min-w-0 flex-1">
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2 md:hidden">
          {NAV.map(({ href, label, match }) => (
            <a key={href} href={href} aria-current={match(path) ? "page" : undefined}
              className={cn("rounded-md px-2.5 py-1 text-sm text-muted-foreground", match(path) && "bg-muted text-foreground")}>
              {label}
            </a>
          ))}
        </nav>
        <main className="mx-auto w-full max-w-7xl px-4 py-5 md:px-6">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ crumbs, title, description, actions }: {
  crumbs?: { label: string; href?: string }[]; title: ReactNode; description?: ReactNode; actions?: ReactNode;
}) {
  return (
    <header className="mb-5">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3" aria-hidden />}
              {c.href ? <a href={c.href} className="hover:text-foreground">{c.label}</a> : <span className="text-foreground">{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
