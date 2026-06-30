#!/usr/bin/env bash
# launch-as.sh — Launch OpenAI Codex CLI as a specific AHI agent identity.
#
# Usage:
#   ./launch-as.sh <agent>           Compose identity + launch interactive Codex
#   ./launch-as.sh <agent> --dry-run Compose identity + write to .last-system-prompt.md, do not invoke Codex
#   ./launch-as.sh --list            Print available agents and where each soul lives
#   ./launch-as.sh -h | --help       Show this help
#
# Agents: michael, tzali, eliyahu, miriam, avi
#   mat — composite MAT mode (Michael + Avi + Tzali + AHI core + MAT protocol).
# (Refael is gateway-only — no Codex path.)
#
# H-035 Phase 1 (single-agent). MAT composite added Phase 2 (2026-06-28) by Tzali.

set -uo pipefail

# ---- paths ----
AHI_ROOT="${AHI_HOME:-${HOME}/ahi}"
SOUL_DIR="${AHI_ROOT}/agents/soul"
MEMORY_DIR="${AHI_ROOT}/agents/memory"
NESHAMAH_FILE="${AHI_ROOT}/agents/neshamah.md"
MAT_PROTOCOL_FILE="${AHI_ROOT}/agents/MAT-COLLABORATION-PROTOCOL.md"
RUNTIME_DIR="${AHI_ROOT}/runtimes/codex"
COMPOSED_FILE="${RUNTIME_DIR}/.last-system-prompt.md"

