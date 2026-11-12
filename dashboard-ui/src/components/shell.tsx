import { useState, type ReactNode } from "react";
import { Activity, Boxes, ChevronRight, LayoutDashboard, ListOrdered, Network, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "#/", label: "Overview", icon: LayoutDashboard, match: (p: string) => p === "/" },
  { href: "#/projects", label: "Projects", icon: Boxes, match: (p: string) => p.startsWith("/projects") },
  { href: "#/laps", label: "Laps", icon: ListOrdered, match: (p: string) => p.startsWith("/laps") },
  { href: "#/scheduling", label: "Scheduling", icon: Network, match: (p: string) => p.startsWith("/scheduling") },
  { href: "#/activity", label: "Activity", icon: Activity, match: (p: string) => p.startsWith("/activity") },
];

const COLLAPSE_KEY = "pdf-sidebar-collapsed";

/** app shell: a retractable sidebar on wide screens (icon rail when collapsed,
 *  remembered per browser), a top tab bar on narrow ones */
export function Shell({ path, children }: { path: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {}
      return !c;
    });
  const Toggle = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <div className="flex min-h-full">
      <aside className={cn("sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-card/40 py-4 transition-[width] duration-200 md:flex", collapsed ? "w-14 px-2" : "w-56 px-3")}>
        <div className={cn("mb-6 flex items-center", collapsed ? "flex-col gap-3" : "justify-between")}>
          <a href="#/" title="pi-dark-factory" className="flex items-center gap-2 rounded px-1 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground text-[13px] text-background">π</span>
            {!collapsed && "pi-dark-factory"}
          </a>
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Toggle className="size-4" aria-hidden />
          </button>
        </div>
        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {NAV.map(({ href, label, icon: Icon, match }) => (
            <a
              key={href}
              href={href}
              aria-current={match(path) ? "page" : undefined}
              aria-label={collapsed ? label : undefined}
              title={collapsed ? label : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                collapsed && "justify-center",
                match(path) && "bg-muted text-foreground"
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {!collapsed && label}
            </a>
          ))}
        </nav>
        {!collapsed && (
          <p className="mt-auto px-2 text-[11px] leading-relaxed text-muted-foreground">
            Read-only view of the factory ledger, receipts and session files.
          </p>
        )}
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
