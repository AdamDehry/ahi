#!/usr/bin/env bash
set -euo pipefail
SCREENSHOT_DIR="${BROWSER_CONTROL_SCREENSHOT_DIR:-${AHI_HOME:-$HOME/ahi}/state/browser-control/screenshots}"
DAYS="${BROWSER_CONTROL_SCREENSHOT_TTL_DAYS:-7}"
mkdir -p "$SCREENSHOT_DIR"
find "$SCREENSHOT_DIR" -type f -mtime +"$DAYS" -print -delete
