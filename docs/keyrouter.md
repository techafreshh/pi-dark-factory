# ClinePass key router — multi-key failover

`src/keyrouter.ts` (systemd service `pi-keyrouter`, port 8099) fans provider requests over a live-reloaded pool of API keys so one provider's weekly cap can never cascade into lost laps.

## ClinePass key router (multi-key failover)

ClinePass's weekly cap once killed ~13 consecutive laps in the old factory. The router makes
that class impossible: `src/keyrouter.ts` (systemd service `pi-keyrouter`, port 8099) sits
between Pi and ClinePass and fans requests over however many API keys live in the file named
by `CRPASS_KEYS_FILE` on the unit (here `/home/factory/state/clinepass.keys`, one per line,
live-reloaded). A 429 parses the reset window from
ClinePass's own text ("The limit resets in 4d 5h") and cools that key **exactly** that long
(unparseable → 24h, 402 → 7d, 401 → 30d), the retry transparently uses the next hot key, and
SSE streams pass through untouched. All keys cooling → a plain 429 (add a key, it's picked up
live). Cooldowns persist across restarts. `curl :8099/health` / `/pool` shows the damage.

**Access token.** ufw lets every container on the host's docker networks (10.0.0.0/8) reach
:8099, so an open router lets any of them spend the pool. Set `CRPASS_ROUTER_TOKEN` on the
`pi-keyrouter` unit (an `EnvironmentFile`, mode 600) and every proxied call and `/pool` then
require `Authorization: Bearer <token>`; `/health` stays open with pool counts only. pi sends
a provider's `apiKey` exactly that way, so set the `clinepass-rotator` entry's `apiKey` in
`models.json` to the same token. Unset, the router stays open (it logs `OPEN` at start).

Wiring (one-time, on the VPS): merge `templates/pi-models.clinepass-router.json` into the
factory user's `~/.pi/agent/models.json`, put your keys in the `CRPASS_KEYS_FILE` file, and point
repo configs at `provider: "clinepass-rotator"`. `host.docker.internal` resolves both on the
host (the `dark-factory-setup` skill adds the `/etc/hosts` line) and inside containers (fallback
mode adds it; compose mode uses `extra_hosts`). Remember: host-local, so machine-mode (instabox,
boxd) stages bypass it.
