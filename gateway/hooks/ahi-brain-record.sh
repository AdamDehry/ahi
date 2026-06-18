#!/usr/bin/env bash
# AHI Stop hook: process the just-written Claude JSONL into the local brain.
set -u

AHI_HOME="${AHI_HOME:-$HOME/ahi}"
SCRIPT="$AHI_HOME/infra/sessions/scripts/process-session.mjs"

if [ "${AHI_BRAIN_AUTO_BUILD:-true}" = "false" ]; then
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[ahi-brain-record] node-not-found" >&2
  exit 0
fi
if [ ! -f "$SCRIPT" ]; then
  echo "[ahi-brain-record] script-missing path=$SCRIPT" >&2
  exit 0
fi

TMP="$(mktemp -t ahi-brain-hook.XXXXXX 2>/dev/null || mktemp)"
cat > "$TMP"

SESSION_ID="$(node -e 'const fs=require("fs"); const s=fs.readFileSync(process.argv[1],"utf8").trim(); if(!s) process.exit(0); const j=JSON.parse(s); process.stdout.write(j.session_id || j.sessionId || "");' "$TMP" 2>/dev/null || true)"
JSONL="$(node -e 'const fs=require("fs"); const s=fs.readFileSync(process.argv[1],"utf8").trim(); if(!s) process.exit(0); const j=JSON.parse(s); process.stdout.write(j.transcript_path || j.transcriptPath || "");' "$TMP" 2>/dev/null || true)"
rm -f "$TMP"

if [ -z "$SESSION_ID" ] && [ -z "$JSONL" ]; then
  echo "[ahi-brain-record] skipped reason=no-session-or-transcript" >&2
  exit 0
fi

(
  if [ -n "$JSONL" ]; then
    node "$SCRIPT" --jsonl "$JSONL" --quiet
  else
    node "$SCRIPT" --session-id "$SESSION_ID" --quiet
  fi
) >/dev/null 2>>"${AHI_HOME}/state/primary/sessions/logs/brain-record.err" &

echo "[ahi-brain-record] queued session=${SESSION_ID:-unknown}" >&2
exit 0
