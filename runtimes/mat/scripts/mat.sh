#!/usr/bin/env bash
# mat.sh — MAT coordination helpers (session, worktrees, handoff ledger, prompt).
#
# MAT = Michael + Avi + Zali operating as one mode across Codex and Claude Code.
# This script implements the mechanical side of the MAT collaboration protocol:
#   $AHI_HOME/agents/MAT-COLLABORATION-PROTOCOL.md
# The protocol (what the agent must do) matters more than the script (what it
# automates). These helpers never let a runtime skip the sync/wait rule for it.
#
# Usage:
#   mat.sh session-init     --task-slug S [--project-root P] [--mode relay|conjunction]
#                           [--runtimes codex,claude-code] [--checkpoints L] [--task T]
#                           [--handoff PATH] [--force]
#   mat.sh worktree-prepare --runtime codex|claude-code --task-slug S [--project-root P]
#   mat.sh checkpoint       --checkpoint N --name NAME --runtime R --mode M
#                           (--task-slug S | --handoff PATH) [field flags...]
#   mat.sh wait             --checkpoint N --expect codex,claude-code
#                           (--task-slug S | --handoff PATH) [--poll] [--interval SEC] [--timeout SEC]
#   mat.sh prompt           --mode M (--task T | --task-file F) [--task-slug S]
#                           [--project-root P] [--checkpoints L] [--handoff PATH]
#   mat.sh --list | help | -h
#
# MAT Phase 2. Created 2026-06-28 by Zali (Claude Code).

set -uo pipefail

# ---- canonical paths ----
AHI_ROOT="${HOME}/ai"
WORKSPACES="${AHI_ROOT}/workspaces/mat"
GLOBAL_HANDOFF="${AHI_ROOT}/MAT-HANDOFF.md"
TEMPLATE="${AHI_ROOT}/runtimes/mat/templates/prompt-for-MAT.md"
PROTOCOL="${AHI_ROOT}/agents/MAT-COLLABORATION-PROTOCOL.md"
RUNTIME_BASE="${AHI_ROOT}/runtimes"
VALID_RUNTIMES=(codex claude-code)

# ---- small helpers ----
warn() { printf "warn: %s\n" "$*" >&2; }
die()  { printf "error: %s\n" "$*" >&2; exit 1; }
now_utc() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Normalize a runtime label to lowercase, spaces -> hyphens (so "Claude Code" == "claude-code").
norm_runtime() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr ' ' '-'; }

is_valid_runtime() {
  local needle; needle="$(norm_runtime "$1")"
  local r
  for r in "${VALID_RUNTIMES[@]}"; do [[ "$r" == "$needle" ]] && return 0; done
  return 1
}

# Echo the git toplevel for a path, or empty string if not a git repo.
git_toplevel() { git -C "$1" rev-parse --show-toplevel 2>/dev/null || true; }

session_dir_for() { printf '%s/%s' "$WORKSPACES" "$1"; }

# Resolve the handoff ledger path for a slug/project-root:
#   git-backed project -> <session-dir>/MAT-HANDOFF.md
#   non-git AHI task    -> the global $AHI_HOME/MAT-HANDOFF.md
resolve_handoff() {
  local slug="$1" project_root="$2"
  local repo; repo="$(git_toplevel "$project_root")"
  if [[ -n "$repo" ]]; then
    printf '%s/MAT-HANDOFF.md' "$(session_dir_for "$slug")"
  else
    printf '%s' "$GLOBAL_HANDOFF"
  fi
}

# Expand --key=value into "--key" "value" so both arg forms work everywhere.
normalize_args() {
  NORMALIZED=()
  local a
  for a in "$@"; do
    case "$a" in
      --*=*) NORMALIZED+=("${a%%=*}" "${a#*=}") ;;
      *)     NORMALIZED+=("$a") ;;
    esac
  done
}

