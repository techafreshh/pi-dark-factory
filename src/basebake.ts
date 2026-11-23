/**
 * Fleet base snapshots — the operator-side "one dev base per platform"
 * (docs/execution-modes.md, "Shared dev bases").
 *
 * A repo's golden snapshot is per-repo and enriches a base with the repo's
 * own deps. This module bakes the BASE itself: the toolchain every lap needs
 * before any repo-specific install (node, python, go, git, gh, bun, pi) plus
 * the acceptance toolchain the verify gate and the drain walk need (Chromium,
 * the e2e runner, agent-browser) and the security scanner (penthera). One
 * versioned snapshot per platform, stored under `shared-base.platforms.<p>`
 * in state/base-snapshot.json; repos point at the alias `shared-base` and
 * every platform resolves its own physical name.
 *
 * Seeds come from what the provider already ships, not from a bare image:
 *   instabox  template agent-browser  (Debian 13: node/python/go/rust/java/
 *             bun/docker/gh/chrome/agents — see https://instabox.sh/docs/limits)
 *   boxd      the default Ubuntu 24.04 image (node/python/go/git/chrome/agents;
 *             https://boxd.sh/faq)
 *   daytona   snapshot daytona-medium (Python + Node, 2 vCPU/4 GiB/8 GiB)
 *   e2b       template base / fromBaseImage() (Debian: python/node/git/gh)
 *
 * InstaVM is deliberately not supported: its snapshot build takes an OCI
 * image and caps the build disk at 3 GiB, so a dev base does not fit there.
 *
 * The bake fails loudly (exit 31/32 markers from the in-box script) when a
 * platform cannot carry the browser (egress allowlist) or a tool install
 * fails — a base that is silently missing node is exactly the failure this
 * command exists to end.
 */
import { InstaBox, InstaBoxError, sanitizeMachinePart } from "./instabox";
import { boxdClientFromEnv, boxdBash, raceDeadline } from "./machine-boxd";
import { daytonaClientFromEnv, daytonaBash } from "./machine-daytona";
import { Template as E2bTemplate } from "e2b";
import { browserBakeScript } from "./browserbake";
import { pentheraSpec } from "./security";
import { escapeSh, machineBash } from "./machine";
import { readBases, setBasePlatform, SHARED_BASE_ALIAS } from "./sharedbase";
import { receipt } from "./receipts";
import { MACHINE_MODES } from "./types";

export const BASE_PLATFORMS = ["instabox", "boxd", "daytona", "e2b"] as const;
export type BasePlatform = (typeof BASE_PLATFORMS)[number];

export function isBasePlatform(p: string | undefined | null): p is BasePlatform {
  return (BASE_PLATFORMS as readonly string[]).includes(p ?? "");
}

export type BaseSeedKind = "template" | "snapshot" | "image";

export interface BaseSeed {
  kind: BaseSeedKind;
  /** empty means "the platform's default image" (boxd) or `fromBaseImage()` (e2b) */
  value: string;
  label: string;
}

/** The richest stock starting point each platform ships (see the module doc). */
export const BASE_SEEDS: Record<BasePlatform, BaseSeed> = {
  instabox: {
    kind: "template",
    value: "agent-browser",
    label: "instabox template agent-browser (Debian 13: node/python/go/rust/java/bun/docker/gh/chrome)",
  },
  boxd: {
    kind: "image",
    value: "",
    label: "boxd default image (Ubuntu 24.04: node/python/go/git/chrome)",
  },
  daytona: {
    kind: "snapshot",
    value: "daytona-medium",
    label: "daytona snapshot daytona-medium (Python + Node, 2 vCPU/4 GiB/8 GiB)",
  },
  e2b: {
    kind: "template",
    value: "base",
    label: "e2b base image (Debian: python/node/git/gh/build-essential)",
  },
};

/** Pinned so a base is reproducible; override with PDF_GO_VERSION. */
export const BASE_GO_VERSION = process.env.PDF_GO_VERSION ?? "1.27.1";

