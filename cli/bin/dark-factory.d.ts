// Types for dark-factory.js (which stays plain JS with zero dependencies).
// The factory's test suite imports these exports; editors pick them up too.

export type Painter = { on: boolean } & Record<
  "bold" | "dim" | "cyan" | "green" | "red" | "yellow" | "gray" | "magenta" | "header",
  (s: string) => string
>;

export interface ParsedArgs {
  /** positional arguments, verb first */
  _: string[];
  /** set when the argv is unusable (unknown flag, flag without its value) */
  error?: string;
  [flag: string]: string | boolean | string[] | undefined;
}

export type ApiFn = (
  method: string,
  path: string,
  body?: unknown,
  opts?: { timeout?: number; allowStatus?: number[]; needKey?: boolean }
) => Promise<{ status: number; body: any }>;

export type FetchLike = (url: any, init?: any) => Promise<Response>;

export interface RunContext {
  out?: (s: unknown) => void;
  err?: (s: unknown) => void;
  /** home directory holding .dark-factory/config.json */
  home?: string;
  api?: ApiFn;
  fetchImpl?: FetchLike;
  /** streaming fetch for session --follow; defaults to fetchImpl */
  rawFetch?: FetchLike;
  colors?: Painter;
  /** force color on or off; default: only on a TTY without NO_COLOR */
  color?: boolean;
}

export function paint(on: boolean): Painter;
export function parseArgs(argv: string[]): ParsedArgs;
export function configPaths(home?: string): { file: string };
export function makeApi(cfg: { url: string; key?: string }, fetchImpl?: FetchLike): ApiFn;
export function formatStatus(body: any, P?: Painter): string;
export function formatDoctor(health: any, status: any, P?: Painter): string;
export function formatModels(body: any, P?: Painter): string;
/** run one CLI invocation; resolves the exit code (0 ok, 1 error/failed verdict, 2 usage) */
export function run(argv: string[], ctx?: RunContext): Promise<number>;
