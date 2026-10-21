#!/usr/bin/env bash
# One-shot laptop setup for driving a pi-dark-factory remotely.
#
#   ./laptop-setup.sh [FACTORY_URL] [--key KEY] [--client-from PATH]
#
# - installs bin/factory-remote (local checkout sibling, else fetched from
#   this repo's main branch) to ~/.local/bin/
# - stores the URL + key in ~/.config/factory-remote/{url,key} (600)
# - verifies the handshake with `doctor`
#
# curl-friendly: curl -fsSL <raw>/laptop-setup.sh | bash -s -- https://pi-factory.techa.pro
# (pass the key via FACTORY_API_KEY env or --key; a stored key is kept; a
#  missing key prompts hidden only when stdin is a terminal)
set -euo pipefail

URL="https://pi-factory.techa.pro"
KEY="${FACTORY_API_KEY:-}"
CLIENT_SRC=""
REPO_RAW="https://raw.githubusercontent.com/techafreshh/pi-dark-factory/main"

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --client-from) CLIENT_SRC="$2"; shift 2 ;;
    http*) URL="$1"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift || true
done
# the shift after the case ate one arg too many for value-flags; re-normalize
if [ "${1:-}" = "--key" ] && [ $# -ge 2 ]; then KEY="$2"; shift 2; fi

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

here=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$here/bin/factory-remote" ] && CLIENT_SRC="${CLIENT_SRC:-$here/bin/factory-remote}"
fi

dest="${HOME}/.local/bin/factory-remote"
mkdir -p "$(dirname "$dest")"
if [ -n "$CLIENT_SRC" ]; then
  install -m 755 "$CLIENT_SRC" "$dest"
else
  echo "fetching factory-remote from $REPO_RAW"
  curl -fsSL "$REPO_RAW/bin/factory-remote" -o "$dest"
  chmod 755 "$dest"
fi

cfg="${HOME}/.config/factory-remote"
mkdir -p "$cfg" && chmod 700 "$cfg"
printf %s "$URL" > "$cfg/url" && chmod 600 "$cfg/url"

if [ -z "$KEY" ] && [ -s "$cfg/key" ]; then
  echo "keeping existing stored key"
fi
if [ -n "$KEY" ]; then
  printf %s "$KEY" > "$cfg/key" && chmod 600 "$cfg/key"
elif [ ! -s "$cfg/key" ]; then
  if [ ! -t 0 ]; then
    echo "no key provided (pass --key or set FACTORY_API_KEY) — doctor will 401" >&2
  else
    printf "FACTORY_API_KEY (input hidden): "
    read -rs KEY; echo
    printf %s "$KEY" > "$cfg/key" && chmod 600 "$cfg/key"
  fi
fi

echo "verifying handshake against $URL ..."
"$dest" doctor

echo
echo "Ready. From ANY directory — the pilot repo's checkout is the happy path:"
echo "  factory-remote onboard OWNER/NAME"
echo "  factory-remote config SLUG --json '{\"env\":{\"mode\":\"compose\",\"image\":\"node:22\"},\"merge\":{\"required_checks\":[\"*\"]}}'"
echo "  factory-remote scenario SLUG runtime --file runtime.json"
echo "  factory-remote backlog SLUG --prd-file PRD.md --create"
echo "  factory-remote tick SLUG"
