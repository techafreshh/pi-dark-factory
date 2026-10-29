import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RepoConfig } from "./types";

/**
 * The one git identity every factory-written commit carries. Read from the
 * factory user's ~/.gitconfig; without it, in-container agents guess one
 * (observed: "pi-dark-factory <factory@pi.local>" on a delivered PR).
 */
export function readGitIdentity(home: string = homedir()): { name: string; email: string } | null {
  try {
    const raw = readFileSync(join(home, ".gitconfig"), "utf8");
    const name = /^\s*name\s*=\s*(.+)$/m.exec(raw)?.[1]?.trim();
    const email = /^\s*email\s*=\s*(.+)$/m.exec(raw)?.[1]?.trim();
    return name && email ? { name, email } : null;
  } catch {
    return null;
  }
}

export interface StageEnv {
  /** docker prefix (may be empty in host mode) — callPi prepends it to the pi argv */
  argvPrefix: string[];
  /** best-effort `docker rm -f` after the stage process ends (timeouts, crashes) */
  cleanup?: string[];
  containerized: boolean;
}

/**
 * Build the execution wrapper for one agent stage or scenario command.
 *
 * Container mode is the install-freedom environment: the stage runs as root
 * inside the product's own compose definition (or a generic fallback image
 * until the repo ships one), so pip/apt/go/npm installs are ordinary work —
 * and their mess dies with the container. Host paths are bind-mounted at
 * their identical container paths so prompts, cwds and session dirs need no
 * translation. Stayed-host processes (gh, git bookkeeping) never enter here.
 */
