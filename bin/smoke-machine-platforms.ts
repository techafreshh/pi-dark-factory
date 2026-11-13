/**
 * Gating smoke for the newer machine platforms (daytona, e2b, instavm).
 *
 * The research (2026-11-12) left three classes of claims UNVERIFIED per
 * platform — egress from inside the box (Daytona Tier 1/2 allowlist, InstaVM
 * Free "package managers + AI APIs"), long-exec behavior, and the exact REST
 * wire shapes InstaVM documents only loosely. This script runs the cheap
 * experiments that settle them with a real key and RECORDS the raw responses
 * to state/smoke/<platform>.json — the captured shapes the boundary rule
 * requires before any stub test may claim to speak for the platform.
 *
 *   DAYTONA_API_KEY=… bun bin/smoke-machine-platforms.ts --platform daytona
 *   E2B_API_KEY=…     bun bin/smoke-machine-platforms.ts --platform e2b
 *   INSTAVM_API_KEY=… bun bin/smoke-machine-platforms.ts --platform instavm \
 *                       [--snapshot <name>] [--push-repo owner/name] [--long]
 *
 * Gates: boot → exec round-trip (framed markers) → in-box deadline (rc 124)
 * → git reachability from inside the box → (optional) a real push and a
 * ≥5-min continuous exec → destroy. Costs one short-lived sandbox per run
 * (≈ $0.03–0.05 of credits). Exit 1 on any failed gate.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const platformArg = flag("platform");
const snapshot = flag("snapshot");
const pushRepo = flag("push-repo");
const long = has("long");
const stateDir = process.env.PI_FACTORY_STATE ?? "./state";

if (!platformArg || !["daytona", "e2b", "instavm"].includes(platformArg)) {
  console.error("usage: bun bin/smoke-machine-platforms.ts --platform <daytona|e2b|instavm> [--snapshot <name>] [--push-repo owner/name] [--long]");
  process.exit(1);
}
const platform = platformArg as "daytona" | "e2b" | "instavm";

const results: { gate: string; ok: boolean; detail: string; ms: number; raw?: unknown }[] = [];
const timings = new Map<string, number>();

async function gate(name: string, fn: () => Promise<string>, capture?: () => unknown) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    results.push({ gate: name, ok: true, detail: detail.slice(0, 400), ms, ...(capture ? { raw: capture() } : {}) });
    console.log(`  (pass) ${name} — ${detail.slice(0, 120)} [${(ms / 1000).toFixed(1)}s]`);
  } catch (e: any) {
    const ms = Date.now() - t0;
    results.push({ gate: name, ok: false, detail: String(e?.message ?? e).slice(0, 400), ms, ...(capture ? { raw: capture() } : {}) });
    console.log(`  (FAIL) ${name} — ${String(e?.message ?? e).slice(0, 200)} [${(ms / 1000).toFixed(1)}s]`);
  }
}

/** The smallest config the drivers' bash primitives need (repo_dir only). */
function smokeCfg(): any {
  const dirs: Record<string, string> = { daytona: "/home/daytona/repo", e2b: "/home/user/repo", instavm: "/app/repo" };
  return {
    repo: "octocat/Hello-World", slug: "hello-world", default_branch: "master", attempts: 1,
    models: { default: { provider: "p", model: "p/m" } },
    scenario: { ports: [] },
    env: { mode: platform, [platform]: { repo_dir: dirs[platform] } },
  };
}