/** bash + node's npm global bin dirs cover every seed's PATH layout. */
const DEV_TOOLS_INSTALL = [
  `set -u`,
  // root on e2b/daytona lanes, non-root with sudo on instabox/boxd; a
  // no-sudo box fails the checks below instead of silently skipping installs
  `SUDO=""`,
  `if [ "$(id -u)" -ne 0 ] && sudo -n true 2>/dev/null; then SUDO="sudo -n"; fi`,
  `export DEBIAN_FRONTEND=noninteractive`,
  `apt_install() { if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -qq >/dev/null 2>&1 || true; $SUDO apt-get install -y "$@" >/dev/null 2>&1 || $SUDO apt-get install -y "$@"; fi; }`,
  `for t in git curl ca-certificates jq; do command -v "$t" >/dev/null 2>&1 || apt_install "$t"; done`,
  `command -v gcc >/dev/null 2>&1 || apt_install build-essential`,
  `command -v python3 >/dev/null 2>&1 || apt_install python3 python3-pip python3-venv`,
  // a seed Node older than 22 cannot run pi; install NodeSource 22 in place
  `NODE_MAJOR=0`,
  `command -v node >/dev/null 2>&1 && NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)`,
  `if [ "\${NODE_MAJOR:-0}" -lt 22 ]; then`,
  `  echo "BASE_TOOLS: installing Node 22 (found \${NODE_MAJOR:-none})"`,
  `  (curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -) || true`,
  `  apt_install nodejs npm`,
  `fi`,
  `command -v npm >/dev/null 2>&1 || apt_install npm`,
  // gh: present on the instabox and e2b seeds; install from GitHub's own apt
  // repo on boxd/daytona (distro repos lag or omit it)
  `if ! command -v gh >/dev/null 2>&1; then`,
  `  if command -v apt-get >/dev/null 2>&1; then`,
  `    $SUDO mkdir -p -m 755 /etc/apt/keyrings`,
  `    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null 2>&1 || true`,
  `    $SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg 2>/dev/null || true`,
  `    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null 2>&1 || true`,
  `    apt_install gh`,
  `  fi`,
  `fi`,
  // go: present on instabox/boxd; the official tarball is the reproducible
  // path on daytona/e2b (distro packages lag by a year)
  `if ! command -v go >/dev/null 2>&1; then`,
  `  GARCH=$(dpkg --print-architecture 2>/dev/null || echo amd64)`,
  `  case "$GARCH" in arm64) GARCH=arm64 ;; *) GARCH=amd64 ;; esac`,
  `  echo "BASE_TOOLS: installing Go ${BASE_GO_VERSION} ($GARCH)"`,
  `  curl -fsSL "https://go.dev/dl/go${BASE_GO_VERSION}.linux-\${GARCH}.tar.gz" -o /tmp/pdf-go.tgz`,
  `  $SUDO rm -rf /usr/local/go && $SUDO tar -C /usr/local -xzf /tmp/pdf-go.tgz`,
  `  $SUDO ln -sf /usr/local/go/bin/go /usr/local/bin/go`,
  `  $SUDO ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt`,
  `  rm -f /tmp/pdf-go.tgz`,
  `fi`,
  // bun: the factory's e2e toolchain and several repos use it; npm's package
  // is the simplest system-wide install, the official script the fallback
  `if ! command -v bun >/dev/null 2>&1; then`,
  `  npm i -g bun >/dev/null 2>&1 || $SUDO npm i -g bun >/dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash) || true`,
  `  [ -x "$HOME/.bun/bin/bun" ] && $SUDO ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun || true`,
  `fi`,
  // pi itself: every machine-mode stage execs $PI_BIN, and the stage driver
  // does not ship the binary — the snapshot is the only place it can live
  `if ! command -v pi >/dev/null 2>&1; then`,
  `  npm i -g @earendil-works/pi-coding-agent >/dev/null 2>&1 || $SUDO npm i -g @earendil-works/pi-coding-agent || true`,
  `fi`,
  // penthera: the per-merge scan runs host-side, but the base carries the
  // pinned scanner so in-box verification and a future box-side scan work
  `if ! command -v penthera >/dev/null 2>&1; then`,
  `  npm i -g ${escapeSh(pentheraSpec())} >/dev/null 2>&1 || $SUDO npm i -g ${escapeSh(pentheraSpec())} || true`,
  `fi`,
  `echo DEV_TOOLS_INSTALLED`,
].join("\n");