# ---- subcommand: session-init ----
cmd_session_init() {
  local TASK_SLUG="" PROJECT_ROOT="$AHI_ROOT" MODE="relay" RUNTIMES="codex,claude-code"
  local CHECKPOINTS="1" TASK="" HANDOFF="" FORCE=0
  normalize_args "$@"; set -- "${NORMALIZED[@]:-}"
  while [[ $# -gt 0 ]]; do
    case "${1:-}" in
      --task-slug)    TASK_SLUG="${2:-}"; shift 2 ;;
      --project-root) PROJECT_ROOT="${2:-}"; shift 2 ;;
      --mode)         MODE="${2:-}"; shift 2 ;;
      --runtimes)     RUNTIMES="${2:-}"; shift 2 ;;
      --checkpoints)  CHECKPOINTS="${2:-}"; shift 2 ;;
      --task)         TASK="${2:-}"; shift 2 ;;
      --handoff)      HANDOFF="${2:-}"; shift 2 ;;
      --force)        FORCE=1; shift ;;
      "")             shift ;;
      *)              die "session-init: unknown arg '$1'" ;;
    esac
  done
  [[ -n "$TASK_SLUG" ]] || die "session-init: --task-slug is required"
  case "$MODE" in relay|conjunction) ;; *) die "session-init: --mode must be relay or conjunction" ;; esac

  local SESSION_DIR; SESSION_DIR="$(session_dir_for "$TASK_SLUG")"
  mkdir -p "$SESSION_DIR" || die "session-init: cannot create $SESSION_DIR"

  local REPO; REPO="$(git_toplevel "$PROJECT_ROOT")"
  [[ -z "$HANDOFF" ]] && HANDOFF="$(resolve_handoff "$TASK_SLUG" "$PROJECT_ROOT")"

  local git_status branches
  if [[ -n "$REPO" ]]; then
    git_status="git repo (root: $REPO)"
    branches="mat/$TASK_SLUG/codex , mat/$TASK_SLUG/claude-code"
  else
    git_status="non-git (worktrees disabled; coordinate via global ledger)"
    branches="(none — non-git project)"
  fi

  # Write the header only for a fresh/empty ledger, unless --force. Never clobber
  # an existing append-only ledger (it may hold peer checkpoints).
  if [[ -s "$HANDOFF" && "$FORCE" -ne 1 ]]; then
    warn "ledger already exists and is non-empty: $HANDOFF"
    warn "leaving it intact (append-only). Use --force to rewrite the header."
  else
    mkdir -p "$(dirname "$HANDOFF")"
    {
      printf '# MAT-HANDOFF\n\n'
      printf -- '- Task: %s\n' "${TASK:-$TASK_SLUG}"
      printf -- '- Task slug: %s\n' "$TASK_SLUG"
      printf -- '- Mode: %s\n' "$MODE"
      printf -- '- Project root: %s\n' "$PROJECT_ROOT"
      printf -- '- Repo: %s\n' "$git_status"
      printf -- '- Session dir: %s\n' "$SESSION_DIR"
      printf -- '- Handoff path: %s\n' "$HANDOFF"
      printf -- '- Expected runtimes: %s\n' "$RUNTIMES"
      printf -- '- Recommended branches: %s\n' "$branches"
      printf -- '- Checkpoints: %s\n' "$CHECKPOINTS"
      printf -- '- Initialized UTC: %s\n' "$(now_utc)"
      printf '\n'
    } > "$HANDOFF" || die "session-init: cannot write $HANDOFF"
    echo "[mat] wrote ledger header -> $HANDOFF"
  fi

  echo "[mat] session ready"
  echo "  task slug:    $TASK_SLUG"
  echo "  mode:         $MODE"
  echo "  project root: $PROJECT_ROOT"
  echo "  git:          $git_status"
  echo "  session dir:  $SESSION_DIR"
  echo "  handoff:      $HANDOFF"
  echo "  runtimes:     $RUNTIMES"
  if [[ -n "$REPO" ]]; then
    echo "  next: mat.sh worktree-prepare --runtime codex --task-slug $TASK_SLUG"
    echo "        mat.sh worktree-prepare --runtime claude-code --task-slug $TASK_SLUG"
  else
    echo "  next: non-git project — skip worktree-prepare; coordinate via $HANDOFF"
  fi
}

