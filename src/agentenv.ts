/**
 * The environment handed to agent-run processes on the VPS: host-side pi
 * stages (plan in every mode, all stages in host mode, the docker client in
 * compose mode) and scenario commands (setup/start/probes/teardown run
 * product code). An allowlist, not process.env: the factory's own service
 * env carries FACTORY_API_KEY, the laptop key, the InstaBox and boxd keys and
 * a GitHub token, and an agent that reads issue text or fetched web pages
 * must not be one `printenv` away from all of them.
 *
 * Defense in depth only: a host-side agent still runs as the factory user and
 * can read whatever that user can read on disk. The intake author gate is what
 * keeps strangers' text away from agents in the first place.
 */
const BASE = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "TMPDIR", "TMP", "TEMP",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
];

/** locale, XDG dirs, node runtime knobs, CA bundles, the docker client's
 *  daemon/context selection (compose mode spawns `docker` with this env) */
const PREFIXES = ["LC_", "XDG_", "NODE_", "SSL_CERT_", "DOCKER_"];

/** force-delivered to every stage regardless of a repo's pass_env, as the
 *  machine env file and compose -e flags already do: the web-grounding
 *  extension reads it, and pre-grounding pass_env lists never carried it */
const ALWAYS = ["TINYFISH_API_KEY"];

export function agentEnv(passEnv: string[] = [], source: Record<string, string | undefined> = process.env): Record<string, string> {
  const allow = new Set([...BASE, ...ALWAYS, ...passEnv]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (allow.has(k) || PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
