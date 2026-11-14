# pi-dark-factory image: the factory daemon and the dashboard run from the same image.
# Build context is the repo root:  docker build -f docker/Dockerfile -t pi-dark-factory:dev .
FROM node:22-bookworm-slim

# Node >= 22 is a pi requirement (DEPLOYMENT.md section 2). The pins match the working VPS.
ARG BUN_VERSION=1.3.14
ARG PI_VERSION=0.80.2
# Optional shell snippet run as root in its own layer, for extra toolchains:
#   docker compose build --build-arg FACTORY_IMAGE_EXTRA="apt-get install -y golang"
ARG FACTORY_IMAGE_EXTRA=""

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1

# gh comes from GitHub's own apt repo: Debian's is old, and the VPS runs a current one.
# procps provides `ps`, which `foreman cleanup` uses to find stale pi workers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl unzip ca-certificates openssh-client python3 python3-pip build-essential tini procps \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Bun (official installer, pinned) into /usr/local/bin, then pi.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" \
 && npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

RUN if [ -n "$FACTORY_IMAGE_EXTRA" ]; then \
      apt-get update && sh -c "$FACTORY_IMAGE_EXTRA" && rm -rf /var/lib/apt/lists/*; \
    fi

# The stock `node` user holds uid 1000; replace it with `factory`. The state and pi dirs are
# created here so named volumes inherit this ownership on first mount.
RUN userdel -r node \
 && useradd -m -u 1000 -s /bin/bash factory \
 && mkdir -p /home/factory/state /home/factory/.pi /opt/pi-dark-factory \
 && chown -R factory:factory /home/factory /opt/pi-dark-factory

# Browser acceptance (docs/acceptance.md): Chromium + the e2e toolchain + the
# security scanner, baked into the image so host/compose-mode repos get
# browser e2e and penthera with NO per-container install — an apt-installed
# browser would die with the container on every rebuild. Set
# --build-arg FACTORY_BROWSER_TOOLS=0 for a lean image without them;
# `foreman host-tools` verifies what this baked and skips what it finds.
ARG FACTORY_BROWSER_TOOLS=1
ARG PENTHERA_VERSION=2.4.0
USER root
RUN if [ "$FACTORY_BROWSER_TOOLS" = "1" ]; then \
      mkdir -p -m 755 /home/factory/.pdf/e2e-toolchain /home/factory/.pdf/e2e-toolchain-browsers \
   && chown -R factory:factory /home/factory/.pdf; \
    fi
USER factory
# the toolchain lives at the path hostToolchainDir resolves to ($HOME/.pdf/e2e-toolchain,
# browsers beside it) so the suite runner and `foreman host-tools` both find it.
# Playwright downloads its own Chromium and agent-browser its own Chrome — no
# apt chromium package; playwright's own --with-deps pulls the exact system
# libs its build needs (a hand-picked list missed some and the browser could
# not launch — review round 1).
RUN if [ "$FACTORY_BROWSER_TOOLS" = "1" ]; then \
      cd /home/factory/.pdf/e2e-toolchain \
   && printf '{"name":"pdf-e2e-toolchain","private":true,"type":"module"}' > package.json \
   && npm install --no-audit --no-fund --silent e2e @e2e-dev/web playwright-core; \
    fi
USER root
# global npm installs stay in the ROOT layer: /usr/local/lib/node_modules is
# root-owned, and `npm install -g` as the factory user is an EACCES (that
# broke the default build once — review round 1 on the acceptance PRs)
RUN if [ "$FACTORY_BROWSER_TOOLS" = "1" ]; then \
      PLAYWRIGHT_BROWSERS_PATH=/home/factory/.pdf/e2e-toolchain-browsers node /home/factory/.pdf/e2e-toolchain/node_modules/playwright-core/cli.js install --with-deps chromium \
   && npm install -g --silent agent-browser \
   && npm cache clean --force; \
    fi
USER factory
RUN if [ "$FACTORY_BROWSER_TOOLS" = "1" ]; then \
      agent-browser install \
   && npx -y penthera@${PENTHERA_VERSION} --version; \
    fi

# The code dir MUST contain "pi-dark-factory": src/lock.ts recognizes live factory processes
# by a cwd matching /pi-dark-factory/, and a path without it makes live tick locks look dead.
WORKDIR /opt/pi-dark-factory
USER factory

COPY --chown=factory:factory package.json bun.lock ./
RUN bun install --frozen-lockfile --production
# dashboard-ui/dist is tracked, so there is no Vite build here
COPY --chown=factory:factory . .

USER root
RUN chmod +x docker/entrypoint.sh cli/bin/dark-factory.js \
 && ln -s /opt/pi-dark-factory/cli/bin/dark-factory.js /usr/local/bin/dark-factory
USER factory

ENV PI_FACTORY_STATE=/home/factory/state

# 8077 is factoryd, 8787 the dashboard. Compose publishes both on 127.0.0.1 only.
EXPOSE 8077 8787
# `-s` makes tini a subreaper when it is not PID 1 (compose adds its own init), so detached
# tick children are reaped either way and tini prints no warning.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/opt/pi-dark-factory/docker/entrypoint.sh"]
CMD ["bun", "src/factoryd.ts"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8077/health >/dev/null || exit 1
