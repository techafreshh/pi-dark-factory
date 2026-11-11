export const num = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n));

export const usd = (n: number | null | undefined) =>
  n == null ? "—" : n === 0 ? "$0" : n < 0.01 ? "<$0.01" : "$" + n.toFixed(2);

export const pct = (n: number | null | undefined) => (n == null ? "—" : Math.round(n * 100) + "%");

export const dur = (s: number | null | undefined) => {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
};

export const ago = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1e3;
  const abs = Math.abs(s);
  const v = abs < 90 ? `${Math.round(abs)}s` : abs < 5400 ? `${Math.round(abs / 60)}m` : abs < 172800 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return s < 0 ? `in ${v}` : `${v} ago`;
};

export const since = (iso: string | null | undefined) => (iso ? dur((Date.now() - new Date(iso).getTime()) / 1e3) : "—");

export const when = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export const bytes = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : n >= 1e3 ? Math.round(n / 1e3) + " KB" : n + " B");

export const GITHUB = "https://github.com";
