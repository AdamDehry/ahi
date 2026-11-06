#!/usr/bin/env bash
# codex-consult — non-interactive Codex CLI wrapper for AHI agents.
#
# Sends a single prompt to Codex (GPT-5 / Codex Plus) via the bundled CLI's
# `codex exec` subcommand and prints just the model's final message to stdout.
#
# CRITICAL: must use `codex exec`, NOT bare `codex` — the latter spawns the
# interactive TUI and will hang programmatic callers.
#
# Usage:
#   codex_consult.sh "your prompt here"
#   echo "your prompt" | codex_consult.sh
#   codex_consult.sh --timeout 120 "prompt"
#   codex_consult.sh --model gpt-5-codex "prompt"
#
# Env overrides:
#   CODEX_BIN       — path to codex binary (default: auto-detected)
#   CODEX_TIMEOUT   — seconds before SIGTERM (default: 90)
#
# Exit codes:
#   0   success — final message on stdout
#   2   codex binary not found
#   3   auth not configured (~/.codex/auth.json missing)
#   4   timeout
#   5   codex returned non-zero
#   6   no output captured

set -euo pipefail

TIMEOUT="${CODEX_TIMEOUT:-90}"
MODEL=""
PROMPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --model)   MODEL="$2";   shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) PROMPT="$1"; shift ;;
  esac
done

# Read prompt from stdin if not provided as an argument
if [[ -z "$PROMPT" ]] && [[ ! -t 0 ]]; then
  PROMPT="$(cat)"
fi

if [[ -z "$PROMPT" ]]; then
  echo "codex-consult: no prompt provided (pass as arg or pipe to stdin)" >&2
  exit 1
fi

# Locate codex binary
CODEX="${CODEX_BIN:-}"
if [[ -z "$CODEX" ]]; then
  if command -v codex >/dev/null 2>&1; then
    CODEX="$(command -v codex)"
  elif [[ -x "/Applications/Codex.app/Contents/Resources/codex" ]]; then
    CODEX="/Applications/Codex.app/Contents/Resources/codex"
  else
    echo "codex-consult: codex binary not found (set CODEX_BIN or install Codex.app)" >&2
    exit 2
  fi
fi

# Auth precondition
if [[ ! -f "$HOME/.codex/auth.json" ]]; then
  echo "codex-consult: ~/.codex/auth.json missing — run '$CODEX login' first" >&2
  exit 3
fi

# Capture final message to a temp file (cleaner than parsing stdout JSONL)
LAST_MSG="$(mktemp -t codex_consult.XXXXXX)"
ERR_LOG="$(mktemp -t codex_consult_err.XXXXXX)"
trap 'rm -f "$LAST_MSG" "$ERR_LOG"' EXIT

# Build args
ARGS=(exec --skip-git-repo-check --ephemeral --color never -o "$LAST_MSG")
if [[ -n "$MODEL" ]]; then
  ARGS+=(--model "$MODEL")
fi
ARGS+=("$PROMPT")

# Invoke with timeout. macOS lacks GNU `timeout`; use perl as a portable shim.
set +e
perl -e '
  use strict; use warnings;
  my $t = shift @ARGV;
  my $pid = fork();
  if ($pid == 0) { exec(@ARGV); exit 127; }
  local $SIG{ALRM} = sub { kill "TERM", $pid; sleep 2; kill "KILL", $pid; exit 124; };
  alarm $t;
  waitpid $pid, 0;
  exit ($? >> 8);
' "$TIMEOUT" "$CODEX" "${ARGS[@]}" >/dev/null 2>"$ERR_LOG"
RC=$?
set -e

if [[ $RC -eq 124 ]]; then
  echo "codex-consult: timed out after ${TIMEOUT}s" >&2
  cat "$ERR_LOG" >&2 || true
  exit 4
fi

if [[ $RC -ne 0 ]]; then
  echo "codex-consult: codex exec failed (rc=$RC)" >&2
  cat "$ERR_LOG" >&2 || true
  exit 5
fi

if [[ ! -s "$LAST_MSG" ]]; then
  echo "codex-consult: codex returned no final message" >&2
  cat "$ERR_LOG" >&2 || true
  exit 6
fi

cat "$LAST_MSG"
