#!/usr/bin/env bash
# pi-dark-factory bootstrap — the ONE SSH moment this factory ever needs.
#
# Run ON THE VPS, once:  sudo bash bootstrap.sh
#
# What it does:
#   1. creates the `factory` user (dedicated, home /home/factory)
#   2. installs bun + pi + git + gh for that user (skips what exists)
#   3. clones/updates this repo at /home/factory/pi-dark-factory
#   4. writes /home/factory/factoryd.env (API key + state dir, chmod 600)
#   5. installs systemd units: pi-factory (timer, every 15 min) + pi-factoryd (API)
#   6. prints the Caddy block to expose factoryd at your domain
#
# What it does NOT do: gh auth (interactive — you run `gh auth login` as
# factory, or export GH_TOKEN in factoryd.env), and the Caddy DNS/domain.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run with sudo: sudo bash bootstrap.sh"; exit 1; }
REPO_URL="${REPO_URL:-https://github.com/techafreshh/pi-dark-factory.git}"
DOMAIN="${DOMAIN:-factory-api.techa.pro}"
F_HOME=/home/factory

echo "== 1. factory user =="
id factory >/dev/null 2>&1 || useradd -m -s /bin/bash -c "pi dark factory" factory
command -v docker >/dev/null 2>&1 && id -nG factory | grep -qw docker || usermod -aG docker factory 2>/dev/null || true

aufactory() { sudo -u factory -H bash -lc "$1"; }

echo "== 2. runtimes (bun, pi, git, gh) for the factory user =="
for t in git gh curl; do command -v $t >/dev/null || { apt-get update -qq && apt-get install -y -qq $t; }; done
aufactory 'command -v bun >/dev/null 2>&1 || (mkdir -p /home/factory/.bunbin && cd /tmp && curl -fsSL -o bun.zip https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip && python3 -c "import zipfile; zipfile.ZipFile(\"bun.zip\").extractall(\".\")" && cp /tmp/bun-linux-x64/bun /home/factory/.bunbin/ && chmod +x /home/factory/.bunbin/bun && echo bun installed)'
grep -q '.bunbin' $F_HOME/.profile || echo 'export PATH="/home/factory/.bunbin:$PATH"' >> $F_HOME/.profile
BUN=$F_HOME/.bunbin/bun
aufactory 'command -v pi >/dev/null 2>&1 || npm install -g @earendil-works/pi-coding-agent || '$BUN' add -g @earendil-works/pi-coding-agent || true'

echo "== 3. repo + state =="
sudo -u factory test -d $F_HOME/pi-dark-factory/.git \
  && aufactory "cd $F_HOME/pi-dark-factory && git pull --ff-only" \
  || aufactory "git clone $REPO_URL $F_HOME/pi-dark-factory"
mkdir -p $F_HOME/state && chown -R factory:factory $F_HOME/state $F_HOME/pi-dark-factory
${BUN} --version >/dev/null 2>&1 || true

echo "== 4. factoryd.env (API key) =="
if [[ ! -f $F_HOME/factoryd.env ]]; then
  KEY=$(openssl rand -hex 32)
  cat > $F_HOME/factoryd.env <<E
PI_FACTORY_STATE=$F_HOME/state
FACTORYD_PORT=8077
FACTORY_API_KEY=$KEY
E
  chown factory:factory $F_HOME/factoryd.env && chmod 600 $F_HOME/factoryd.env
fi
. <(grep FACTORY_API_KEY $F_HOME/factoryd.env)

echo "== 5. systemd units =="
cat > /etc/systemd/system/pi-factory.service <<E
[Unit]
Description=pi-dark-factory lap
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=factory
WorkingDirectory=$F_HOME/pi-dark-factory
Environment=PI_FACTORY_STATE=$F_HOME/state
ExecStart=$BUN src/foreman.ts tick
TimeoutStartSec=infinity
KillMode=control-group
E
cat > /etc/systemd/system/pi-factory.timer <<'E'
[Unit]
Description=pi-dark-factory every 15 minutes
[Timer]
OnCalendar=*-*-* *:00/15:00
Persistent=true
[Install]
WantedBy=timers.target
E
cat > /etc/systemd/system/pi-factoryd.service <<E
[Unit]
Description=pi-dark-factory remote API
After=network-online.target
Wants=network-online.target
[Service]
User=factory
WorkingDirectory=$F_HOME/pi-dark-factory
EnvironmentFile=$F_HOME/factoryd.env
ExecStart=$BUN src/factoryd.ts
Restart=always
E
systemctl daemon-reload
systemctl enable --now pi-factory.timer pi-factoryd.service
sleep 1
curl -fsS http://127.0.0.1:8077/health && echo

echo "== 6. Caddy block (add to your Caddyfile, then reload caddy) =="
cat <<E
$DOMAIN {
  @health path /health
  handle @health { reverse_proxy 127.0.0.1:8077 }
  @unauthorized not header X-Api-Key $KEY
  handle @unauthorized { respond 401 }
  reverse_proxy 127.0.0.1:8077
}
E

cat <<E

════════════════════════════════════════════════════════════════════════
DONE. Remaining manual steps (one-time):
  1. gh auth for the factory user (interactive):   sudo -u factory -H gh auth login
     — or add GH_TOKEN=ghp_… to $F_HOME/factoryd.env
  2. pi provider auth:                             sudo -u factory -H bash -lc 'pi auth login'
  3. add the Caddy block above and reload caddy
  4. on YOUR machine:
       export FACTORY_URL=https://$DOMAIN
       export FACTORY_API_KEY=$KEY        # print it: sudo cat $F_HOME/factoryd.env
       python3 bin/factory-remote doctor  # from the factory repo (or any checkout)
From now on everything — onboarding, backlog, laps, ops — is remote.
════════════════════════════════════════════════════════════════════════
E