# ---- subcommand: worktree-prepare ----
cmd_worktree_prepare() {
  local RUNTIME="" TASK_SLUG="" PROJECT_ROOT="$AHI_ROOT"
  normalize_args "$@"; set -- "${NORMALIZED[@]:-}"
  while [[ $# -gt 0 ]]; do
    case "${1:-}" in
      --runtime)      RUNTIME="${2:-}"; shift 2 ;;
      --task-slug)    TASK_SLUG="${2:-}"; shift 2 ;;
      --project-root) PROJECT_ROOT="${2:-}"; shift 2 ;;
      "")             shift ;;
      *)              die "worktree-prepare: unknown arg '$1'" ;;
    esac
  done
  [[ -n "$RUNTIME" ]] || die "worktree-prepare: --runtime is required (codex|claude-code)"
  [[ -n "$TASK_SLUG" ]] || die "worktree-prepare: --task-slug is required"
  is_valid_runtime "$RUNTIME" || die "worktree-prepare: --runtime must be one of: ${VALID_RUNTIMES[*]}"
  RUNTIME="$(norm_runtime "$RUNTIME")"

  local SESSION_DIR; SESSION_DIR="$(session_dir_for "$TASK_SLUG")"
  local REPO; REPO="$(git_toplevel "$PROJECT_ROOT")"

  if [[ -z "$REPO" ]]; then
    # Non-git fallback: NO git worktree. Use a runtime scratch dir + global ledger.
    local SCRATCH="${RUNTIME_BASE}/${RUNTIME}/mat-scratch/${TASK_SLUG}"
    mkdir -p "$SCRATCH"
    echo "[mat] non-git project at: $PROJECT_ROOT"
    echo "[mat] worktrees skipped (not a git repo)."
    echo "  runtime scratch: $SCRATCH"
    echo "  coordinate via:  $GLOBAL_HANDOFF"
    echo "  work in place under $PROJECT_ROOT for canonical AHI artifacts."
    return 0
  fi

  mkdir -p "$SESSION_DIR"
  local WT="${SESSION_DIR}/${RUNTIME}"
  local BRANCH="mat/${TASK_SLUG}/${RUNTIME}"
  local LEDGER="${SESSION_DIR}/MAT-HANDOFF.md"

  if [[ -e "$WT" ]]; then
    warn "worktree already exists: $WT (skipping git worktree add)"
  else
    if git -C "$REPO" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
      warn "branch $BRANCH already exists; attaching worktree without creating it"
      git -C "$REPO" worktree add "$WT" "$BRANCH" \
        || die "worktree-prepare: 'git worktree add' failed for existing branch"
    else
      git -C "$REPO" worktree add -b "$BRANCH" "$WT" HEAD \
        || die "worktree-prepare: 'git worktree add -b' failed"
    fi
  fi

  # Expose the single shared ledger at the worktree root as MAT-HANDOFF.md.
  if [[ ! -e "$LEDGER" ]]; then
    warn "session ledger missing: $LEDGER (run 'mat.sh session-init' first)"
  fi
  if [[ -L "${WT}/MAT-HANDOFF.md" || -e "${WT}/MAT-HANDOFF.md" ]]; then
    warn "${WT}/MAT-HANDOFF.md already present; leaving as-is"
  else
    ln -s "$LEDGER" "${WT}/MAT-HANDOFF.md" \
      && echo "[mat] linked ledger: ${WT}/MAT-HANDOFF.md -> $LEDGER" \
      || warn "could not symlink ledger into worktree"
  fi

  echo "[mat] worktree ready"
  echo "  runtime:  $RUNTIME"
  echo "  branch:   $BRANCH"
  echo "  worktree: $WT"
  echo "  ledger:   $LEDGER"
}

