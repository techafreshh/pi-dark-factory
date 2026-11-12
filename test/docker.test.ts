import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Static invariants over the Docker files. Each one fails silently in production if broken, so it
// is pinned here. Plain text and regexes only: the repo has no YAML dependency on purpose.
const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const dockerfile = read("docker/Dockerfile");
const compose = read("docker/compose.yml");
const caddy = read("docker/compose.caddy.yml");
const envExample = read("docker/.env.example");
const entrypoint = read("docker/entrypoint.sh");
const dockerignore = read(".dockerignore");
const gitignore = read(".gitignore");
const gitattributes = read(".gitattributes");

/** the file without comment-only lines */
const code = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

describe("Dockerfile", () => {
  test("the code lives under a path containing pi-dark-factory (src/lock.ts matches the cwd)", () => {
    const workdir = /^WORKDIR\s+(\S+)/m.exec(dockerfile)?.[1] ?? "";
    expect(workdir).toMatch(/\/pi-dark-factory(\/|$)/);
    expect(dockerfile).toMatch(/\/opt\/pi-dark-factory/);
    expect(dockerfile).toContain("ln -s /opt/pi-dark-factory/cli/bin/dark-factory.js");
    expect(dockerfile).toMatch(/^ENTRYPOINT .*\/opt\/pi-dark-factory\/docker\/entrypoint\.sh/m);
  });

  test("runs as the factory user and installs from the frozen lockfile", () => {
    expect(dockerfile).toMatch(/^USER factory$/m);
    expect(dockerfile.trimEnd().split("\n").filter((l) => /^USER /.test(l)).pop()).toBe("USER factory");
    expect(dockerfile).toContain("bun install --frozen-lockfile --production");
  });

  test("ps is installed (foreman cleanup shells out to it)", () => {
    expect(dockerfile).toMatch(/\bprocps\b/);
  });
});