export function buildStageCmd(
  cfg: RepoConfig,
  worktree: string,
  stateDir: string,
  uniqueName: string,
  opts: { passEnv?: string[]; extraEnv?: Record<string, string>; publishPorts?: boolean; machine?: string } = {}
): StageEnv {
  if (cfg.env.mode === "instabox") {
    // The only stage that reaches buildStageCmd in instabox mode is plan —
    // implement/review go through machine.callStage's own ssh bridge and
    // scenarios through runScenarioInMachine, neither of which lands here.
    // An earlier CLI-bridge design prefixed stages with `instabox ssh
    // <machine> --`, deriving the machine name from the stage name — but that
    // binary was never installed host-side, so every plan spawn died as an
    // empty "pi exited 127" (spawn ENOENT, message discarded). Plan is
    // host-side by design, exactly as the runtime-context brief tells the
    // agent.
    return { argvPrefix: [], containerized: false };
  }
  if (cfg.env.mode !== "compose") return { argvPrefix: [], containerized: false };

  // same-path mirroring: worktree + state at identical container paths,
  // the factory user's Pi install (binary, auth, models, node runtime) at /root/.pi
  const mounts = [
    "-v", `${worktree}:${worktree}`,
    "-v", `${stateDir}:${stateDir}`,
    "-v", `${homedir()}/.pi:/root/.pi`,
    "-v", `${homedir()}/.pi/agent/bin/pi:/usr/local/bin/pi:ro`,
  ];
  const identity = readGitIdentity();
  const envFlags = [
    "-e", "HOME=/root",
    // the repo is owned by a host uid the container doesn't know
    "-e", "GIT_CONFIG_COUNT=1",
    "-e", "GIT_CONFIG_KEY_0=safe.directory",
    "-e", "GIT_CONFIG_VALUE_0=*",
    ...(identity
      ? [
          "-e", "GIT_CONFIG_COUNT=3",
          "-e", "GIT_CONFIG_KEY_1=user.name",
          "-e", `GIT_CONFIG_VALUE_1=${identity.name}`,
          "-e", "GIT_CONFIG_KEY_2=user.email",
          "-e", `GIT_CONFIG_VALUE_2=${identity.email}`,
        ]
      : []),
    ...Object.entries(opts.extraEnv ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...(opts.passEnv ?? cfg.env.pass_env ?? [])
      .filter(Boolean)
      .filter((k) => process.env[k] !== undefined)
      .flatMap((k) => ["-e", k]),
    // compose twin of buildMachineEnvFile's force-pass: an explicit pass_env
    // list from before web grounding never carries TINYFISH_API_KEY
    ...(process.env.TINYFISH_API_KEY ? ["-e", "TINYFISH_API_KEY"] : []),
  ];
  const rm = ["docker", "rm", "-f", uniqueName];

  const composePath = join(worktree, cfg.env.compose_file ?? "docker-compose.yml");
  if (existsSync(composePath)) {
    // product-owned compose: its worker service defines OS, deps and the
    // compose network (falkordb, postgres…); the factory only overrides the
    // command per stage. --service-ports is load-bearing: `compose run`
    // publishes NOTHING by default, but host-side black-box verification
    // needs the scenario ports on 127.0.0.1 (declare them on the service).

    // Factory-injected plumbing, merged as a second -f (compose merges with
    // last-file-wins): pi inside the stage reaches the keyrouter via
    // host.docker.internal, and on Linux that name exists only with the
    // host-gateway mapping — product compose files do not ship it, and every
    // stage would fail with a deterministic instant "Connection error" while
    // every generic probe stays green (observed on mdrender 09:33 & 10:06).
    // `docker compose run` has no --add-host, so an override file is the only
    // product-agnostic injection point.
    const overridePath = join(stateDir, "compose-override.yml");
    try {
      writeFileSync(
        overridePath,
        `# factory-injected stage plumbing for ${cfg.slug} — regenerated on every stage, do not edit\n` +
          `services:\n  ${cfg.env.service}:\n    extra_hosts:\n      - "host.docker.internal:host-gateway"\n`
      );
    } catch {
      // unwritable state dir: a previously written override (if any) still applies
    }

    // best-effort self-heal: the commit gate needs git in the stage container
    // and slim images don't ship it (node:22-slim observed). Debian-ish
    // images get git in ~15s once per stage spawn; anything else fails
    // visibly on the git step instead of mysteriously.
    const wrap = [
      "sh", "-c",
      'command -v git >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1; }; exec "$@"',
      "stage-sh",
    ];
    const argvPrefix = [
      "docker", "compose", "-f", composePath, "-f", overridePath, "run", "--rm",
      // publish the scenario ports ONLY for scenario runs: agent stages test
      // their server container-locally (localhost inside the container), and
      // a stage container squatting 127.0.0.1:8108/8110 collides with every
      // subsequent spawn ("port is already allocated", observed mdrender
      // 10:27) — the port pair belongs to the verifier, nobody else
      ...(opts.publishPorts ? ["--service-ports"] : []),
      "--name", uniqueName, "--workdir", worktree,
      ...mounts, ...envFlags, cfg.env.service, ...wrap,
    ];
    return { argvPrefix, cleanup: rm, containerized: true };
  }

  // No compose in the worktree yet — generic fallback image, factory-owned:
  // cache volumes keep pip/uv/npm installs cheap across stages, and — only
  // for scenario runs — the scenario ports are published on 127.0.0.1 for
  // host-side verification.
  const ports = (opts.publishPorts ? cfg.scenario.ports : []).map((p) => ["-p", `127.0.0.1:${p}:${p}`]).flat();
  const caches = ["-v", "pdf-uv:/root/.cache/uv", "-v", "pdf-pip:/root/.cache/pip", "-v", "pdf-npm:/root/.npm"];
  const argvPrefix = [
    // -i is load-bearing: callPi writes the stage prompt to the spawned
    // process's stdin, and `docker run` without -i gives the container an
    // empty stdin — pi reads an empty prompt, settles instantly at rc=0 with
    // no assistant message, and every stage "fails" in ~4s
    "docker", "run", "-i", "--rm", "--name", uniqueName,
    // the clinepass key router (and any host service) is reachable from the
    // container via this name
    "--add-host", "host.docker.internal:host-gateway",
    "-w", worktree, ...mounts, ...caches, ...ports, ...envFlags,
    cfg.env.image,
  ];
  return { argvPrefix, cleanup: rm, containerized: true };
}