# ---- subcommand: checkpoint ----
cmd_checkpoint() {
  local N="" NAME="" RUNTIME="" MODE="" HANDOFF="" TASK_SLUG="" PROJECT_ROOT="$AHI_ROOT"
  local BRANCH="-" WORKTREE="-" COMPLETED="-" FILES="-" VERIFICATION="-" BLOCKERS="-"
  local NEXT_ACTION="-" NEXT_PROMPT="" NEXT_PROMPT_FILE="" SUMMARY_FILE="" PEER_WAIT="-"
  normalize_args "$@"; set -- "${NORMALIZED[@]:-}"
  while [[ $# -gt 0 ]]; do
    case "${1:-}" in
      --checkpoint)       N="${2:-}"; shift 2 ;;
      --name)             NAME="${2:-}"; shift 2 ;;
      --runtime)          RUNTIME="${2:-}"; shift 2 ;;
      --mode)             MODE="${2:-}"; shift 2 ;;
      --handoff)          HANDOFF="${2:-}"; shift 2 ;;
      --task-slug)        TASK_SLUG="${2:-}"; shift 2 ;;
      --project-root)     PROJECT_ROOT="${2:-}"; shift 2 ;;
      --branch)           BRANCH="${2:-}"; shift 2 ;;
      --worktree)         WORKTREE="${2:-}"; shift 2 ;;
      --completed)        COMPLETED="${2:-}"; shift 2 ;;
      --files)            FILES="${2:-}"; shift 2 ;;
      --verification)     VERIFICATION="${2:-}"; shift 2 ;;
      --blockers)         BLOCKERS="${2:-}"; shift 2 ;;
      --next-action)      NEXT_ACTION="${2:-}"; shift 2 ;;
      --next-prompt)      NEXT_PROMPT="${2:-}"; shift 2 ;;
      --next-prompt-file) NEXT_PROMPT_FILE="${2:-}"; shift 2 ;;
      --summary-file)     SUMMARY_FILE="${2:-}"; shift 2 ;;
      --peer-wait)        PEER_WAIT="${2:-}"; shift 2 ;;
      "")                 shift ;;
      *)                  die "checkpoint: unknown arg '$1'" ;;
    esac
  done
  [[ -n "$N" ]] || die "checkpoint: --checkpoint N is required"
  [[ -n "$RUNTIME" ]] || die "checkpoint: --runtime is required"
  [[ -n "$NAME" ]] || NAME="checkpoint-$N"
  [[ -n "$MODE" ]] || MODE="-"
  if [[ -z "$HANDOFF" ]]; then
    [[ -n "$TASK_SLUG" ]] || die "checkpoint: pass --handoff PATH or --task-slug S"
    HANDOFF="$(resolve_handoff "$TASK_SLUG" "$PROJECT_ROOT")"
  fi
  [[ -f "$HANDOFF" ]] || { mkdir -p "$(dirname "$HANDOFF")"; : > "$HANDOFF"; warn "ledger did not exist; created $HANDOFF"; }
  RUNTIME="$(norm_runtime "$RUNTIME")"

  # Resolve next-prompt body (file wins over inline).
  local next_block=""
  if [[ -n "$NEXT_PROMPT_FILE" ]]; then
    [[ -f "$NEXT_PROMPT_FILE" ]] || die "checkpoint: --next-prompt-file not found: $NEXT_PROMPT_FILE"
    next_block="$(cat "$NEXT_PROMPT_FILE")"
  elif [[ -n "$NEXT_PROMPT" ]]; then
    next_block="$NEXT_PROMPT"
  fi

  {
    printf '\n## CHECKPOINT %s — %s\n\n' "$N" "$NAME"
    printf -- '- Runtime: %s\n' "$RUNTIME"
    printf -- '- Mode: %s\n' "$MODE"
    printf -- '- Timestamp UTC: %s\n' "$(now_utc)"
    printf -- '- Branch: %s\n' "$BRANCH"
    printf -- '- Worktree: %s\n' "$WORKTREE"
    printf -- '- Completed: %s\n' "$COMPLETED"
    printf -- '- Files changed: %s\n' "$FILES"
    printf -- '- Verification: %s\n' "$VERIFICATION"
    printf -- '- Blockers: %s\n' "$BLOCKERS"
    printf -- '- Peer wait status: %s\n' "$PEER_WAIT"
    printf -- '- Next action: %s\n' "$NEXT_ACTION"
    if [[ -n "$SUMMARY_FILE" && -f "$SUMMARY_FILE" ]]; then
      printf '\n### Notes\n\n'
      cat "$SUMMARY_FILE"
      printf '\n'
    fi
    if [[ -n "$next_block" ]]; then
      printf '\n### Next prompt\n\n'
      printf '```text\n'
      printf '%s\n' "$next_block"
      printf '```\n'
    fi
    printf '\nCHECKPOINT %s COMPLETE\n' "$N"
  } >> "$HANDOFF" || die "checkpoint: cannot append to $HANDOFF"

  echo "[mat] appended CHECKPOINT $N ($RUNTIME) -> $HANDOFF"
}

# Return 0 if runtime $3 has a COMPLETE block for checkpoint $2 in ledger $1.
runtime_completed() {
  local handoff="$1" n="$2" rt; rt="$(norm_runtime "$3")"
  [[ -f "$handoff" ]] || return 1
  awk -v n="$n" -v rt="$rt" '
    function lc(s){ return tolower(s) }
    /^##[ \t]+CHECKPOINT[ \t]+/ {
      curnum=$3; gsub(/[^0-9]/,"",curnum); currt=""; next
    }
    /^##[ \t]/ { curnum=""; currt=""; next }
    /^[-*][ \t]+[Rr]untime[ \t]*:/ {
      line=$0; sub(/^[-*][ \t]+[Rr]untime[ \t]*:[ \t]*/,"",line);
      currt=lc(line); gsub(/^[ \t]+/,"",currt); gsub(/[ \t]+$/,"",currt); gsub(/ /,"-",currt); next
    }
    /CHECKPOINT[ \t]+[0-9]+[ \t]+COMPLETE/ {
      cn=$0; sub(/.*CHECKPOINT[ \t]+/,"",cn); sub(/[ \t]+COMPLETE.*/,"",cn); gsub(/[^0-9]/,"",cn);
      if (cn==n && curnum==n && currt==rt) found=1
    }
    END { exit (found?0:1) }
  ' "$handoff"
}

