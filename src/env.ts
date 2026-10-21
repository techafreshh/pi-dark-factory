import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RepoConfig } from "./types";

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
  opts: { passEnv?: string[]; extraEnv?: Record<string, string> } = {}
): StageEnv {
  if (cfg.env.mode !== "compose") return { argvPrefix: [], containerized: false };

  // same-path mirroring: worktree + state at identical container paths,
  // the factory user's Pi install (binary, auth, models, node runtime) at /root/.pi
  const mounts = [
    "-v", `${worktree}:${worktree}`,
    "-v", `${stateDir}:${stateDir}`,
    "-v", `${homedir()}/.pi:/root/.pi`,
    "-v", `${homedir()}/.pi/agent/bin/pi:/usr/local/bin/pi:ro`,
  ];
  const envFlags = [
    "-e", "HOME=/root",
    // the repo is owned by a host uid the container doesn't know
    "-e", "GIT_CONFIG_COUNT=1",
    "-e", "GIT_CONFIG_KEY_0=safe.directory",
    "-e", "GIT_CONFIG_VALUE_0=*",
    ...Object.entries(opts.extraEnv ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...(opts.passEnv ?? cfg.env.pass_env ?? [])
      .filter(Boolean)
      .filter((k) => process.env[k] !== undefined)
      .flatMap((k) => ["-e", k]),
  ];
  const rm = ["docker", "rm", "-f", uniqueName];

  const composePath = join(worktree, cfg.env.compose_file ?? "docker-compose.yml");
  if (existsSync(composePath)) {
    // product-owned compose: its worker service defines OS, deps and the
    // compose network (falkordb, postgres…); the factory only overrides the
    // command per stage. --service-ports is load-bearing: `compose run`
    // publishes NOTHING by default, but host-side black-box verification
    // needs the scenario ports on 127.0.0.1 (declare them on the service).
    const argvPrefix = [
      "docker", "compose", "-f", composePath, "run", "--rm",
      "--service-ports",
      "--name", uniqueName, "--workdir", worktree,
      ...mounts, ...envFlags, cfg.env.service,
    ];
    return { argvPrefix, cleanup: rm, containerized: true };
  }

  // No compose in the worktree yet — generic fallback image, factory-owned:
  // cache volumes keep pip/uv/npm installs cheap across stages, and the
  // scenario ports are published on 127.0.0.1 for host-side verification.
  const ports = cfg.scenario.ports.map((p) => ["-p", `127.0.0.1:${p}:${p}`]).flat();
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
