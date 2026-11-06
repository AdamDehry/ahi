#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${BROWSER_CONTROL_PROFILE_DIR:-${AHI_HOME:-$HOME/ahi}/state/browser-control/chrome-cdp-profile}"
PORT="${BROWSER_CONTROL_CDP_PORT:-9222}"

mkdir -p "$PROFILE_DIR"

if command -v google-chrome >/dev/null 2>&1; then
  CHROME="$(command -v google-chrome)"
elif command -v chromium >/dev/null 2>&1; then
  CHROME="$(command -v chromium)"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROME="$(command -v chromium-browser)"
elif [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  echo "browser-control: Chrome/Chromium not found. Install Chrome, or set CHROME_BIN." >&2
  exit 2
fi

exec "${CHROME_BIN:-$CHROME}" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$PORT" --user-data-dir="$PROFILE_DIR" "$@"