# ---- subcommand: wait ----
cmd_wait() {
  local N="" EXPECT="codex,claude-code" HANDOFF="" TASK_SLUG="" PROJECT_ROOT="$AHI_ROOT"
  local POLL=0 INTERVAL=15 TIMEOUT=0
  normalize_args "$@"; set -- "${NORMALIZED[@]:-}"
  while [[ $# -gt 0 ]]; do
    case "${1:-}" in
      --checkpoint)   N="${2:-}"; shift 2 ;;
      --expect)       EXPECT="${2:-}"; shift 2 ;;
      --handoff)      HANDOFF="${2:-}"; shift 2 ;;
      --task-slug)    TASK_SLUG="${2:-}"; shift 2 ;;
      --project-root) PROJECT_ROOT="${2:-}"; shift 2 ;;
      --poll)         POLL=1; shift ;;
      --interval)     INTERVAL="${2:-}"; shift 2 ;;
      --timeout)      TIMEOUT="${2:-}"; shift 2 ;;
      "")             shift ;;
      *)              die "wait: unknown arg '$1'" ;;
    esac
  done
  [[ -n "$N" ]] || die "wait: --checkpoint N is required"
  if [[ -z "$HANDOFF" ]]; then
    [[ -n "$TASK_SLUG" ]] || die "wait: pass --handoff PATH or --task-slug S"
    HANDOFF="$(resolve_handoff "$TASK_SLUG" "$PROJECT_ROOT")"
  fi

  IFS=',' read -r -a expect_arr <<< "$EXPECT"

  check_once() {
    local missing=() r
    for r in "${expect_arr[@]}"; do
      r="$(printf '%s' "$r" | tr -d ' ')"
      [[ -z "$r" ]] && continue
      if ! runtime_completed "$HANDOFF" "$N" "$r"; then
        missing+=("$r")
      fi
    done
    MISSING=("${missing[@]:-}")
    [[ "${#missing[@]}" -eq 0 ]]
  }

  local elapsed=0
  while true; do
    if check_once; then
      echo "[mat] checkpoint $N COMPLETE for all expected runtimes: $EXPECT"
      return 0
    fi
    local miss_str; miss_str="$(printf '%s ' "${MISSING[@]}")"
    echo "[mat] waiting on checkpoint $N — missing: ${miss_str% } (ledger: $HANDOFF)"
    if [[ "$POLL" -ne 1 ]]; then
      return 1
    fi
    if [[ "$TIMEOUT" -gt 0 && "$elapsed" -ge "$TIMEOUT" ]]; then
      warn "wait: timed out after ${TIMEOUT}s — still missing: ${miss_str% }"
      return 2
    fi
    sleep "$INTERVAL"
    elapsed=$(( elapsed + INTERVAL ))
  done
}