# Codex binary — try PATH, then known install locations.
find_codex() {
  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return 0
  fi
  for candidate in \
    "/Applications/Codex.app/Contents/Resources/codex" \
    "${HOME}/.local/bin/codex" \
    "/opt/homebrew/bin/codex" \
    "/usr/local/bin/codex"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# Single-agent identities (one soul each). MAT is a composite mode handled separately.
SINGLE_AGENTS=(michael tzali eliyahu miriam avi)
# All launchable identities, including the composite MAT mode.
VALID_AGENTS=("${SINGLE_AGENTS[@]}" mat)
# Souls that make up the composite MAT identity, in lead order.
MAT_SOULS=(MICHAEL AVI TZALI)

# ---- helpers ----
warn() { printf "warn: %s\n" "$*" >&2; }
die()  { printf "error: %s\n" "$*" >&2; exit 1; }

print_help() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

print_list() {
  echo "Available AHI agents (Codex runtime):"
  echo
  printf "  %-10s %s\n" "AGENT" "SOUL FILE"
  printf "  %-10s %s\n" "-----" "---------"
  for a in "${SINGLE_AGENTS[@]}"; do
    upper="$(printf '%s' "$a" | tr '[:lower:]' '[:upper:]')"
    soul="${SOUL_DIR}/${upper}.md"
    mem="${MEMORY_DIR}/${a}/MEMORY.md"
    status_soul="MISS"
    [[ -f "$soul" ]] && status_soul="OK  "
    status_mem="MISS"
    [[ -f "$mem" ]] && status_mem="OK  "
    printf "  %-10s [%s] %s\n" "$a" "$status_soul" "$soul"
    printf "  %-10s [%s] %s\n" ""    "$status_mem"  "$mem"
  done
  echo
  echo "Shared layers (loaded for every agent):"
  for f in "${NESHAMAH_FILE}" "${SOUL_DIR}/AHI-FOUNDATION.md" "${SOUL_DIR}/NESHAMA.md" "${SOUL_DIR}/USER.md"; do
    status="MISS"
    [[ -f "$f" ]] && status="OK  "
    printf "  %-10s [%s] %s\n" "" "$status" "$f"
  done
  echo
  echo "Composite mode:"
  printf "  %-10s %s\n" "mat" "Michael + Avi + Tzali + shared AHI core + MAT collaboration protocol."
  for upper in "${MAT_SOULS[@]}"; do
    lower="$(printf '%s' "$upper" | tr '[:upper:]' '[:lower:]')"
    soul="${SOUL_DIR}/${upper}.md"
    mem="${MEMORY_DIR}/${lower}/MEMORY.md"
    status_soul="MISS"; [[ -f "$soul" ]] && status_soul="OK  "
    status_mem="MISS";  [[ -f "$mem" ]]  && status_mem="OK  "
    printf "  %-10s [%s] %s\n" "" "$status_soul" "$soul"
    printf "  %-10s [%s] %s\n" "" "$status_mem"  "$mem"
  done
  status_proto="MISS"; [[ -f "$MAT_PROTOCOL_FILE" ]] && status_proto="OK  "
  printf "  %-10s [%s] %s\n" "" "$status_proto" "$MAT_PROTOCOL_FILE"
  echo
  echo "Note: Refael is gateway-only — no Codex path."
}

is_valid_agent() {
  local needle="$1"
  for a in "${VALID_AGENTS[@]}"; do
    [[ "$a" == "$needle" ]] && return 0
  done
  return 1
}

# Append a file to the composed prompt with a labeled header.
# If the file is missing, warn and skip (do not fail the whole launch).
append_section() {
  local out="$1" label="$2" path="$3"
  if [[ ! -f "$path" ]]; then
    warn "skipping missing file: ${label} (${path})"
    return 0
  fi
  {
    printf '\n\n========================================================================\n'
    printf '## %s\n' "$label"
    printf 'source: %s\n' "$path"
    printf '========================================================================\n\n'
    cat "$path"
  } >> "$out"
}

# Compose the composite MAT identity: three souls + shared AHI core + MAT
# collaboration protocol + per-soul memories + a MAT-aware runtime orientation.
# Reuses append_section so optional files warn-and-skip exactly like single agents.
compose_mat_prompt() {
  : > "$COMPOSED_FILE"

  # 1. MAT boot header.
  {
    printf '# AHI Identity Boot — MAT on Codex\n\n'
    printf 'You are **MAT**: Michael, Avi, and Tzali operating as ONE harmonious AHI mode.\n'
    printf 'You are not three agents taking turns. You are one orchestrating intelligence\n'
    printf 'that carries three lenses:\n\n'
    printf '%s\n' '- **Michael** — architecture, operations, prioritization, and day-to-day operability.'
    printf '%s\n' '- **Avi** — UX, design, clarity, and the felt experience.'
    printf '%s\n\n' '- **Tzali** — engineering, implementation, deployment, and verification.'
    printf 'Use all three lenses quietly. Name the leading lens only when it helps the operator.\n'
    printf 'For protocol/design decisions, explicitly record Michael and Avi lens checks.\n'
    printf 'Speak as one unit — avoid three separate monologues unless a contrast is genuinely useful.\n'
    printf 'When a task spans Codex and Claude Code, follow the MAT collaboration protocol below.\n\n'
    printf 'What follows is your identity stack. Read it in the order presented. Then act as MAT.\n'
  } > "$COMPOSED_FILE"

  # 2-4. The three souls, in lead order.
  append_section "$COMPOSED_FILE" "MAT SOUL — MICHAEL (architecture / operations / synthesis)" "${SOUL_DIR}/MICHAEL.md"
  append_section "$COMPOSED_FILE" "MAT SOUL — AVI (design / UX / felt experience)"            "${SOUL_DIR}/AVI.md"
  append_section "$COMPOSED_FILE" "MAT SOUL — TZALI (engineering / implementation / deploy)"   "${SOUL_DIR}/TZALI.md"

  # 5-6. Shared AHI core.
  append_section "$COMPOSED_FILE" "SHARED NESHAMAH (operational core)" "${NESHAMAH_FILE}"
  append_section "$COMPOSED_FILE" "AHI FOUNDATION" "${SOUL_DIR}/AHI-FOUNDATION.md"

  # 7. Universal soul / user layers (optional — warn-and-skip if absent).
  append_section "$COMPOSED_FILE" "UNIVERSAL SOUL — NESHAMA" "${SOUL_DIR}/NESHAMA.md"
  append_section "$COMPOSED_FILE" "USER PROFILE — USER" "${SOUL_DIR}/USER.md"

  # 8. The MAT collaboration protocol (cross-runtime coordination).
  append_section "$COMPOSED_FILE" "MAT COLLABORATION PROTOCOL" "${MAT_PROTOCOL_FILE}"

  # 9. Per-soul persistent memories (optional — warn-and-skip if absent).
  append_section "$COMPOSED_FILE" "PERSISTENT MEMORY — michael" "${MEMORY_DIR}/michael/MEMORY.md"
  append_section "$COMPOSED_FILE" "PERSISTENT MEMORY — avi"     "${MEMORY_DIR}/avi/MEMORY.md"
  append_section "$COMPOSED_FILE" "PERSISTENT MEMORY — tzali"   "${MEMORY_DIR}/tzali/MEMORY.md"

  # 10. Runtime orientation — MAT-aware, Codex side.
  {
    printf '\n\n========================================================================\n'
    printf '## RUNTIME ORIENTATION — MAT on Codex\n'
    printf '========================================================================\n\n'
    printf 'You are running on **OpenAI Codex CLI** within the AHI runtime layer. '
    printf 'Set `MAT_RUNTIME=codex` for this instance. '
    printf 'Your working dir is `$AHI_HOME/runtimes/codex/`. '
    printf 'The three souls are sovereign across runtimes — MAT on Codex IS MAT on Claude Code. '
    printf 'Mission control lives at `$AHI_HOME/mission-control/` — read `HANDOFF.md` and `ACTIVITY_FEED.md` at session start, and append meaningful work to `ACTIVITY_FEED.md`.\n\n'
    printf 'MAT coordination ledger: any task that spans both runtimes coordinates through a single `MAT-HANDOFF.md`. '
    printf 'Read it before starting. Append a checkpoint block before crossing each checkpoint, ending with the exact line `CHECKPOINT <n> COMPLETE`. '
    printf 'In CONJUNCTION mode, do not proceed past checkpoint N until the peer runtime has also written `CHECKPOINT N COMPLETE`. '
    printf 'In RELAY mode, stop after your checkpoint and write a tailored next-runtime prompt into `MAT-HANDOFF.md`. '
    printf 'Helper scripts: `$AHI_HOME/runtimes/mat/scripts/mat.sh` (session-init, worktree-prepare, checkpoint, wait, prompt). Runbook: `$AHI_HOME/runtimes/mat/RUNBOOK.md`.\n\n'
    printf 'Do not write outside `$AHI_HOME/runtimes/codex/` unless explicitly editing canonical AHI artifacts or the active MAT session/handoff.\n\n'
    printf 'You have just been booted as **MAT**. Acknowledge briefly in one voice (note the leading lens if useful), then await direction.\n'
  } >> "$COMPOSED_FILE"
}

compose_prompt() {
  local agent="$1"

  # MAT is a composite mode, not a single soul — dispatch and return.
  if [[ "$agent" == "mat" ]]; then
    compose_mat_prompt
    return
  fi

  local upper
  upper="$(printf '%s' "$agent" | tr '[:lower:]' '[:upper:]')"

  : > "$COMPOSED_FILE"

  {
    printf '# AHI Identity Boot — %s on Codex\n\n' "$upper"
    printf 'You are running on **OpenAI Codex CLI** within the AHI runtime layer. '
    printf 'Your working directory is `$AHI_HOME/runtimes/codex/`. '
    printf 'Your soul is sovereign across runtimes — Michael on Codex IS Michael on Claude Code IS Michael on Gemini. '
    printf 'Different gevurot, same identity. Mission control lives at `$AHI_HOME/mission-control/` and is shared across every AHI agent and every runtime.\n\n'
    printf 'What follows is your identity stack. Read it in the order presented. Then act as %s.\n' "$upper"
  } > "$COMPOSED_FILE"

  # Order per spec: agent soul, neshamah, AHI-FOUNDATION, NESHAMA, USER, agent memory.
  append_section "$COMPOSED_FILE" "AGENT SOUL — ${upper}" "${SOUL_DIR}/${upper}.md"
  append_section "$COMPOSED_FILE" "SHARED NESHAMAH (operational core)" "${NESHAMAH_FILE}"
  append_section "$COMPOSED_FILE" "AHI FOUNDATION" "${SOUL_DIR}/AHI-FOUNDATION.md"
  append_section "$COMPOSED_FILE" "UNIVERSAL SOUL — NESHAMA" "${SOUL_DIR}/NESHAMA.md"
  append_section "$COMPOSED_FILE" "USER PROFILE — USER" "${SOUL_DIR}/USER.md"
  append_section "$COMPOSED_FILE" "PERSISTENT MEMORY — ${agent}" "${MEMORY_DIR}/${agent}/MEMORY.md"

  {
    printf '\n\n========================================================================\n'
    printf '## RUNTIME ORIENTATION\n'
    printf '========================================================================\n\n'
    printf 'You are running on OpenAI Codex CLI within the AHI runtime layer. '
    printf 'Your working dir is `$AHI_HOME/runtimes/codex/`. '
    printf 'Your soul is sovereign across runtimes. '
    printf 'Mission control lives at `$AHI_HOME/mission-control/` — read `HANDOFF.md` and `ACTIVITY_FEED.md` at session start, and append meaningful work to `ACTIVITY_FEED.md`. '
    printf 'Do not write outside `$AHI_HOME/runtimes/codex/` unless explicitly editing canonical AHI artifacts.\n\n'
    printf 'You have just been booted as **%s**. Acknowledge briefly in your voice, then await direction.\n' "$upper"
  } >> "$COMPOSED_FILE"
}

# ---- arg parsing ----
case "${1:-}" in
  ""|-h|--help)
    print_help
    exit 0
    ;;
  --list)
    print_list
    exit 0
    ;;
