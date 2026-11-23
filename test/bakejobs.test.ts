import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baseStatusPath,
  listBaseBakeStatuses,
  readBakeStatus,
  readBaseBakeStatus,
  readRepoBakeStatus,
  repoStatusPath,
  spawnBaseBake,
  spawnRepoBake,
  updateBakeStatus,
} from "../src/bakejobs";

let dir: string | null = null;
const tmp = () => (dir ??= mkdtempSync(join(tmpdir(), "pdfbakejob-")));
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("bake job status", () => {
  test("running → done round-trips and keeps the start fields", () => {
    const path = baseStatusPath(tmp(), "daytona");
    const started = updateBakeStatus(path, {
      kind: "base",
      key: "daytona",
      state: "running",
      pid: process.pid,
      started_at: "2026-11-24T00:00:00Z",
      platform: "daytona",
      name: "factory-dev-daytona-r1",
    });
    expect(started.state).toBe("running");
    const done = updateBakeStatus(path, { state: "done", ended_at: "2026-11-24T00:10:00Z", snapshot: "factory-dev-daytona-r1" });
    expect(done.name).toBe("factory-dev-daytona-r1");
    expect(done.started_at).toBe("2026-11-24T00:00:00Z");
    expect(readBaseBakeStatus(tmp(), "daytona")).toMatchObject({ state: "done", snapshot: "factory-dev-daytona-r1" });
  });

  test("a running job whose pid is gone reads as failed (daemon restart / crash)", () => {
    const path = repoStatusPath(tmp(), "app");
    updateBakeStatus(path, {
      kind: "repo",
      key: "app",
      state: "running",
      pid: 2 ** 22,
      started_at: "2026-11-24T00:00:00Z",
      slug: "app",
    });
    const job = readRepoBakeStatus(tmp(), "app");
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("is gone");
  });

  test("listBaseBakeStatuses returns only platforms with a status file", () => {
    updateBakeStatus(baseStatusPath(tmp(), "instabox"), {
      kind: "base",
      key: "instabox",
      state: "done",
      started_at: "2026-11-24T00:00:00Z",
      platform: "instabox",
      snapshot: "factory-dev-instabox-r1",
    });
    const jobs = listBaseBakeStatuses(tmp());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ platform: "instabox", snapshot: "factory-dev-instabox-r1" });
    expect(readBakeStatus(join(tmp(), "missing.json"))).toBeNull();
  });
});

describe("spawn validation (no child process)", () => {
  test("instavm and alias targets are refused before spawning", () => {
    expect(() => spawnBaseBake(tmp(), { platform: "instavm", name: "factory-dev-instavm-r1" })).toThrow(/InstaVM is excluded/);
    expect(() => spawnBaseBake(tmp(), { platform: "daytona", name: "shared-base" })).toThrow(/base alias/);
  });

  test("a live bake lock answers started:false instead of double-spawning", () => {
    writeFileSync(join(tmp(), "bake-base-daytona.lock"), `${process.pid}\n`);
    const r = spawnBaseBake(tmp(), { platform: "daytona", name: "factory-dev-daytona-r1" });
    expect(r.started).toBe(false);
    expect(r.reason).toContain("already live");
  });

  test("an onboarded repo with a live lock answers started:false; an unknown slug throws", () => {
    const slug = "app";
    mkdirSync(join(tmp(), "repos", slug), { recursive: true });
    writeFileSync(
      join(tmp(), "repos", slug, "config.json"),
      JSON.stringify({
        repo: "acme/app",
        slug,
        models: { default: { provider: "x", model: "y" } },
        scenario: { ports: [] },
        env: { mode: "host" },
      })
    );
    writeFileSync(join(tmp(), `bake-repo-${slug}.lock`), `${process.pid}\n`);
    const r = spawnRepoBake(tmp(), slug);
    expect(r.started).toBe(false);
    expect(r.reason).toContain("already live");
    expect(() => spawnRepoBake(tmp(), "ghost")).toThrow(/not onboarded/);
  });

  test("a repo bake waits for a live tick instead of racing the lap's checkout", () => {
    const slug = "busy";
    mkdirSync(join(tmp(), "repos", slug), { recursive: true });
    writeFileSync(
      join(tmp(), "repos", slug, "config.json"),
      JSON.stringify({
        repo: "acme/busy",
        slug,
        models: { default: { provider: "x", model: "y" } },
        scenario: { ports: [] },
        env: { mode: "host" },
      })
    );
    writeFileSync(join(tmp(), "tick-busy.lock"), `${process.pid}\n`);
    const r = spawnRepoBake(tmp(), slug);
    expect(r.started).toBe(false);
    expect(r.reason).toContain("tick is live");
  });

  test("base bake spawns the detached foreman command with the seed and status file", () => {
    const calls: any[] = [];
    const spawnImpl = ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return { pid: process.pid, on() {}, unref() {} };
    }) as any;
    const r = spawnBaseBake(
      tmp(),
      { platform: "daytona", name: "factory-dev-daytona-r1", seed: "daytona-large", seedKind: "snapshot" },
      { spawnImpl }
    );
    expect(r.started).toBe(true);
    expect(calls[0].args.slice(1, 4)).toEqual(["base", "bake", "--platform"]);
    expect(calls[0].args).toContain("--status-file");
    expect(calls[0].args).toContain("--seed");
    expect(calls[0].args).toContain("daytona-large");
    expect(calls[0].args).toContain("--state-dir");
    const job = readBaseBakeStatus(tmp(), "daytona");
    expect(job?.state).toBe("running");
    expect(job?.pid).toBe(process.pid);
  });

  test("repo bake spawns foreman bake with the repo status file", () => {
    const slug = "app";
    mkdirSync(join(tmp(), "repos", slug), { recursive: true });
    writeFileSync(
      join(tmp(), "repos", slug, "config.json"),
      JSON.stringify({
        repo: "acme/app",
        slug,
        models: { default: { provider: "x", model: "y" } },
        scenario: { ports: [] },
        env: { mode: "host" },
      })
    );
    const calls: any[] = [];
    const spawnImpl = ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return { pid: process.pid, on() {}, unref() {} };
    }) as any;
    const r = spawnRepoBake(tmp(), slug, { spawnImpl });
    expect(r.started).toBe(true);
    expect(calls[0].args.slice(1, 3)).toEqual(["bake", "app"]);
    expect(calls[0].args).toContain("--status-file");
    expect(readRepoBakeStatus(tmp(), slug)?.state).toBe("running");
  });
});