describe("compose.yml", () => {
  test("every published port is bound to 127.0.0.1", () => {
    const published = code(compose)
      .split("\n")
      .filter((l) => /^\s*-\s*"[^"]*:\d+"\s*$/.test(l));
    expect(published.length).toBe(2); // factoryd and dashboard
    for (const l of published) expect(l).toMatch(/"127\.0\.0\.1:/);
    // no bare "8077:8077" in the live or the commented-out examples either
    for (const l of compose.split("\n")) expect(l).not.toMatch(/"\d+:\d+"/);
  });

  test("the scheduler is on, children are reaped, and both volumes are mounted", () => {
    const c = code(compose);
    expect(c).toMatch(/PDF_SCHEDULER_MINUTES:\s*\$\{PDF_SCHEDULER_MINUTES:-15\}/);
    expect(c).toMatch(/PDF_TICK_ON_START:\s*\$\{PDF_TICK_ON_START:-1\}/);
    expect(c.match(/^\s*init:\s*true$/gm)?.length).toBe(2);
    expect(c).toContain("factory-state:/home/factory/state");
    expect(c).toContain("factory-pi:/home/factory/.pi");
  });

  test("factoryd cannot start without an API key, and the dashboard never gets the env file", () => {
    const c = code(compose);
    expect(c).toMatch(/FACTORY_API_KEY:\s*\$\{FACTORY_API_KEY:\?/);
    expect(c.match(/env_file:/g)?.length).toBe(1);
    const dash = c.slice(c.indexOf("  dashboard:"));
    expect(dash).not.toContain("env_file");
    expect(dash).not.toContain("GH_TOKEN");
  });
});

describe("compose.caddy.yml", () => {
  test("factoryd publishes nothing and joins web_gateway; nothing else is published", () => {
    const c = code(caddy);
    expect(c).toMatch(/ports:\s*!reset\s*\[\]/);
    expect(c).toMatch(/web_gateway/);
    expect(c).not.toMatch(/"[^"]*:\d+"/);
  });
});

describe(".dockerignore and .gitignore", () => {
  test("env files stay out of the image and out of git", () => {
    const lines = dockerignore.split("\n").map((l) => l.trim());
    expect(lines).toContain("**/.env*");
    expect(lines).toContain("docker/.env");
    expect(lines).toContain(".git");
    expect(lines).toContain("state");
    expect(gitignore.split("\n").map((l) => l.trim())).toContain("docker/.env");
  });

  test("the entrypoint is checked out with LF endings", () => {
    expect(gitattributes).toMatch(/^docker\/\*\.sh\s+text\s+eol=lf$/m);
  });
});

describe(".env.example", () => {
  test("holds no value for any secret", () => {
    const secrets = envExample.split("\n").filter((l) => /^(FACTORY_API_KEY|GH_TOKEN|GITHUB_TOKEN|[A-Z0-9_]*_API_KEY)=/.test(l));
    expect(secrets.length).toBeGreaterThanOrEqual(8);
    for (const l of secrets) expect(l).toMatch(/=$/);
  });

  test("documents every variable compose.yml reads", () => {
    const used = new Set([...compose.matchAll(/\$\{([A-Z_]+)[:}-]/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) expect(envExample).toMatch(new RegExp(`^#?\\s*${name}=`, "m"));
  });
});

describe("entrypoint.sh", () => {
  test("fails on errors and never traces (a trace would print the tokens)", () => {
    expect(entrypoint).toMatch(/^set -eu$/m);
    expect(code(entrypoint)).not.toMatch(/set\s+-\w*x/);
    expect(code(entrypoint)).not.toMatch(/set\s+-o\s+xtrace/);
  });

  test("never echoes a secret variable", () => {
    for (const l of code(entrypoint).split("\n")) {
      if (/^\s*(echo|printf)\b/.test(l) && !/printf '%s' "\$GH_TOKEN" \| /.test(l)) {
        expect(l).not.toMatch(/\$\{?(GH_TOKEN|GITHUB_TOKEN|\w*_API_KEY)\b/);
      }
    }
  });
});

// The entrypoint run for real (sh, real git) against a fake `gh`. The fake logs each call and
// whether GH_TOKEN was set, never its value. `gh api user --jq <expr>` answers in the shape the
// real binary printed on 2026-11-12 for the login+id expression: "techafreshh 67512801".
const FAKE_GH = `#!/bin/sh
t=unset; [ -n "\${GH_TOKEN:-}" ] && t=set
echo "gh $* | GH_TOKEN=$t" >> "$CALLS"
case "$1 $2" in
  "auth login") cat >/dev/null; [ "$FAKE_LOGIN" = ok ] ;;
  "auth setup-git") exit 0 ;;
  "api user")
    [ "$FAKE_API" = ok ] || exit 1
    case "$*" in *tostring*) echo "techafreshh 67512801" ;; *) echo "techafreshh" ;; esac ;;
  *) exit 2 ;;
esac
`;
const SECRET = "ghp_SECRETSECRETSECRET0123456789";
const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function runEntrypoint(o: { token: boolean; login: "ok" | "fail"; api: "ok" | "fail" }) {
  const dir = mkdtempSync(join(tmpdir(), "pdfentry-"));
  tmps.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const calls = join(dir, "calls.log");
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, "home"),
    PI_FACTORY_STATE: join(dir, "state"),
    CALLS: calls,
    FAKE_LOGIN: o.login,
    FAKE_API: o.api,
  };
  mkdirSync(env.HOME);
  if (o.token) env.GH_TOKEN = SECRET;
  const r = Bun.spawnSync(["sh", join(root, "docker/entrypoint.sh"), "true"], { env });
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    gitconfig: readFileSync(join(env.HOME, ".gitconfig"), "utf8"),
  };
}

describe.skipIf(!Bun.which("timeout"))("entrypoint.sh run against a fake gh", () => {
  const SETUP = "gh auth setup-git --hostname github.com";

  test("login accepted: credentials set, login ran without the token variables, identity from the API", () => {
    const r = runEntrypoint({ token: true, login: "ok", api: "ok" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("gh logged in, git credentials set");
    expect(r.calls).toContain(SETUP);
    expect(r.calls).toContain("gh auth login --with-token | GH_TOKEN=unset");
    expect(r.gitconfig).toContain("name = techafreshh");
    expect(r.gitconfig).toContain("email = 67512801+techafreshh@users.noreply.github.com");
  });

  test("login rejected for scopes but the token works: git credentials are still set, and no false 'bad token' warning", () => {
    const r = runEntrypoint({ token: true, login: "fail", api: "ok" });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(SETUP);
    expect(r.out).toContain("gh login skipped");
    expect(r.err).not.toContain("WARNING GitHub did not accept");
    expect(r.err).not.toContain("expired, revoked or mistyped");
  });

  test("token refused by GitHub: git credentials are still configured, the warning names the cause, the container still starts", () => {
    const r = runEntrypoint({ token: true, login: "fail", api: "fail" });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(SETUP);
    expect(r.err).toContain("WARNING GitHub did not accept GH_TOKEN");
    expect(r.gitconfig).toContain("pi-dark-factory"); // fallback identity: the API said nothing
  });

  test("no token: gh is never called, one warning", () => {
    const r = runEntrypoint({ token: false, login: "ok", api: "ok" });
    expect(r.code).toBe(0);
    expect(r.calls).toBe("");
    expect(r.err).toContain("no GH_TOKEN or GITHUB_TOKEN set");
  });

  test("the token value never appears in any output or in the git config", () => {
    for (const [login, api] of [["ok", "ok"], ["fail", "ok"], ["fail", "fail"]] as const) {
      const r = runEntrypoint({ token: true, login, api });
      expect(r.out + r.err + r.calls + r.gitconfig).not.toContain(SECRET);
    }
  });
});

describe("ignore files keep secret scratch files out", () => {
  test(".env.new (the setup skill's temp file) is not copied into the image or committed", () => {
    const lines = dockerignore.split("\n").map((l) => l.trim());
    expect(lines).toContain("**/.env*");
    const ig = (f: string) => Bun.spawnSync(["git", "check-ignore", "-q", f], { cwd: root }).exitCode === 0;
    expect(ig("docker/.env")).toBe(true);
    expect(ig("docker/.env.new")).toBe(true);
    expect(ig("docker/.env.example")).toBe(false);
  });
});