let bashFn: ((script: string, timeoutMs: number, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>) | null = null;
let destroyFn: (() => Promise<void>) | null = null;

if (platform === "daytona") {
  if (!process.env.DAYTONA_API_KEY) { console.error("DAYTONA_API_KEY is not set"); process.exit(1); }
  const { Daytona } = await import("@daytona/sdk");
  const { daytonaBash } = await import("../src/machine-daytona");
  const client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
  let sbx: any = null;
  bashFn = async (script, timeoutMs, env) => daytonaBash(sbx, script, { timeoutMs, env });
  destroyFn = async () => {
    if (!sbx) return;
    await client.delete(sbx).catch(() => {});
    // verify: the SDK delete does not throw on a scoped-out 403, so confirm
    // by name before claiming success
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try { await client.get(sbx.id); } catch { return; } // gone
    }
    throw new Error(`sandbox ${sbx.id} still exists after delete — the API key is missing delete:sandboxes (403 swallowed by the fire-and-forget SDK)`);
  };
  await gate("boot", async () => {
    const t0 = Date.now();
    const spec = snapshot
      ? { snapshot, name: `pdf-smoke-${Date.now()}`, labels: { factory: "1", smoke: "1" } }
      : { image: "ubuntu:24.04", name: `pdf-smoke-${Date.now()}`, labels: { factory: "1", smoke: "1" } };
    try {
      sbx = await client.create(spec, { timeout: 900 });
    } catch (e: any) {
      // a create that times out client-side may still have landed platform-side
      // (recorded: "Sandbox <id> was created before the timeout and may still
      // be starting") — reconnect by name instead of orphaning it
      sbx = await client.get(spec.name);
      if (!sbx) throw e;
    }
    return `sandbox ${sbx.id} from ${snapshot ?? "ubuntu:24.04"} in ${Date.now() - t0}ms`;
  }, () => (sbx ? { id: sbx.id, name: sbx.name, user: sbx.user } : null));
} else if (platform === "e2b") {
  if (!process.env.E2B_API_KEY) { console.error("E2B_API_KEY is not set"); process.exit(1); }
  const { Sandbox } = await import("e2b");
  const { e2bBash } = await import("../src/machine-e2b");
  let sbx: any = null;
  bashFn = async (script, timeoutMs, env) => e2bBash(sbx, script, { timeoutMs, env });
  destroyFn = async () => { if (sbx) await sbx.kill().catch(() => {}); };
  await gate("boot", async () => {
    const t0 = Date.now();
    sbx = await Sandbox.create(snapshot ?? "base", { timeoutMs: 30 * 60_000, metadata: { factory: "1", smoke: "1" } });
    return `sandbox ${sbx.sandboxId} from ${snapshot ?? "base"} in ${Date.now() - t0}ms`;
  }, () => (sbx ? { sandboxId: sbx.sandboxId } : null));
} else {
  if (!process.env.INSTAVM_API_KEY) { console.error("INSTAVM_API_KEY is not set"); process.exit(1); }
  const { instavmClientFromEnv, instavmBash } = await import("../src/machine-instavm");
  const client = instavmClientFromEnv(smokeCfg());
  let vm: any = null;
  bashFn = async (script, timeoutMs, env) => instavmBash(client, String(vm?.session_id ?? vm?.vm_id), script, { timeoutMs, env });
  destroyFn = async () => { if (vm) await client.deleteVm(String(vm.vm_id ?? vm.id)).catch(() => {}); };
  await gate("boot", async () => {
    const t0 = Date.now();
    const spec: any = {
      vm_lifetime_seconds: 1800,
      metadata: { factory: "1", smoke: "1", name: `pdf-smoke-${Date.now()}` },
      env: {},
    };
    if (snapshot) spec.snapshot_id = await client.snapshotIdByName(snapshot);
    vm = await client.createVm(spec);
    return `vm ${vm.vm_id ?? vm.id} (session ${vm.session_id}) ${snapshot ? `from ${snapshot}` : "from the stock image"} in ${Date.now() - t0}ms — full response: ${JSON.stringify(vm).slice(0, 300)}`;
  }, () => vm ?? null);
}

const GIT_REACH = `git ls-remote https://github.com/octocat/Hello-World.git HEAD && echo GIT_OK`;

