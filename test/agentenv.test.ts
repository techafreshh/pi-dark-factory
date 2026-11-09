import { describe, expect, test } from "bun:test";
import { agentEnv } from "../src/agentenv";

// the variable NAMES the live pi-factoryd ran with (2026-11-09, values never read)
const live = {
  BOXD_API_KEY: "s", DARK_FACTORY_LAPTOP_KEY: "s", FACTORYD_PORT: "8077", FACTORY_API_KEY: "s",
  GH_TOKEN: "s", GITHUB_TOKEN: "s", HOME: "/home/factory", INSTABOX_API_KEY: "s", INVOCATION_ID: "x",
  JOURNAL_STREAM: "x", LANG: "C.UTF-8", LOGNAME: "factory", MEMORY_PRESSURE_WATCH: "x",
  MEMORY_PRESSURE_WRITE: "x", PATH: "/usr/bin", PI_FACTORY_STATE: "/home/factory/state", SHELL: "/bin/bash",
  SYSTEMD_EXEC_PID: "1", TINYFISH_API_KEY: "s", USER: "factory",
};

describe("agentEnv (what an agent-run process may see)", () => {
  test("the live daemon env reduces to the runtime basics, the web key and the repo's pass_env", () => {
    const env = agentEnv(["GITHUB_TOKEN", "ZAI_API_KEY"], live);
    expect(Object.keys(env).sort()).toEqual(["GITHUB_TOKEN", "HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TINYFISH_API_KEY", "USER"]);
  });

  test("prefix families pass (locale, XDG, node, CA bundle, docker client); unknown names never do", () => {
    const env = agentEnv([], {
      LC_ALL: "C", XDG_RUNTIME_DIR: "/run/user/1001", NODE_EXTRA_CA_CERTS: "/ca.pem",
      SSL_CERT_FILE: "/ca.pem", DOCKER_HOST: "unix:///x", NEW_SECRET_TOKEN: "s", undef: undefined,
    });
    expect(Object.keys(env).sort()).toEqual(["DOCKER_HOST", "LC_ALL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "XDG_RUNTIME_DIR"]);
  });
});
