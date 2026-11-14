/**
 * The browser toolchain (docs/acceptance.md) — what browser e2e needs on
 * every lane: Chromium + node 22+ + the `e2e` framework + the agent-browser
 * CLI. One canonical script per lane, kept here so the host verb and the
 * five machine bakes install THE SAME THING (a box whose Chromium cannot
 * launch fails its bake loudly, never silently mid-acceptance).
 *
 * Egress caveat: apt/browser-CDN downloads are unrestricted on instabox and
 * boxd, but Daytona Tier 1/2 and InstaVM Free egress run allowlists (package
 * managers + AI APIs) — the in-box smoke at the end of the bake is exactly
 * the check that tells you whether a platform can carry the toolchain. A
 * platform that fails it stays on curl/shell scenarios for repos on that
 * mode; host/compose repos are unaffected.
 */

/** In-box toolchain location (bake target; the suite runner symlinks its
 *  node_modules into the suite dir and points PLAYWRIGHT_BROWSERS_PATH at
 *  the browsers beside it). Mirrored by stages/acceptance.boxToolchainDir. */
export const BOX_TOOLCHAIN_DIR = "/opt/pdf-e2e";

const TOOLCHAIN_INSTALL = [
  `set -eu`,
  `mkdir -p ${BOX_TOOLCHAIN_DIR} ${BOX_TOOLCHAIN_DIR}-browsers`,
  // node 22+: the boxd base ships bun only, instavm's is bare ubuntu —
  // install node where it is missing (idempotent everywhere else)
  `if ! command -v node >/dev/null 2>&1; then`,
  `  (curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -n bash - && sudo -n apt-get install -y nodejs) \\`,
  `    || (sudo -n apt-get update && sudo -n apt-get install -y nodejs npm)`,
  `fi`,
  // chromium + its headless deps — system packages beat the Playwright
  // download where the CDN is blocked; Playwright drives a system chrome
  // just as well, so the smoke accepts either route
  `(command -v chromium >/dev/null 2>&1) || (sudo -n apt-get update && sudo -n apt-get install -y chromium chromium-driver fonts-liberation libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2 || true)`,
  // the e2e toolchain: one shared project whose node_modules the suites
  // symlink (ESM import specifiers ignore NODE_PATH)
  `cd ${BOX_TOOLCHAIN_DIR}`,
  `[ -f package.json ] || echo '{"name":"pdf-e2e-toolchain","private":true,"type":"module"}' > package.json`,
  `npm install --no-audit --no-fund --silent e2e @e2e-dev/web playwright-core || npm install --no-audit --no-fund e2e @e2e-dev/web playwright-core`,
  `agent-browser --version >/dev/null 2>&1 || npm install --no-audit --no-fund --silent -g agent-browser || true`,
  `agent-browser install >/dev/null 2>&1 || true`,
  `node ${BOX_TOOLCHAIN_DIR}/node_modules/playwright-core/cli.js install chromium 2>&1 | tail -1 || true`,
].join("\n");

const TOOLCHAIN_SMOKE = [
  `set -eu`,
  `cd ${BOX_TOOLCHAIN_DIR}`,
  `node -e "console.log('NODE_OK', process.version)"`,
  // the bake fails loudly (exit 31) when no browser route works: a snapshot
  // without a launchable Chromium would fail every future acceptance run at
  // walk time, long after the operator believed the bake done
  `CHROME_BIN=$(command -v chromium || command -v chromium-browser || true)`,
  `SMOKE_OUT=/tmp/pdf-browser-smoke.out`,
  `: > "$SMOKE_OUT"`,
  `if [ -n "$CHROME_BIN" ]; then`,
  `  $CHROME_BIN --headless --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null 2>&1 && echo CHROME_OK system >> "$SMOKE_OUT" || true`,
  `fi`,
  `if ! grep -q CHROME_OK "$SMOKE_OUT"; then`,
  `  PLAYWRIGHT_BROWSERS_PATH=${BOX_TOOLCHAIN_DIR}-browsers node -e "const { chromium } = require('playwright-core'); (async () => { const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); await b.close(); console.log('CHROME_OK playwright'); })().catch((e) => { console.error('NO_BROWSER: ' + (e.message || e)); process.exit(31); })" >> "$SMOKE_OUT" 2>&1 || true`,
  `fi`,
  `cat "$SMOKE_OUT"`,
  `grep -q CHROME_OK "$SMOKE_OUT" || { echo "BROWSER_SMOKE_FAILED: no launchable Chromium in the box (egress or deps)"; exit 31; }`,
  `npx --no-install e2e --version`,
  `echo TOOLCHAIN_OK`,
].join("\n");

/** The script appended to every platform bake when the repo turns browser
 *  acceptance on: install, then smoke. A non-zero smoke exits the bake. */
export function browserBakeScript(): string {
  return TOOLCHAIN_INSTALL + "\n\n" + TOOLCHAIN_SMOKE;
}

/** The host-side install/verify script for `foreman host-tools` (host and
 *  compose repos run their browsers HERE). Exits non-zero when the toolchain
 *  cannot run; a missing penthera only warns (scans fail visibly later). */
export function hostToolsScript(): string {
  const TC = '"$HOME/.pdf/e2e-toolchain"';
  return [
    `set -eu`,
    `TC=${TC}`,
    `mkdir -p "$TC" "$TC-browsers"`,
    `if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then`,
    `  sudo -n apt-get update && sudo -n apt-get install -y chromium chromium-driver fonts-liberation libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2 || echo "HOSTTOOLS: system chromium not installed (the playwright download will be used)"`,
    `fi`,
    `cd "$TC"`,
    `[ -f package.json ] || echo '{"name":"pdf-e2e-toolchain","private":true,"type":"module"}' > package.json`,
    `npm install --no-audit --no-fund --silent e2e @e2e-dev/web playwright-core || npm install --no-audit --no-fund e2e @e2e-dev/web playwright-core`,
    `node "$TC/node_modules/playwright-core/cli.js" install chromium 2>&1 | tail -1 || true`,
    `agent-browser --version >/dev/null 2>&1 || npm install --no-audit --no-fund --silent -g agent-browser || true`,
    `agent-browser install >/dev/null 2>&1 || true`,
    `SMOKE_OUT=/tmp/pdf-hosttools-smoke.out`,
    `: > "$SMOKE_OUT"`,
    `CHROME_BIN=$(command -v chromium || command -v chromium-browser || true)`,
    `if [ -n "$CHROME_BIN" ]; then`,
    `  $CHROME_BIN --headless --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null 2>&1 && echo CHROME_OK system >> "$SMOKE_OUT" || true`,
    `fi`,
    `if ! grep -q CHROME_OK "$SMOKE_OUT"; then`,
    `  PLAYWRIGHT_BROWSERS_PATH="$TC-browsers" node -e "const { chromium } = require('playwright-core'); (async () => { const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); await b.close(); console.log('CHROME_OK playwright'); })().catch((e) => { console.error('NO_BROWSER: ' + (e.message || e)); process.exit(31); })" >> "$SMOKE_OUT" 2>&1 || true`,
    `fi`,
    `cat "$SMOKE_OUT"`,
    `grep -q CHROME_OK "$SMOKE_OUT" || { echo "HOSTTOOLS_FAILED: no launchable Chromium on the host"; exit 31; }`,
    `npx --no-install e2e --version`,
    `npx -y penthera@latest --version 2>/dev/null || echo "HOSTTOOLS: penthera not reachable (security scans will fail until it is)"`,
    `echo HOSTTOOLS_OK`,
  ].join("\n");
}
