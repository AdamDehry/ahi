#!/bin/bash
# ahi-retrieval.sh — UserPromptSubmit hook for the AHI gateway.
#
# Forwards the hook's stdin JSON to the compiled retrieval CLI and relays its
# stdout (the hookSpecificOutput JSON) and stderr (telemetry marker) back to
# Claude Code. The hook fires for every user turn in a gateway-spawned
# `claude` subprocess because this script is referenced from
# $AHI_HOME/gateway/.claude/settings.json and the gateway cwd is
# $AHI_HOME/gateway.
#
# The heavy lifting (retrieval scoring, context assembly) is done in
# $AHI_HOME/gateway/dist/retrieval-cli.js — see src/retrieval-cli.ts.
#
# Env expected:
#   AHI_AGENT   — injected by the gateway per-turn (e.g. "michael", "tzali")
#   AHI_HOME    — base install directory (set by install wizard, defaults to ~/ahi)
#   NODE_BIN    — optional override for the node binary; otherwise we search PATH
#
# On any failure we emit an empty additionalContext JSON and exit 0 so the
# user's turn still runs — degraded (no retrieval), never blocked.

set -u

AHI_HOME="${AHI_HOME:-$HOME/ahi}"
GATEWAY_DIR="${AHI_GATEWAY_DIR:-$AHI_HOME/gateway}"
CLI="${GATEWAY_DIR}/dist/retrieval-cli.js"

# Resolve node: explicit override → PATH
if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN}" ]; then
  NODE="${NODE_BIN}"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  echo "[ahi-retrieval] node-not-found" >&2
  echo '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":""}}'
  exit 0
fi

if [ ! -f "${CLI}" ]; then
  echo "[ahi-retrieval] cli-missing path=${CLI}" >&2
  echo '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":""}}'
  exit 0
fi

# Run from the gateway dir so any relative resolution inside the CLI (session
# index paths, soul dir) behaves identically to the long-running gateway.
cd "${GATEWAY_DIR}" || true

# Hard timeout so a stuck retrieval can never hang the user turn. macOS has
# no GNU `timeout`; use perl alarm as a portable fallback.
exec perl -e '
  my $timeout = 8;
  my $pid = fork();
  if ($pid == 0) {
    exec(@ARGV) or exit 127;
  }
  local $SIG{ALRM} = sub {
    kill("TERM", $pid);
    sleep 1;
    kill("KILL", $pid);
    print STDERR "[ahi-retrieval] timeout\n";
    print "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"\"}}";
    exit 0;
  };
  alarm($timeout);
  waitpid($pid, 0);
  exit($? >> 8);
' "${NODE}" "${CLI}"
