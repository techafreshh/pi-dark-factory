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
