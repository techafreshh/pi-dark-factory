#!/bin/sh
# Container start-up for factoryd. Prepares git and gh, then execs the command.
# Secrets are never echoed, and this script must never run under `set -x`.
set -eu

# 0. docker/.env.example leaves unused keys empty. An empty key must not reach pi or the
#    web-grounding extension as "set", so drop every empty one.
for k in GH_TOKEN GITHUB_TOKEN ANTHROPIC_API_KEY OPENROUTER_API_KEY ZAI_API_KEY DEEPSEEK_API_KEY \
         TINYFISH_API_KEY INSTABOX_API_KEY BOXD_API_KEY GIT_USER_NAME GIT_USER_EMAIL; do
  eval "v=\${$k:-}"
  if [ -z "$v" ]; then unset "$k"; fi
done

# 1. GitHub token: machine stages read GITHUB_TOKEN, gh reads GH_TOKEN. Same value for both.
if [ -n "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then GITHUB_TOKEN="$GH_TOKEN"; fi
if [ -n "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then GH_TOKEN="$GITHUB_TOKEN"; fi
if [ -n "${GH_TOKEN:-}" ]; then export GH_TOKEN GITHUB_TOKEN; fi

# 2. Git identity (src/env.ts reads it from ~/.gitconfig).
name="${GIT_USER_NAME:-}"
email="${GIT_USER_EMAIL:-}"
if { [ -z "$name" ] || [ -z "$email" ]; } && [ -n "${GH_TOKEN:-}" ]; then
  who="$(gh api user --jq '.login + " " + (.id | tostring)' 2>/dev/null || true)"
  if [ -n "$who" ]; then
    login="${who% *}"
    id="${who#* }"
    [ -n "$name" ] || name="$login"
    [ -n "$email" ] || email="${id}+${login}@users.noreply.github.com"
  fi
fi
if [ -z "$name" ] || [ -z "$email" ]; then
  [ -n "$name" ] || name="pi-dark-factory"
  [ -n "$email" ] || email="factory@localhost"
  echo "entrypoint: WARNING commits will be authored as '$name <$email>'; set GIT_USER_NAME and GIT_USER_EMAIL, or a valid GH_TOKEN" >&2
fi
git config --global user.name "$name"
git config --global user.email "$email"

# 3. gh login and git credentials, regenerated on every start, so rotating the token needs a
#    restart and nothing else. `gh auth login` refuses while the token variables are set.
if [ -n "${GH_TOKEN:-}" ]; then
  if printf '%s' "$GH_TOKEN" | env -u GH_TOKEN -u GITHUB_TOKEN gh auth login --with-token >/dev/null 2>&1; then
    gh auth setup-git --hostname github.com
    echo "entrypoint: gh logged in, git credentials set"
  else
    echo "entrypoint: WARNING gh rejected GH_TOKEN (expired, revoked or mistyped); pushes and issue reads will fail" >&2
  fi
else
  echo "entrypoint: WARNING no GH_TOKEN or GITHUB_TOKEN set; a mounted gh login is the only way GitHub calls work" >&2
fi

# 4. First-run dirs, then one line naming the optional keys that are off (never the values).
mkdir -p "${PI_FACTORY_STATE:-$HOME/state}" "$HOME/.pi"
off=""
for k in TINYFISH_API_KEY INSTABOX_API_KEY BOXD_API_KEY; do
  eval "v=\${$k:-}"
  [ -n "$v" ] || off="$off $k"
done
if [ -n "$off" ]; then echo "entrypoint: optional keys off:$off"; fi

exec "$@"