const DEV_TOOLS_SMOKE = [
  `set -u`,
  `fail=0`,
  `NODE_MAJ=0; command -v node >/dev/null 2>&1 && NODE_MAJ=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)`,
  `if [ "\${NODE_MAJ:-0}" -ge 22 ]; then echo "NODE_OK $(node --version)"; else echo "NODE_TOO_OLD \${NODE_MAJ:-none} (need >=22)"; fail=1; fi`,
  `python3 --version >/dev/null 2>&1 && echo "PYTHON_OK $(python3 --version 2>&1)" || { echo PYTHON_MISSING; fail=1; }`,
  `git --version >/dev/null 2>&1 && echo "GIT_OK $(git --version)" || { echo GIT_MISSING; fail=1; }`,
  `go version >/dev/null 2>&1 && echo "GO_OK $(go version)" || { echo GO_MISSING; fail=1; }`,
  `gh --version >/dev/null 2>&1 && echo "GH_OK $(gh --version | head -1)" || { echo GH_MISSING; fail=1; }`,
  `bun --version >/dev/null 2>&1 && echo "BUN_OK $(bun --version)" || { echo BUN_MISSING; fail=1; }`,
  `pi --version >/dev/null 2>&1 && echo "PI_OK $(pi --version 2>&1 | head -1)" || { echo PI_MISSING; fail=1; }`,
  `penthera --version >/dev/null 2>&1 && echo "PENTHERA_OK $(penthera --version 2>&1 | head -1)" || { echo PENTHERA_MISSING; fail=1; }`,
  `[ "$fail" -eq 0 ] || { echo "DEV_TOOLS_FAILED: a required tool did not install (see the *_MISSING markers above)"; exit 32; }`,
  `echo DEV_TOOLS_OK`,
].join("\n");

/**
 * The one script every lane runs. Installs the dev tools, then the browser
 * toolchain (Chromium + e2e + agent-browser, exit 31 when the box cannot
 * carry a browser), then checks every tool by name. Kept in one place so
 * instabox, boxd, daytona and e2b bases install THE SAME THING.
 */
export function baseBakeScript(): string {
  return DEV_TOOLS_INSTALL + "\n\n" + browserBakeScript() + "\n\n" + DEV_TOOLS_SMOKE;
}

/** Turn the in-box smoke output into the `contents` line the operator reads. */
export function summarizeBase(seed: BaseSeed, raw: string): string {
  const grab = (name: string) => {
    // machine exec output starts each marker line; E2B build logs prefix
    // theirs, so do not anchor to the line start
    const m = raw.match(new RegExp(`${name}_OK ([^\\n]+)`));
    return m?.[1]?.trim();
  };
  return [
    seed.label,
    grab("NODE") && `node ${grab("NODE")}`,
    grab("PYTHON") && grab("PYTHON"),
    grab("GO"),
    grab("GIT"),
    grab("GH"),
    grab("BUN") && `bun ${grab("BUN")}`,
    grab("PI") && grab("PI"),
    grab("PENTHERA") && grab("PENTHERA"),
    "e2e toolchain + Chromium at /opt/pdf-e2e",
  ]
    .filter(Boolean)
    .join("; ");
}

export interface BaseBakeResult {
  platform: BasePlatform;
  alias: string;
  snapshot: string;
  snapshotId?: string;
  seed: string;
  contents: string;
  sizeBytes?: number;
}