# ---- subcommand: prompt ----
cmd_prompt() {
  local TASK="" TASK_FILE="" MODE="" PROJECT_ROOT="$AHI_ROOT" TASK_SLUG="mat-task"
  local CHECKPOINTS="1" HANDOFF="" SESSION_DIR=""
  normalize_args "$@"; set -- "${NORMALIZED[@]:-}"
  while [[ $# -gt 0 ]]; do
    case "${1:-}" in
      --task)         TASK="${2:-}"; shift 2 ;;
      --task-file)    TASK_FILE="${2:-}"; shift 2 ;;
      --mode)         MODE="${2:-}"; shift 2 ;;
      --project-root) PROJECT_ROOT="${2:-}"; shift 2 ;;
      --task-slug)    TASK_SLUG="${2:-}"; shift 2 ;;
      --checkpoints)  CHECKPOINTS="${2:-}"; shift 2 ;;
      --handoff)      HANDOFF="${2:-}"; shift 2 ;;
      --session-dir)  SESSION_DIR="${2:-}"; shift 2 ;;
      "")             shift ;;
      *)              die "prompt: unknown arg '$1'" ;;
    esac
  done
  [[ -f "$TEMPLATE" ]] || die "prompt: template not found: $TEMPLATE"
  case "$MODE" in relay|conjunction) ;; "") die "prompt: --mode relay|conjunction is required" ;; *) die "prompt: --mode must be relay or conjunction" ;; esac
  if [[ -n "$TASK_FILE" ]]; then
    [[ -f "$TASK_FILE" ]] || die "prompt: --task-file not found: $TASK_FILE"
    TASK="$(cat "$TASK_FILE")"
  fi
  [[ -n "$TASK" ]] || die "prompt: provide --task TEXT or --task-file FILE"

  [[ -z "$SESSION_DIR" ]] && SESSION_DIR="$(session_dir_for "$TASK_SLUG")"
  [[ -z "$HANDOFF" ]] && HANDOFF="$(resolve_handoff "$TASK_SLUG" "$PROJECT_ROOT")"

  local REPO CODEX_WT CLAUDE_WT
  REPO="$(git_toplevel "$PROJECT_ROOT")"
  if [[ -n "$REPO" ]]; then
    CODEX_WT="${SESSION_DIR}/codex            (branch: mat/${TASK_SLUG}/codex)"
    CLAUDE_WT="${SESSION_DIR}/claude-code      (branch: mat/${TASK_SLUG}/claude-code)"
  else
    CODEX_WT="(non-git project — no worktree; work in place under ${PROJECT_ROOT})"
    CLAUDE_WT="(non-git project — no worktree; work in place under ${PROJECT_ROOT})"
  fi

  # Extract the canonical prompt body between the BEGIN/END markers.
  local body
  body="$(awk '
    /^## END PROMPT[[:space:]]*$/ { f=0 }
    f { print }
    /^## BEGIN PROMPT[[:space:]]*$/ { f=1 }
  ' "$TEMPLATE")"
  [[ -n "$body" ]] || die "prompt: could not extract template body (missing BEGIN/END PROMPT markers)"

  # Literal placeholder substitution (handles metacharacters and multi-line task text).
  local out="$body"
  out="${out//\{\{TASK\}\}/$TASK}"
  out="${out//\{\{MODE\}\}/$(printf '%s' "$MODE" | tr '[:lower:]' '[:upper:]')}"
  out="${out//\{\{PROJECT_ROOT\}\}/$PROJECT_ROOT}"
  out="${out//\{\{HANDOFF_PATH\}\}/$HANDOFF}"
  out="${out//\{\{SESSION_DIR\}\}/$SESSION_DIR}"
  out="${out//\{\{CODEX_WORKTREE\}\}/$CODEX_WT}"
  out="${out//\{\{CLAUDE_WORKTREE\}\}/$CLAUDE_WT}"
  out="${out//\{\{CHECKPOINTS\}\}/$CHECKPOINTS}"

  printf '%s\n' "$out"
}

# ---- list / help ----
cmd_list() {
  echo "MAT helper — paths and status"
  echo
  local f
  for f in "$PROTOCOL" "$TEMPLATE"; do
    local s="MISS"; [[ -f "$f" ]] && s="OK  "
    printf "  [%s] %s\n" "$s" "$f"
  done
  local d="MISS"; [[ -d "$WORKSPACES" ]] && d="OK  "
  printf "  [%s] %s  (session base)\n" "$d" "$WORKSPACES"
  local g="MISS"; [[ -f "$GLOBAL_HANDOFF" ]] && g="OK  "
  printf "  [%s] %s  (global non-git ledger)\n" "$g" "$GLOBAL_HANDOFF"
  echo
  echo "Subcommands: session-init | worktree-prepare | checkpoint | wait | prompt"
  echo "Runbook: ${AHI_ROOT}/runtimes/mat/RUNBOOK.md"
}

print_help() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
}

# ---- dispatch ----
main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    session-init)     cmd_session_init "$@" ;;
    worktree-prepare) cmd_worktree_prepare "$@" ;;
    checkpoint)       cmd_checkpoint "$@" ;;
    wait)             cmd_wait "$@" ;;
    prompt)           cmd_prompt "$@" ;;
    --list|list)      cmd_list ;;
    ""|-h|--help|help) print_help ;;
    *) die "unknown subcommand '$cmd' (try: mat.sh help)" ;;
  esac
}

main "$@"