try {
  if (!bashFn) throw new Error("boot gate failed — nothing to exec in");

  await gate("exec round-trip (framed markers)", async () => {
    const r = await bashFn!(`echo PDFSMOKE_OK`, 30_000);
    if (r.code !== 0 || !r.stdout.includes("PDFSMOKE_OK")) throw new Error(`rc=${r.code} stdout=${r.stdout.slice(0, 120)} stderr=${r.stderr.slice(0, 120)}`);
    return "markers parsed, rc propagated";
  });

  await gate("in-box deadline (rc 124 on a sleep past the deadline)", async () => {
    const r = await bashFn!(`sleep 60`, 6_000);
    if (!r.timedOut || r.code !== 124) throw new Error(`expected rc 124 + timedOut, got rc=${r.code} timedOut=${r.timedOut}`);
    return "the wrapper owns the deadline on this platform too";
  });

  await gate("git reachability from inside the box (public ls-remote)", async () => {
    // the gate probes EGRESS, not package presence — a stock image without
    // git (recorded: daytona ubuntu:24.04, 2026-11-13) installs it first
    const prep = await bashFn!(`command -v git >/dev/null 2>&1 || { export DEBIAN_FRONTEND=noninteractive; (apt-get update -qq && apt-get install -y -qq git) || (apk add --no-cache git) || (yum install -y git); }`, 240_000);
    if (prep.code !== 0 && !prep.stdout.includes("/usr/bin/git") && !prep.stderr.includes("/usr/bin/git")) {
      // fall through: the ls-remote below will surface the real problem
    }
    const r = await bashFn!(GIT_REACH, 60_000);
    if (!r.stdout.includes("GIT_OK")) throw new Error(`egress blocked or git unusable: rc=${r.code} ${r.stderr.slice(0, 200)}`);
    return "github.com reachable";
  });

  if (pushRepo && (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) {
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const branch = `pdf-smoke-${Date.now()}`;
    await gate(`git push from inside the box (${pushRepo})`, async () => {
      const script = [
        `set -e`,
        `git config --global user.email factory@example.com 2>/dev/null || true`,
        `git config --global user.name factory 2>/dev/null || true`,
        `git config --global url."https://x-access-token:${token}@github.com/".insteadOf "https://github.com/"`,
        `git clone --depth 1 https://github.com/${pushRepo}.git /tmp/.pdfsmoke-repo`,
        `cd /tmp/.pdfsmoke-repo`,
        `git checkout -q -B ${branch}`,
        `echo smoke-${Date.now()} > .pdf-smoke-probe`,
        `git add .pdf-smoke-probe && git commit -qm "pdf smoke probe"`,
        `git push -q origin ${branch}`,
        `git push -q origin --delete ${branch}`,
        `echo PUSH_OK`,
      ].join("\n");
      const r = await bashFn!(script, 180_000);
      if (!r.stdout.includes("PUSH_OK")) throw new Error(`push failed: rc=${r.code} ${r.stderr.slice(0, 300)}`);
      return `pushed and deleted ${branch}`;
    });
  } else if (pushRepo) {
    results.push({ gate: "git push", ok: false, detail: "--push-repo given but GH_TOKEN/GITHUB_TOKEN is not set", ms: 0 });
    console.log(`  (SKIP) git push — GH_TOKEN/GITHUB_TOKEN is not set`);
  }

  if (long) {
    await gate("continuous exec ≥5 min", async () => {
      const r = await bashFn!(`sleep 300 && echo LONG_OK`, 360_000);
      if (!r.stdout.includes("LONG_OK")) throw new Error(`long exec failed: rc=${r.code} ${r.stderr.slice(0, 200)}`);
      return "the box stayed alive and the stream EOFed";
    });
  } else {
    console.log("  (skip) continuous exec ≥5 min — pass --long to run it");
  }
} finally {
  await gate("destroy", async () => {
    if (!destroyFn) throw new Error("nothing to destroy");
    await destroyFn();
    return "machine deleted";
  });
}

const dir = join(stateDir, "smoke");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const record = {
  platform,
  at: new Date().toISOString(),
  snapshot: snapshot ?? "(stock)",
  results,
};
writeFileSync(join(dir, `${platform}.json`), JSON.stringify(record, null, 2) + "\n");

const failed = results.filter((r) => !r.ok);
console.log(`\n${platform}: ${results.length - failed.length}/${results.length} gates passed — recorded to ${join(dir, `${platform}.json`)}`);
if (failed.length > 0) process.exit(1);