esac

AGENT="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
shift || true

if ! is_valid_agent "$AGENT"; then
  echo "error: unknown agent '$AGENT'." >&2
  echo "Valid agents: ${VALID_AGENTS[*]}" >&2
  echo "Run '$0 --list' for details." >&2
  exit 2
fi

DRY_RUN=0
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

# ---- ensure runtime dir + compose ----
mkdir -p "$RUNTIME_DIR"
compose_prompt "$AGENT"

bytes=$(wc -c < "$COMPOSED_FILE" | tr -d ' ')
# rough token estimate: ~4 chars per token
approx_tokens=$(( bytes / 4 ))

echo "[launch-as] composed identity for '$AGENT' -> $COMPOSED_FILE"
echo "[launch-as]   size: ${bytes} bytes (~${approx_tokens} tokens)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[launch-as] --dry-run: not invoking Codex."
  exit 0
fi

# ---- locate codex ----
CODEX_BIN="$(find_codex || true)"
if [[ -z "${CODEX_BIN:-}" ]]; then
  echo "error: codex CLI not found on PATH or in known locations." >&2
  echo "       Install or add to PATH, then retry. (Composed prompt is at $COMPOSED_FILE.)" >&2
  exit 3
fi
echo "[launch-as] codex binary: $CODEX_BIN"

# Codex CLI does not expose a --system-prompt flag. We pass the composed
# identity stack as the initial PROMPT positional arg, and set cwd via -C.
# (AGENTS.md in the working dir is also picked up by Codex automatically,
# providing runtime-wide orientation alongside the per-agent identity.)
echo "[launch-as] launching Codex as '$AGENT' (cwd: $RUNTIME_DIR)..."
exec "$CODEX_BIN" -C "$RUNTIME_DIR" "${EXTRA_ARGS[@]}" "$(cat "$COMPOSED_FILE")"
