import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** Small shadcn-style primitives the pages share (efferd dashboard look). */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("rounded-xl border border-border bg-card text-card-foreground", className)}>{children}</section>;
}

export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-3 border-b border-border px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-medium">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

const TONES = {
  neutral: "border-border bg-muted text-muted-foreground",
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-warn/30 bg-warn/10 text-warn",
  bad: "border-bad/30 bg-bad/10 text-bad",
  info: "border-info/30 bg-info/10 text-info",
  violet: "border-violet/30 bg-violet/10 text-violet",
  orange: "border-orange/30 bg-orange/10 text-orange",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none", TONES[tone], className)}>
      {children}
    </span>
  );
}

/** one colour per lap outcome, used by badges and the outcome chart */
export const STATUS: Record<string, { tone: Tone; color: string; label: string }> = {
  running: { tone: "info", color: "#58a6ff", label: "running" },
  merged: { tone: "ok", color: "#3fb950", label: "merged" },
  blocked: { tone: "bad", color: "#f85149", label: "blocked" },
  error: { tone: "orange", color: "#f0883e", label: "error" },
  billing_hold: { tone: "warn", color: "#d29922", label: "billing hold" },
  infra_deferred: { tone: "violet", color: "#a371f7", label: "infra deferred" },
  needs_context: { tone: "warn", color: "#e3b341", label: "needs context" },
  no_action: { tone: "neutral", color: "#6e7681", label: "no action" },
  interrupted: { tone: "neutral", color: "#8b949e", label: "interrupted" },
  unended: { tone: "neutral", color: "#484f58", label: "unended" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: "neutral" as Tone, label: status };
  return (
    <Badge tone={s.tone}>
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-info" />}
      {s.label}
    </Badge>
  );
}

export const EXIT_TONE = (exit: string | null): Tone =>
  exit === null ? "info" : exit === "ok" ? "ok" : exit === "interrupted" ? "neutral" : exit === "timeout" ? "orange" : "bad";

export function Button({ className, children, active, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        active && "border-ring/50 bg-ring/10 text-info",
        className
      )}
    >
      {children}
    </button>
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    />
  );
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn("h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      {children}
    </select>
  );
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-4 py-8 text-center text-sm text-muted-foreground", className)}>{children}</div>;
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 font-mono text-2xl tabular", tone)}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

/** table primitives: a scrollable frame, sortable headers, dense rows */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  );
}

export function Th({ children, className, sortKey, sort, order, onSort, align }: {
  children?: ReactNode; className?: string; sortKey?: string; sort?: string; order?: string; onSort?: (key: string) => void; align?: "right";
}) {
  const active = sortKey && sort === sortKey;
  const Icon = !active ? ArrowUpDown : order === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      aria-sort={active ? (order === "asc" ? "ascending" : "descending") : undefined}
      className={cn("sticky top-0 z-[1] h-9 whitespace-nowrap border-b border-border bg-card px-3 text-left text-xs font-medium text-muted-foreground", align === "right" && "text-right", className)}
    >
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={cn("-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", active && "text-foreground")}
        >
          {children}
          <Icon className={cn("size-3", !active && "opacity-40")} />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({ children, className, align, title }: { children?: ReactNode; className?: string; align?: "right"; title?: string }) {
  return <td title={title} className={cn("border-b border-border/60 px-3 py-2 align-middle", align === "right" && "text-right tabular", className)}>{children}</td>;
}

export function Tr({ children, onClick, href, className }: { children: ReactNode; onClick?: () => void; href?: string; className?: string }) {
  const go = href ? () => (window.location.hash = href.replace(/^#/, "")) : onClick;
  return (
    <tr
      onClick={go}
      onKeyDown={(e) => go && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go())}
      tabIndex={go ? 0 : undefined}
      className={cn("transition-colors", go && "cursor-pointer outline-none hover:bg-muted/50 focus-visible:bg-muted/60", className)}
    >
      {children}
    </tr>
  );
}

export function Link({ href, children, className, external }: { href: string; children: ReactNode; className?: string; external?: boolean }) {
  return (
    <a
      href={href}
      onClick={(e) => e.stopPropagation()}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={cn("rounded text-info outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      {children}
    </a>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{children}</div>;
}
