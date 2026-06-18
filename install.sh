#!/usr/bin/env bash
# AHI Suite — macOS / Linux installer bootstrap.
#
# Thin shim that verifies prerequisites and hands off to the cross-platform
# Node wizard at installer/lib/wizard.js. All real install work lives there
# so install.sh and install.ps1 stay tiny and identical in intent.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
WIZARD="$REPO_DIR/installer/lib/wizard.js"

color() {
  case "$1" in
    red)    printf '\033[0;31m';;
    green)  printf '\033[0;32m';;
    yellow) printf '\033[0;33m';;
    blue)   printf '\033[0;34m';;
    bold)   printf '\033[1m';;
    *)      :;;
  esac
}
reset() { printf '\033[0m'; }

say() { printf '%s%s%s\n' "$(color "$1")" "$2" "$(reset)"; }

say bold "AHI Suite Installer"
echo "-------------------"
echo

# ─── Prereq: git ───────────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  say red "git is not installed."
  echo
  echo "Install git:"
  echo "  • macOS:  xcode-select --install   (or: brew install git)"
  echo "  • Linux:  sudo apt install git     (or your distro package manager)"
  echo
  echo "Then re-run this installer."
  exit 1
fi
say green "Found git"

# ─── Prereq: Node 20+ ─────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  say red "Node.js is not installed."
  echo
  echo "AHI needs Node.js 20 or newer."
  echo
  echo "Install Node.js from one of:"
  echo "  • Official installer:   https://nodejs.org/en/download"
  echo "  • Homebrew (macOS):     brew install node"
  echo "  • Linux package manager (apt, dnf, pacman, etc.)"
  echo
  echo "Then re-run this installer."
  exit 1
fi

NODE_VERSION_RAW="$(node -v 2>/dev/null || true)"
if ! printf '%s' "$NODE_VERSION_RAW" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+'; then
  say red "Could not parse Node version from 'node -v' (got: '$NODE_VERSION_RAW')."
  echo "Reinstall Node from https://nodejs.org/en/download and try again."
  exit 1
fi
NODE_VERSION="${NODE_VERSION_RAW#v}"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  say red "Node.js $NODE_VERSION is too old. AHI needs 20+."
  echo "Update Node and re-run this installer."
  exit 1
fi
say green "Found Node.js v$NODE_VERSION"

# ─── Prereq: npm ──────────────────────────────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
  say red "npm is missing — it should ship with Node.js."
  echo "Reinstall Node.js from https://nodejs.org/en/download and try again."
  exit 1
fi

# ─── Sanity: wizard exists ────────────────────────────────────────────────
if [ ! -f "$WIZARD" ]; then
  say red "Installer is incomplete — missing $WIZARD"
  echo "Re-clone the repo or download a fresh release."
  exit 1
fi

# ─── Hand off to the Node wizard ─────────────────────────────────────────
exec node "$WIZARD" "$@"