export interface BaseBakeOpts {
  /** versioned physical snapshot name, e.g. factory-dev-daytona-r1 */
  name: string;
  /** alias the repos point at; default shared-base */
  alias?: string;
  /** override the seed value from BASE_SEEDS */
  seed?: string;
  seedKind?: BaseSeedKind;
  onLog?: (line: string) => void;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function assertBaseName(name: string) {
  if (!NAME_RE.test(name))
    throw new Error(`base snapshot name "${name}" is invalid — use lowercase letters, digits and hyphens (versioned, e.g. factory-dev-daytona-r1)`);
}

export function assertBaseAlias(alias: string) {
  if (!ALIAS_RE.test(alias))
    throw new Error(`base alias "${alias}" is invalid — use lowercase letters, digits and hyphens (e.g. shared-base)`);
}

/** Refuse to overwrite an alias token as a physical name: the alias is the
 *  rollout handle and a snapshot named like one would shadow it everywhere. */
export function assertNotAlias(stateDir: string, name: string, alias = SHARED_BASE_ALIAS) {
  if (name === SHARED_BASE_ALIAS || name === alias)
    throw new Error(`"${name}" is a base alias, not a snapshot name — pick a versioned literal name (e.g. factory-dev-daytona-r1)`);
  if (readBases(stateDir)[name])
    throw new Error(`"${name}" is an existing base alias, not a snapshot name — pick a versioned literal name and flip the alias after the bake`);
}

export function seedFor(platform: BasePlatform, opts: BaseBakeOpts): BaseSeed {
  const base = BASE_SEEDS[platform];
  const value = opts.seed ?? base.value;
  const kind = opts.seedKind ?? base.kind;
  const allowed: Record<BasePlatform, BaseSeedKind[]> = {
    instabox: ["template", "snapshot"],
    boxd: ["image", "snapshot"],
    daytona: ["snapshot", "image"],
    e2b: ["template", "image"],
  };
  if (!allowed[platform].includes(kind))
    throw new Error(`base bake ${platform} cannot seed from a ${kind} — supported: ${allowed[platform].join(" | ")}`);
  if (kind === "snapshot" && !value) throw new Error(`--seed-kind snapshot needs a snapshot name`);
  return { kind, value, label: value ? `${kind} ${value}` : base.label };
}

/**
 * Bake one platform's shared dev base and record it under the alias. The
 * platform-specific lifecycle (create, wait, exec, capture, delete) follows
 * the same rules as the per-repo bakes in ops.ts: a fresh machine, a capture
 * under a NEW versioned name (never an alias, never a running lap's base),
 * and no machine left behind.
 */
export async function opsBaseBake(stateDir: string, platform: string, opts: BaseBakeOpts): Promise<BaseBakeResult> {
  if (!isBasePlatform(platform))
    throw new Error(
      `base bake supports ${BASE_PLATFORMS.join(" | ")} (got "${platform}"). ` +
        `InstaVM is excluded: its snapshot build disk is capped at 3 GiB and cannot carry a dev base.`
    );
  const p = platform;
  assertBaseName(opts.name);
  const alias = opts.alias ?? SHARED_BASE_ALIAS;
  assertBaseAlias(alias);
  assertNotAlias(stateDir, opts.name, alias);
  const seed = seedFor(p, opts);
  const script = baseBakeScript();
  const log = (line: string) => {
    opts.onLog?.(line);
    receipt(stateDir, `base bake ${p}: ${line}`, undefined);
  };
  log(`baking ${opts.name} from ${seed.label} (alias ${alias})`);

  let result: BaseBakeResult;
  try {
    if (p === "instabox") result = await bakeInstaboxBase(stateDir, opts.name, seed, alias, script, log);
    else if (p === "boxd") result = await bakeBoxdBase(stateDir, opts.name, seed, alias, script, log);
    else if (p === "daytona") result = await bakeDaytonaBase(stateDir, opts.name, seed, alias, script, log);
    else result = await bakeE2bBase(stateDir, opts.name, seed, alias, script, log);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    receipt(stateDir, `base bake ${p}: FAILED — ${msg.slice(0, 400)}`, undefined);
    throw e;
  }
  receipt(stateDir, `base bake ${p}: ${result.snapshot} ready — alias ${alias} now resolves ${p} → ${result.snapshot}`, undefined);
  return result;
}

async function bakeInstaboxBase(
  stateDir: string,
  name: string,
  seed: BaseSeed,
  alias: string,
  script: string,
  log: (m: string) => void
): Promise<BaseBakeResult> {
  const ib = InstaBox.fromEnv({
    api_base: process.env.PDF_INSTABOX_API_BASE ?? "https://api.instabox.sh",
    api_key_env: "INSTABOX_API_KEY",
  });
  const snaps = await ib.listSnapshots();
  if (snaps.some((s) => s.name === name))
    throw new Error(`instabox snapshot "${name}" already exists — bake a new versioned name (e.g. ...-r2) and flip the alias`);
  const baseSnap = seed.kind === "snapshot" ? snaps.find((s) => s.name === seed.value) : undefined;
  if (seed.kind === "snapshot" && !baseSnap) throw new Error(`instabox seed snapshot "${seed.value}" not found`);
  const machineName = `pdf-base-${sanitizeMachinePart(name)}`;
  const existing = await ib.machineByName(machineName);
  if (existing) await ib.deleteMachine(machineName);
  const op = await ib.createMachine({
    name: machineName,
    templateId: seed.kind === "template" ? seed.value : undefined,
    snapshotId: baseSnap?.id,
    metadata: { factory: "1", base: name },
  });
  await ib.waitOperation(op.id);
  const machine = await ib.machineByName(machineName);
  if (!machine) throw new Error(`base bake machine ${machineName} vanished after creation`);
  try {
    const token = await ib.createSshToken(machine.id, { name: "base-bake", ttlSeconds: 8 * 3600 });
    const res = await machineBash({ host: token.host, port: token.port, user: token.token }, script, { timeoutMs: 150 * 60_000 });
    if (res.code !== 0)
      throw new Error(`base toolchain failed in the instabox machine (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 600)}`);
    log("toolchain smokes passed — saving snapshot");
    let snap;
    try {
      snap = await ib.saveSnapshot(machine.id, name, { description: `pi-dark-factory shared dev base (${seed.label})` });
    } catch (e) {
      if (e instanceof InstaBoxError && e.status === 409)
        throw new Error(`instabox snapshot "${name}" appeared while the bake ran (another bake?) — pick a new versioned name`);
      throw e;
    }
    const contents = summarizeBase(seed, res.stdout);
    setBasePlatform(stateDir, alias, "instabox", {
      snapshot: name,
      bakedAt: new Date().toISOString(),
      template: seed.label,
      contents,
    });
    return { platform: "instabox", alias, snapshot: name, snapshotId: snap.id, seed: seed.label, contents, sizeBytes: snap.rootSizeBytes };
  } finally {
    await ib.deleteMachine(machineName).catch(() => {});
  }
}

async function bakeBoxdBase(
  stateDir: string,
  name: string,
  seed: BaseSeed,
  alias: string,
  script: string,
  log: (m: string) => void
): Promise<BaseBakeResult> {
  const client = boxdClientFromEnv();
  const existing = await (client.snapshots as any).get(name).catch(() => null);
  if (existing?.name === name)
    throw new Error(`boxd snapshot "${name}" already exists — boxd re-saves version latest-only; pick a new versioned name and flip the alias`);
  const machineName = `pdf-base-${sanitizeMachinePart(name)}`;
  const stale = await (client.machines as any)
    .list({ region: "all" })
    .then((l: any) => ((l.machines ?? l) as any[]).find((m: any) => m.name === machineName) ?? null)
    .catch(() => null);
  if (stale) await (client.machines as any).delete(stale.id).catch(() => {});
  const params: any = { name: machineName, labels: { factory: "1", base: name } };
  if (seed.kind === "snapshot") params.fromSnapshot = seed.value;
  else if (seed.kind === "image" && seed.value) params.image = seed.value;
  // kind image + empty value = the boxd default Ubuntu image
  const machine = await (client.machines as any).create(params);
  try {
    await raceDeadline((client.machines as any).waitUntilReady(machine.id, { timeoutMs: 120_000 }), 150_000);
    const res = await boxdBash(client, machine.id, script, { timeoutMs: 150 * 60_000 });
    if (res.code !== 0)
      throw new Error(`base toolchain failed in the boxd machine (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 600)}`);
    log("toolchain smokes passed — capturing snapshot");
    await raceDeadline((client.snapshots as any).create(machine.id, name), 120_000);
    let snap: any = null;
    const deadline = Date.now() + Number(process.env.PDF_BOXD_SNAPSHOT_TIMEOUT_MS ?? 30 * 60_000);
    for (;;) {
      snap = await raceDeadline((client.snapshots as any).get(name), 30_000);
      if (snap?.status === "failed") throw new Error(`boxd snapshot ${name} failed platform-side`);
      if (snap?.status === "ready" && snap?.version != null) break;
      if (Date.now() > deadline) throw new Error(`boxd snapshot ${name} still pending after the deadline`);
      await new Promise((r) => setTimeout(r, Number(process.env.PDF_BOXD_SNAPSHOT_POLL_MS ?? 10_000)));
    }
    const contents = summarizeBase(seed, res.stdout);
    setBasePlatform(stateDir, alias, "boxd", {
      snapshot: name,
      bakedAt: new Date().toISOString(),
      template: seed.label,
      contents,
    });
    return { platform: "boxd", alias, snapshot: name, snapshotId: snap.id, seed: seed.label, contents, sizeBytes: snap.sizeBytes };
  } finally {
    await (client.machines as any).delete(machine.id).catch(() => {});
  }
}

async function bakeDaytonaBase(
  stateDir: string,
  name: string,
  seed: BaseSeed,
  alias: string,
  script: string,
  log: (m: string) => void
): Promise<BaseBakeResult> {
  const client = daytonaClientFromEnv();
  const page = await client.snapshot.list({ limit: 100 }).catch(() => ({ items: [] as any[] }));
  if ((page.items ?? []).some((s: any) => s.name === name))
    throw new Error(`daytona snapshot "${name}" already exists — bake a new versioned name and flip the alias`);
  const machineName = `pdf-base-${sanitizeMachinePart(name)}`;
  const stale = await client.get(machineName).catch(() => null);
  if (stale) await client.delete(stale).catch(() => {});
  const spec: any = {
    name: machineName,
    labels: { factory: "1", base: name },
    autoStopInterval: 0,
    ttlMinutes: Math.max(60, Math.floor(Number(process.env.PDF_DAYTONA_TTL_MINUTES ?? 180))),
  };
  if (seed.kind === "snapshot") spec.snapshot = seed.value;
  else if (seed.kind === "image" && seed.value) spec.image = seed.value;
  // an explicit image seed with no value means the provider's default dev
  // snapshot, not a registry image named "daytona-medium"
  else spec.snapshot = "daytona-medium";
  const sandbox = await client.create(spec, { timeout: 900 });
  try {
    const res = await daytonaBash(sandbox, script, { timeoutMs: 150 * 60_000 });
    if (res.code !== 0)
      throw new Error(`base toolchain failed in the daytona sandbox (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 600)}`);
    log("toolchain smokes passed — stopping the sandbox and capturing the snapshot");
    // container snapshots require a stopped sandbox
    await client.stop(sandbox);
    await sandbox.createSnapshot(name, 1800);
    const snap: any = await client.snapshot.get(name).catch(() => null);
    const contents = summarizeBase(seed, res.stdout);
    setBasePlatform(stateDir, alias, "daytona", {
      snapshot: name,
      bakedAt: new Date().toISOString(),
      template: seed.label,
      contents,
    });
    return {
      platform: "daytona",
      alias,
      snapshot: name,
      snapshotId: snap?.id,
      seed: seed.label,
      contents,
      sizeBytes: typeof snap?.size === "number" ? snap.size : undefined,
    };
  } finally {
    await client.delete(sandbox).catch(() => {});
  }
}

async function bakeE2bBase(
  stateDir: string,
  name: string,
  seed: BaseSeed,
  alias: string,
  script: string,
  log: (m: string) => void
): Promise<BaseBakeResult> {
  const Template = E2bTemplate;
  // `base` is E2B's default template; fromBaseImage() is the documented way
  // to extend it (fromTemplate is for a project/org template name)
  let t =
    seed.kind === "image"
      ? seed.value
        ? Template().fromImage(seed.value)
        : Template().fromBaseImage()
      : seed.value === "base"
        ? Template().fromBaseImage()
        : Template().fromTemplate(seed.value);
  // system installs (apt, /usr/local) run as root; the default user keeps its
  // own HOME untouched
  t = t.runCmd(script, { user: "root" });
  // the build log carries the in-box smoke markers; keep the tail for the
  // contents line and for the error when the build dies
  let buildLog = "";
  let info: any;
  try {
    info = await Template.build(t, name, {
      cpuCount: 2,
      memoryMB: 4096,
      onBuildLogs: (chunk: any) => {
        const line = String(chunk).trimEnd();
        buildLog = (buildLog + "\n" + line).slice(-80_000);
        log(line.slice(0, 200));
      },
    });
  } catch (e) {
    throw new Error(`e2b template build failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 400)} — log tail: ${buildLog.slice(-800)}`);
  }
  // the template name is the physical id
  const contents = summarizeBase(seed, buildLog);
  setBasePlatform(stateDir, alias, "e2b", {
    snapshot: name,
    bakedAt: new Date().toISOString(),
    template: seed.label,
    contents,
  });
  return { platform: "e2b", alias, snapshot: name, snapshotId: String(info.templateId ?? name), seed: seed.label, contents };
}

/** Read-only view for `foreman base list` / operator triage. */
export function opsBaseList(stateDir: string): {
  alias: string;
  snapshot?: string;
  bakedAt?: string;
  contents?: string;
  platforms: { platform: string; snapshot: string; bakedAt?: string; contents?: string }[];
}[] {
  return Object.entries(readBases(stateDir)).map(([alias, e]) => ({
    alias,
    snapshot: e.snapshot || undefined,
    bakedAt: e.bakedAt,
    contents: e.contents,
    platforms: (e.platforms
      ? MACHINE_MODES.filter((p) => !!e.platforms![p]?.snapshot).map((p) => ({
          platform: p,
          snapshot: e.platforms![p]!.snapshot,
          bakedAt: e.platforms![p]!.bakedAt,
          contents: e.platforms![p]!.contents,
        }))
      : []),
  }));
}
