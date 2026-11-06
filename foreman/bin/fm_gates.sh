#!/usr/bin/env bash
# Gate helpers for the foreman shell tooling. Sourced by build_start.sh and
# build_say.sh.
#
# ── ADDITIVE AND REVERSIBLE ────────────────────────────────────────────────
# Every function here degrades to the pre-gate behaviour when this file, or
# ACTIVE-GATES.md, is absent. The callers source it as:
#
#     [ -f "$FOREMAN_ROOT/bin/fm_gates.sh" ] && source "$FOREMAN_ROOT/bin/fm_gates.sh"
#
# so if the file is deleted the launcher runs exactly as it did before, with no
# error and no missing function call. Prove that by exercise, not assertion:
# remove each gate artefact in turn and re-run a full launch.
# `set -euo pipefail` is in force in the callers, so nothing here may return
# non-zero on a path the caller does not explicitly handle.

# Callers normally source lib.sh first; same defaults here so a bare source works.
AHI_HOME="${FM_AHI_HOME:-${AHI_HOME:-$HOME/ahi}}"
FOREMAN_ROOT="${FOREMAN_ROOT:-$AHI_HOME/foreman}"
FM_GATES_PY="${FM_GATES_PY:-$(dirname "${BASH_SOURCE[0]}")/fm_gates.py}"

# fm_gates_available → 0 if a usable gate source exists, 1 otherwise.
fm_gates_available() {
  [ -f "$FM_GATES_PY" ] || return 1
  [ -f "${FM_GATES_FILE:-$FOREMAN_ROOT/ACTIVE-GATES.md}" ] || return 1
  return 0
}

# fm_gates_check → prints the reconcile report; 0 = QUEUE.md and ACTIVE-GATES.md
# agree. This is what makes the two sources unable to disagree SILENTLY.
fm_gates_check() {
  python3 "$FM_GATES_PY" check 2>&1
}

# fm_gates_render [claude|codex|subagent|launch] → the verbatim block.
# The argument is the AUDIENCE, not a format: a codex builder is told its rails
# are advisory because in that runtime they are. See render() in fm_gates.py.
fm_gates_render() {
  python3 "$FM_GATES_PY" render --for "${1:-launch}" 2>/dev/null
}

# fm_gates_count → how many gates are in the active set. Goes in the ledger so
# "which gates governed this build" is answerable from the record rather than by
# re-deriving it from a file that has since moved on.
fm_gates_count() {
  python3 "$FM_GATES_PY" list 2>/dev/null | grep -c . || true
}

# fm_gates_verify <file> — does this prompt actually CARRY every gate?
# 0 = yes. Non-zero prints the missing keys by name. Normalised comparison:
# re-wrapping passes, paraphrasing fails. This is the check that must never
# become a grep.
fm_gates_verify() {
  python3 "$FM_GATES_PY" verify-prompt "$1" 2>&1
}

fm_gates_digest() {
  python3 "$FM_GATES_PY" digest 2>/dev/null
}

# ── THE CHOKEPOINT STAMP ───────────────────────────────────────────────────
# fm_gates_stamp <tmux-target> <msg> → the message, with the gates prepended if
# and only if this session's gate set has CHANGED since it launched.
#
# WHY THIS IS HERE AND NOT IN build_say.sh. Patching each caller is a caller
# list, and a caller list always misses one (a sandbox that neutralised three
# wake scripts and missed the fourth woke the supervisor with a false order).
# Neutralise and inject at the chokepoint instead. `fm_send_submit` is the
# chokepoint for prose entering a build session — build_start.sh calls it for
# both runtime lanes, build_say.sh calls it for every steer, and any future
# caller gets this for free instead of needing to remember.
#
# WHAT IT SOLVES BEYOND TIDINESS: gates written AFTER a build launched never
# reached that build. The launch-time block is a snapshot; a ruling made an hour
# into a six-hour session lands in QUEUE.md and stops there. That is the same
# hole in the time dimension, and it is not hypothetical — rulings are routinely
# made while the build subject to them is already running.
#
# It stays QUIET when nothing changed: a steer that would be identical is
# returned byte-for-byte unchanged, so the normal supervision channel does not
# grow a 15KB preamble on every message. Proven by paired case in tests.
fm_gates_stamp() {
  local target="$1" msg="$2" bid wd launched now
  bid="${target#fm-}"
  [ "$bid" = "$target" ] && { printf '%s' "$msg"; return 0; }   # not a build session
  wd="$(fm_meta "$bid" workdir 2>/dev/null)" || { printf '%s' "$msg"; return 0; }
  [ -n "$wd" ] && [ -f "$wd/.foreman/ACTIVE-GATES.md" ] || { printf '%s' "$msg"; return 0; }

  launched="$(FM_GATES_FILE="$wd/.foreman/ACTIVE-GATES.md" fm_gates_digest)"
  now="$(fm_gates_digest)"
  [ -z "$now" ] || [ "$launched" = "$now" ] && { printf '%s' "$msg"; return 0; }

  # The set moved under a running build. Refresh the workspace copy the guard
  # reads — otherwise enforcement stays pinned to the launch snapshot while the
  # agent is being told about new rulings — then carry the new set in the message.
  cp "${FM_GATES_FILE:-$FOREMAN_ROOT/ACTIVE-GATES.md}" "$wd/.foreman/ACTIVE-GATES.md" 2>/dev/null || true
  printf '%s\n\n%s' \
    "⚠ THE ACTIVE GATES CHANGED WHILE YOU WERE RUNNING (gate-set $launched → $now).
You launched under the older set. These are the gates in force NOW; they bind
this session and every subagent it spawns from this moment, and they supersede
the block you received at launch.

$(fm_gates_render)" "$msg"
}

# fm_gates_install <workdir> — write the workspace copy the PreToolUse guard
# reads. THE POINT OF THE COPY: the guard must not have to reach across the
# filesystem to a file that may have changed or vanished since launch. The
# gates that govern a build sit beside that build, written once by the launch
# that already refused to start without them. Same shape as the rule for
# runbooks — a runbook that does not carry its rulings is not executable; the
# control travels with the thing it governs.
fm_gates_install() {
  local workdir="$1"
  mkdir -p "$workdir/.foreman" || return 1
  cp "${FM_GATES_FILE:-$FOREMAN_ROOT/ACTIVE-GATES.md}" "$workdir/.foreman/ACTIVE-GATES.md" || return 1
  fm_gates_render subagent > "$workdir/.foreman/GATES-FOR-SUBAGENTS.txt" 2>/dev/null || true
  return 0
}
