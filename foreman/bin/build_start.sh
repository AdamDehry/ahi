#!/usr/bin/env bash
# Start a foreman-supervised build session.
# Usage: build_start.sh [-r claude|codex] [-m model] [-e effort] [-w why] <agent> <name> <workdir> <initial prompt...>
#
# THE MODEL GATE. Runtime, model and effort are three DECISIONS, not three
# defaults. A PreToolUse hook (fm_model_gate.py) refuses any build_start.sh call
# that omits -r -m -e -w, and this script enforces the same rule itself, so the
# fallbacks below only ever apply outside the live registry (test harnesses).
# -w carries the one-line reason; it lands in meta.json, which is what makes the
# ledger (build_ledger.sh) a record of REASONING and not just of model strings.
# Reference sheet: $FOREMAN_ROOT/MODEL-SELECTION.md.
#   -r runtime: claude (default) | codex
#   -m model:   a FULL slug, never an alias — an alias such as "opus" silently
#               resolves to whatever the CLI thinks it means, which has been a
#               previous generation. Current fallbacks (examples; the operator
#               updates them when the vendors move): claude "claude-opus-5-5[1m]",
#               codex "gpt-6.1-sol". New Claude models can need a newer CLI than
#               the one first on PATH, so the launcher runs $CLAUDE_BIN, not bare
#               `claude`.
#   -e effort:  claude → --effort  (low|medium|high|xhigh|max)
#               codex  → model_reasoning_effort (ladder depends on the model;
#                        fm_effort.py is authoritative)
#               PICKER WORDS ARE NOT FLAG VALUES. What the desktop CLI picker
#               shows translates: extra→xhigh, "extra high"→xhigh, light→low, and
#               "ultracode" is not an effort at all (it is a session mode).
#               fm_effort.py holds the table and this script applies it below,
#               because an unrecognised value is DROPPED SILENTLY, not rejected.
#               NEVER use interactive /effort in build sessions — it saves as the
#               GLOBAL default (sticky). Effort is per session, via -e.
#   agent:   tzali | avi  (identity the session is addressed to)
#   name:    short kebab-case build name
#   workdir: absolute path; created if missing (use a git worktree for repo work)
# Prints: BUILD_ID=<id> and, for claude, the claude.ai session URL when Remote
# Control registers (the session then appears live in the owner's Claude apps).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

RUNTIME="claude"; MODEL=""; EFFORT=""; WHY=""; EFFORT_REQUESTED=""
while getopts "r:m:e:w:" opt; do
  case "$opt" in
    r) RUNTIME="$OPTARG" ;;
    m) MODEL="$OPTARG" ;;
    e) EFFORT="$OPTARG" ;;
    w) WHY="$OPTARG" ;;
    *) exit 1 ;;
  esac
done
shift $((OPTIND - 1))
case "$RUNTIME" in claude|codex) ;; *) echo "ERROR: -r must be claude or codex" >&2; exit 1 ;; esac

# ── THE MODEL GATE ─────────────────────────────────────────────────────────
# Lives HERE, not only in the PreToolUse hook, because the hook covers one
# runtime's tool calls and this covers every caller — the supervisor on any
# runtime, or the owner's own shell. -w is required because a choice with no
# recorded reason teaches the next build nothing.
# Exempt: the guard test harness, which starts builds to race the lock and has
# no opinion about models. It is identified the same way the FM_CLAIM_ONLY
# refusal identifies itself — by a BUILDS_DIR that is not the live registry.
GATED=1
[ -n "${FM_CLAIM_ONLY:-}" ] && GATED=0
fm_is_live || GATED=0
if [ "$GATED" = 1 ] && { [ -z "$MODEL" ] || [ -z "$EFFORT" ] || [ "${#WHY}" -lt 15 ]; }; then
  {
    echo "MODEL GATE — build refused, nothing was started."
    [ -z "$MODEL" ]  && echo "  ✗ -m missing — name the model explicitly (never a bare alias)"
    [ -z "$EFFORT" ] && echo "  ✗ -e missing — effort is a decision, not a leftover"
    [ "${#WHY}" -lt 15 ] && echo "  ✗ -w missing or too thin — one line on WHY this model at this effort"
    echo
    echo "Read $FOREMAN_ROOT/MODEL-SELECTION.md, weigh THIS build, then re-issue."
    echo
    "$FOREMAN_ROOT/bin/build_ledger.sh" 2>/dev/null | sed -n '2,12p'
  } >&2
  exit 3
fi

# THE CODEX BINARY IS DEFINED ONCE, HERE. Everything that runs codex — the
# existence probe below and the pane spawn far below — reads this one variable.
# Two definitions is how a probe ends up testing a different binary than the one
# that runs: a stale codex earlier on PATH can answer "requires a newer version"
# for a slug that is live on the binary the launcher actually spawns.
CODEX_BIN="${FM_CODEX_BIN:-$(command -v codex 2>/dev/null || echo "$HOME/.local/bin/codex")}"

# [1m] suffix = 1M-token context window (the CLI gives 200k without it).
# The fallbacks are never empty on purpose: MODEL is interpolated unquoted into
# the tmux command line below, so an empty value would build `-m -c ...` and
# launch a session with a mangled argv instead of refusing cleanly.
[ -z "$MODEL" ] && { [ "$RUNTIME" = "claude" ] && MODEL="claude-opus-5-5[1m]" || MODEL="gpt-6.1-sol"; }
# The same one-definition rule for claude (fm_claude_bin in lib.sh).
CLAUDE_BIN="$(fm_claude_bin)"

# ── EFFORT: TRANSLATE, THEN REFUSE ─────────────────────────────────────────
# People name effort in the words the desktop CLI PICKER shows; the runtimes
# take different words. `extra` → `xhigh`, `light` → `low`, and `ultracode` is
# not an effort at all. Passing a picker word through is not a typo that errors:
# claude WARNS ON STDERR, DROPS IT, AND RUNS AT THE DEFAULT, into a detached
# pane nobody reads — and meta.json then records an effort the build never used.
# So resolve here, at the last path every caller shares, and send the runtime a
# word it will honour. The table is fm_effort.py; there is no copy of it here.
if [ -n "$EFFORT" ]; then
  if EFFORT_RESOLVED="$("$FOREMAN_ROOT/bin/fm_effort.py" "$RUNTIME" "$MODEL" "$EFFORT" 2>/tmp/fm_effort.$$)"; then
    if [ "$EFFORT_RESOLVED" != "$EFFORT" ]; then
      echo "NOTE: effort '$EFFORT' → '$EFFORT_RESOLVED' (picker word → flag value)." >&2
      EFFORT_REQUESTED="$EFFORT"
    fi
    EFFORT="$EFFORT_RESOLVED"
  elif [ "$GATED" = 1 ]; then
    { echo "MODEL GATE — build refused, nothing was started."
      echo "  ✗ -e '$EFFORT' — $(cat /tmp/fm_effort.$$)"; } >&2
    rm -f "/tmp/fm_effort.$$"
    exit 3
  fi
  rm -f "/tmp/fm_effort.$$"
fi

# ── THE MODEL MUST RESOLVE, NOT MERELY PARSE ───────────────────────────────
# The MODEL GATE above validates the SHAPE of -m: present, not a bare alias. It
# never asks whether the slug RESOLVES — the control sits on the argument while
# the capability lives at the API. A provider-retired slug 404s every launch
# into a detached pane, and each death looks like a launcher fault.
#
# Placed here, beside the other gates: a refusal at this line costs nothing and
# leaves nothing.
#
# IT RUNS $CODEX_BIN — the same binary the pane spawns, from one definition, so
# the probe cannot test a different codex than the one that runs. A probe on the
# wrong binary refuses good models with total confidence.
#
# IT REFUSES ONLY ON PROOF. Exit status alone is not evidence — a network blip,
# a stale auth and a 400 all exit non-zero. Refuse if and only if the provider
# SAYS the slug does not exist; anything else prints a NOTE and proceeds. A
# probe that blocked on ambiguity would hand the launcher a brand-new way to
# stop every build, which is a worse failure than the one being fixed.
#
# CODEX ONLY, deliberately. claude's `[1m]` suffix is CLI syntax, not an API
# slug — a naive probe would 404 the suffix and refuse the most-used model.
# Widen this on evidence, not on symmetry. Keep a paired case for it: one live
# slug (must pass) and one retired slug (must refuse) — a check must be able to fail.
# Skipped when GATED=0 — the harness/sandbox identity the MODEL GATE already
# uses. A test harness pays no API call and cannot be blocked by one; deliberately
# NOT a new opt-out env var, which is how a gate becomes optional.
if [ "$GATED" = 1 ] && [ "$RUNTIME" = "codex" ] && [ -n "$MODEL" ]; then
  PROBE_OUT="$(mktemp /tmp/fm_model_probe.XXXXXX)"
  PROBE_RC=0
  timeout 90 "$CODEX_BIN" exec -m "$MODEL" -c 'features.shell_snapshot=false' \
    --skip-git-repo-check "say ok" \
    </dev/null >"$PROBE_OUT" 2>&1 || PROBE_RC=$?
  if grep -qF "does not exist or you do not have access to it" "$PROBE_OUT"; then
    {
      echo "MODEL GATE — build refused, nothing was started."
      echo "  ✗ -m '$MODEL' — the PROVIDER says this slug does not exist or is not"
      echo "    available to this account. Retired or misspelled. No lock was taken,"
      echo "    no BUILD_ID minted, no workdir claimed."
      echo "    probe: $CODEX_BIN exec -m '$MODEL' (rc=$PROBE_RC) → $PROBE_OUT"
      echo "    current codex slugs: see the Codex table in MODEL-SELECTION.md"
      echo
      echo "Read $FOREMAN_ROOT/MODEL-SELECTION.md, weigh THIS build, then re-issue."
    } >&2
    exit 3
  fi
  if [ "$PROBE_RC" -ne 0 ]; then
    echo "NOTE: model probe for '$MODEL' exited $PROBE_RC with no 404 — that is not a" >&2
    echo "      retired slug, so the launch PROCEEDS. Evidence kept: $PROBE_OUT" >&2
  else
    rm -f "$PROBE_OUT"
  fi
fi

# ── THE GATE GATE ──────────────────────────────────────────────────────────
# Placed HERE, beside the model gate, for one reason: a refusal at this line
# costs nothing and leaves nothing. No lock has been taken, no BUILD_ID minted,
# no meta.json written. Refusing after registration would leave a phantom claim
# — the exact failure the collision guard below exists to prevent — so the gate
# that refuses to launch must refuse before the launcher has done anything.
#
# ADDITIVE AND REVERSIBLE: if fm_gates.sh is absent this block is inert and
# build_start.sh behaves EXACTLY as it would without gates — no check, no
# message, no non-zero. The refusal only engages once an operator has installed
# the gate machinery, which is what makes deleting one file a real rollback
# rather than a broken launcher.
#
# Once installed, two things are refusals rather than warnings:
#   1. no usable gate source — the machinery is installed but has nothing to say
#   2. ACTIVE-GATES.md and QUEUE.md DISAGREE — "they cannot silently disagree"
#      is not a report nobody reads; a disagreement stops every build until a
#      human reconciles it.
# Why refuse rather than proceed here: the blast radius is one un-launched build
# and the retry is cheap, local, and immediate. Compare the Bash guard, which
# fails OPEN on an absent source — there, refusing would block the recovery path
# itself. Failure mode is placed by blast radius, not answered once globally.
FM_GATES_ON=0
FM_GATES_OPTOUT="${FM_GATES_OPTOUT:-}"   # set -u is in force; declare before use
if [ -f "$FOREMAN_ROOT/bin/fm_gates.sh" ]; then
  # shellcheck source=/dev/null
  source "$FOREMAN_ROOT/bin/fm_gates.sh"
  FM_GATES_ON=1
  GATE_FAIL=""
  fm_gates_available || GATE_FAIL="no usable gate source (ACTIVE-GATES.md missing)"
  if [ -z "$GATE_FAIL" ]; then
    GATE_REPORT="$(fm_gates_check)" || GATE_FAIL="ACTIVE-GATES.md and QUEUE.md disagree"
  fi
  if [ -n "$GATE_FAIL" ]; then
    # The opt-out demands a REASON, and a thin one is not a reason. Same
    # discipline as -w on the model gate: an override that costs nothing to
    # type is not an override, it is a default.
    if [ "${#FM_GATES_OPTOUT}" -ge 15 ]; then
      echo "⚠ GATE GATE OVERRIDDEN — $GATE_FAIL" >&2
      echo "  reason: $FM_GATES_OPTOUT" >&2
      echo "  This build launches UNGATED and the ledger will say so." >&2
    else
      {
        echo "GATE GATE — build refused, nothing was started."
        echo "  ✗ $GATE_FAIL"
        echo
        [ -n "${GATE_REPORT:-}" ] && printf '%s\n\n' "$GATE_REPORT"
        echo "Reconcile: $FOREMAN_ROOT/bin/fm_gates.py check"
        echo "Override:  FM_GATES_OPTOUT='<15+ chars saying why an ungated build is correct>'"
      } >&2
      exit 3
    fi
  fi
fi

AGENT="${1:?agent}"; NAME="${2:?name}"; WORKDIR="${3:?workdir}"; shift 3
PROMPT="${*:?initial prompt}"

# ── THE LIVE GATEWAY IS NEVER A WORKDIR ───────────────────────────────────
# A build must never run inside the tree the running service executes from.
# Compared on RESOLVED paths, so a symlink spelling and any subdirectory are
# caught too. Worktrees under the builds dir are fine.
if GW_HIT="$(fm_workdir_gateway_hit "$WORKDIR")"; then
  echo "ERROR: workdir $WORKDIR is the live gateway tree ($GW_HIT). Refused; nothing was started." >&2
  echo "       Build in a worktree instead, e.g.:" >&2
  echo "         $FOREMAN_ROOT/bin/fm_worktree.sh $GW_HIT <name> <branch>" >&2
  echo "       (git worktree add + node_modules hardlinked from the shared dependency cache;" >&2
  echo "        see $FOREMAN_ROOT/WORKTREES.md. Plain 'git worktree add' still works, at the cost of a full node_modules.)" >&2
  exit 1
fi

# ── QUEUE-ITEM CLAIM ──────────────────────────────────────────────────────
# The workdir lock below answers "who may write this path?" It cannot answer
# "who owns this subject?" Two different paths would otherwise let two live
# builds claim the same queue item seconds apart.
#
# Identity is each canonical key on the brief's first non-empty line; a compound
# order owns every one of its keys. The CURRENT claim for a reused session is
# its last dated CLAIMED record in the queue (both legacy comment and top-level
# forms are recognised).
# Liveness is an exact tmux has-session query — never pgrep/ps, which can count
# the checking shell itself. A dead session is ignored even if its claim is stale.
ITEM_KEY="$(printf '%s' "$PROMPT" | fm_item_key_from_text)"
ITEM_QUEUE="${FM_QUEUE_FILE:-${QUEUE:-$FOREMAN_ROOT/QUEUE.md}}"
if [ -n "$ITEM_KEY" ]; then
  ITEM_CLAIM=0
  fm_item_claim_acquire "$ITEM_KEY" || ITEM_CLAIM=$?
  if [ "$ITEM_CLAIM" -eq 2 ]; then
    echo "ERROR: cannot open the queue-item lock for $ITEM_KEY — refusing unguarded." >&2
    exit 1
  fi
  if [ "$ITEM_CLAIM" -eq 1 ]; then
    echo "ERROR: queue item $ITEM_KEY is being claimed by another launch." >&2
    echo "       Nothing was started; retry only after that launch is visible." >&2
    exit 1
  fi
  ITEM_HOLDER="$(fm_claimed_item_live_holder "$ITEM_KEY" "$ITEM_QUEUE")"
  if [ -n "$ITEM_HOLDER" ]; then
    fm_item_claim_release
    echo "ERROR: queue item $ITEM_KEY is already CLAIMED by live build $ITEM_HOLDER." >&2
    echo "       Exact tmux-session liveness was verified; nothing was started." >&2
    echo "       Steer that session instead:" >&2
    echo "         $FOREMAN_ROOT/bin/build_say.sh $ITEM_HOLDER \"next work order...\"" >&2
    exit 1
  fi
fi

# Canonical from here down. A symlink to a worktree and the worktree itself are
# ONE lane; if they hash or string-compare differently the guard reports green
# while both builders write to the same files. Resolving also makes meta.json's
# workdir match what foreman_wake.sh receives as the hook `cwd` (a process cwd is
# always resolved), so wake attribution gets more reliable, not less.
case "$WORKDIR" in /*) ;; *) echo "ERROR: workdir must be an absolute path" >&2; exit 1 ;; esac
WORKDIR="$(fm_resolve_workdir "$WORKDIR")"
LOCK="$(fm_lock_path "$WORKDIR")"

# FM_CLAIM_ONLY — the test path. Resolves, locks, registers, then exits BEFORE
# spawning tmux or any runtime, so the guard can be raced hundreds of times
# without burning a token or leaving an orphan session. It is gated on a sandbox
# registry: a claim-only run must NEVER write the live one, because a phantom
# active build breaks the concurrency cap and corrupts the foreman wake source.
# Note what this flag does NOT do: it appears nowhere between here and the end of
# registration, so the real path and the test path execute byte-identical guard
# code. That is the whole reason the demonstration proves anything.
if [ -n "${FM_CLAIM_ONLY:-}" ] && fm_is_live; then
  echo "ERROR: FM_CLAIM_ONLY refuses to write the live registry." >&2
  echo "       Point BUILDS_DIR (and FM_LOCKS_DIR) at a sandbox first." >&2
  exit 2
fi

# ── WORKDIR CLAIM + CONCURRENCY CAP ────────────────────────────────────────
# COLLISION GUARD. A guard that scans the registry for a holder and registers
# itself afterwards is a read-then-write race: two starts inside that window
# both read "free". The window is seconds, not milliseconds — two supervisors
# have started the same build seven seconds apart.
#
# So: take an atomic kernel lock keyed on the resolved workdir FIRST, and do
# both the check and the registration while holding it. The loser cannot read a
# stale "free" because the winner's meta.json is written before the lock drops.
#
# The lock and the registry are cross-checked rather than trusted separately —
# they answer different questions ("is a process live in this lane" vs "is a
# build recorded in it") and every disagreement between them is reported, never
# silently resolved. A silent recovery is indistinguishable from luck.
BUILD_ID="$(date +%Y%m%d-%H%M%S)-$NAME"
BUILD_DIR="$BUILDS_DIR/$BUILD_ID"
TMUX_SESSION="fm-$BUILD_ID"

# Codex's trust decision is exact-path and must exist in config.toml before the
# TUI starts; the command-line trust override below is kept but is not
# sufficient on its own. Refuse before claiming or registering if
# append/verification cannot complete safely.
if [ "$RUNTIME" = "codex" ] && [ -z "${FM_CLAIM_ONLY:-}" ]; then
  CODEX_STATE_HOME="${CODEX_HOME:-$HOME/.codex}"
  CODEX_CONFIG="$CODEX_STATE_HOME/config.toml"
  CODEX_TRUST_ROLLBACK="$FOREMAN_ROOT/rollback/codex-config.toml.pre-trust-$BUILD_ID"
  if ! fm_codex_trust_workdir "$WORKDIR" "$CODEX_CONFIG" "$CODEX_TRUST_ROLLBACK"; then
    echo "LAUNCH BLOCKED: exact Codex workdir trust could not be established." >&2
    echo "                No workdir claim or build registration was created." >&2
    exit 3
  fi
  CODEX_SNAPSHOT_DIR="$CODEX_STATE_HOME/shell_snapshots"
  if ! fm_codex_secure_snapshot_dir "$CODEX_SNAPSHOT_DIR"; then
    echo "LAUNCH BLOCKED: Codex shell-snapshot permissions could not be secured." >&2
    echo "                No workdir claim or build registration was created." >&2
    exit 3
  fi
fi

CLAIM=0
fm_claim_acquire "$WORKDIR" || CLAIM=$?
if [ "$CLAIM" -eq 2 ]; then
  echo "ERROR: cannot open the workdir lock ($LOCK) — refusing to start unguarded." >&2
  exit 1
fi
# Stamp the lock the INSTANT it is won, before the registry scan — this is what
# lets a loser name the winner. With the id written only after registration, a
# non-blocking loser fails inside the winner's sub-second check-and-register
# section, finds the registry still empty, and can only report a generic "a live
# process". The lock file now carries the identity from the moment the claim
# exists, so there is no window where the winner is anonymous.
if [ "$CLAIM" -eq 0 ]; then fm_claim_note_write "$WORKDIR" "$BUILD_ID"; fi

ACTIVE=0; HOLDER=""
for d in "$BUILDS_DIR"/*/; do
  [ -f "$d/meta.json" ] || continue
  id="$(basename "$d")"
  [ "$(fm_status "$id")" = "active" ] || continue
  # Only a MOVING build takes a slot. A build whose turn has ended (paused,
  # waiting on the owner or the supervisor, finished its turn) frees its slot;
  # it waits for room when steered again. The workdir claim below still counts it.
  last_ev="$(tail -n 1 "$d/events.jsonl" 2>/dev/null | python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read())["type"])
except Exception: print("")' 2>/dev/null)"
  case "$last_ev" in
    awaiting|awaiting-reminder|wake|wake-deferred|poll-wake|turn-end|status-finished) ;;
    *) ACTIVE=$((ACTIVE + 1)) ;;
  esac
  other_wd="$(fm_meta "$id" workdir 2>/dev/null)" || continue
  if [ "$(fm_resolve_workdir "$other_wd")" = "$WORKDIR" ]; then HOLDER="$id"; fi
done

if [ "$CLAIM" -eq 1 ] && [ -z "$HOLDER" ]; then
  # THE TIGHT RACE. We lost the lock to a start that has not finished registering,
  # so the registry cannot name it yet — and neither can the owner stamp, which
  # the winner writes a few milliseconds after it wins. Losing is already decided
  # and is not revisited here; this only waits out the winner's sub-second
  # registration so the REFUSAL CAN BE AUTHORITATIVE instead of a guess.
  # Without this wait, roughly one round in four of simultaneous starts reports
  # "a live process" rather than naming the winner.
  if fm_claim_wait "$WORKDIR" 5; then
    HOLDER="$(fm_workdir_holder "$WORKDIR")"
    fm_claim_release
  fi
fi

if [ "$CLAIM" -eq 1 ] && [ -n "$HOLDER" ]; then
  # The designed collision. Lock and registry agree; name the winner.
  echo "ERROR: build $HOLDER is already active in $WORKDIR." >&2
  echo "       Workdir lock is held by that build ($LOCK)." >&2
  echo "       One lane, one builder. Steer that session instead:" >&2
  echo "         $FOREMAN_ROOT/bin/build_say.sh $HOLDER \"next work order...\"" >&2
  echo "       Or close it first: $FOREMAN_ROOT/bin/build_done.sh $HOLDER done" >&2
  exit 1
fi

if [ "$CLAIM" -eq 1 ]; then
  # Locked, but no ACTIVE build is recorded for this workdir yet. Almost always
  # the tight race: the winner holds the lock and is still inside its
  # check-and-register section, so the registry cannot answer yet — but the lock
  # stamp can, and it names the same build id the winner is about to register.
  # The other way here is a session that outlived its own build record.
  WINNER="$(fm_claim_note_read "$WORKDIR")"
  if [ -n "$WINNER" ]; then
    echo "ERROR: build $WINNER just claimed $WORKDIR — it won the lock, this start lost it." >&2
    echo "       Its registration was still in flight when this check ran; the claim is real." >&2
    echo "       One lane, one builder. Steer that session instead:" >&2
    echo "         $FOREMAN_ROOT/bin/build_say.sh $WINNER \"next work order...\"" >&2
  else
    echo "ERROR: $WORKDIR is locked by a LIVE process that carries no build id." >&2
    echo "       Lock file: $LOCK" >&2
    if command -v fuser >/dev/null 2>&1; then
      echo "       Holding pids: $(fuser "$LOCK" 2>/dev/null || echo '(none reported)')" >&2
    fi
    # After `tmux kill-session` the runtime takes a few seconds to shut down and
    # drop the descriptor, and build_done writes status:done first. So this
    # branch is also the normal, harmless view of a build closing.
    echo "       Either a build is still shutting down — re-run in a few seconds —" >&2
    echo "       or a session has outlived its build record and should be killed." >&2
  fi
  echo "       Nothing was started." >&2
  exit 1
fi

if [ -n "$HOLDER" ]; then
  # Lock is FREE but the registry still claims the lane. Two ways to get here:
  # the build predates this guard (no lock was ever taken), or it died without
  # being closed. Report which, and do NOT reclaim — auto-stealing a claim from a
  # pre-lock build that is still running recreates the collision exactly.
  # We hold the lock but are about to refuse. Clear the stamp we wrote on the way
  # in, so the file never names a build that was never registered.
  fm_claim_note_write "$WORKDIR" ""
  HTMUX="$(fm_meta "$HOLDER" tmux 2>/dev/null || true)"
  if [ -n "$HTMUX" ] && tmux has-session -t "$HTMUX" 2>/dev/null; then HSTATE="ALIVE"; else HSTATE="GONE"; fi
  echo "ERROR: build $HOLDER is registered active in $WORKDIR, but holds NO LOCK." >&2
  echo "       Its tmux session ($HTMUX) is $HSTATE." >&2
  echo "       That build predates the workdir lock, or it died without being closed." >&2
  echo "       NOT reclaiming automatically — a claim is a claim, and a silent" >&2
  echo "       recovery is indistinguishable from luck." >&2
  if [ "$HSTATE" = "ALIVE" ]; then
    echo "       The session is REAL and running. Steer it:" >&2
    echo "         $FOREMAN_ROOT/bin/build_say.sh $HOLDER \"next work order...\"" >&2
  else
    echo "       The session is gone. Close the record, then re-run this command:" >&2
    echo "         $FOREMAN_ROOT/bin/build_done.sh $HOLDER abandoned" >&2
  fi
  exit 1
fi

# FM_CAP: per-launch override of the concurrency cap. Default 5. Same-repo builds
# need separate worktrees. Go above the default only on the owner's explicit say.
FM_CAP="${FM_CAP:-5}"
if [ "$ACTIVE" -ge "$FM_CAP" ]; then
  fm_claim_note_write "$WORKDIR" ""   # refusing while holding the lock; see above
  echo "ERROR: $ACTIVE builds already active (cap $FM_CAP). Finish one first (build_done.sh)." >&2
  exit 1
fi

mkdir -p "$BUILD_DIR" "$WORKDIR"

# meta.json — written exactly once, never modified after this.
python3 - "$BUILD_DIR/meta.json" "$BUILD_ID" "$AGENT" "$NAME" "$WORKDIR" "$TMUX_SESSION" "$PROMPT" "$RUNTIME" "$MODEL" "$EFFORT" "$WHY" "$ITEM_KEY" <<'PY'
import json, sys, time
path, bid, agent, name, workdir, tmux, prompt, runtime, model, effort, why, item_key = sys.argv[1:13]
# effort and why are first-class fields: effort buried in an event string can only
# be recovered by parsing prose, and the REASON for a model choice is precisely
# what the next decision needs to recall.
json.dump({"build_id": bid, "agent": agent, "name": name, "workdir": workdir,
           "tmux": tmux, "prompt": prompt, "runtime": runtime, "model": model,
           "effort": effort or "default", "why": why,
           "item_key": item_key,
           "created": int(time.time())},
          open(path, "w"), indent=2)
PY

# REGISTRATION IS NOT COMPLETE UNTIL events.jsonl EXISTS. fm_status returns
# "unknown" — not "active" — for a build whose events file is missing, and the
# scan above skips anything that is not "active". So meta.json alone is
# INVISIBLE to the guard; if the first event waited until after the runtime
# launched (~15s later), the lock alone would not close the race. Written while
# the lock is still held.
fm_event "$BUILD_ID" "created" "workdir=$WORKDIR lock=$LOCK runtime=$RUNTIME"
fm_claim_note_write "$WORKDIR" "$BUILD_ID"

# ── THE GATES TRAVEL WITH THE BUILD ────────────────────────────────────────
# Write the gate set INTO the workspace, and record its digest in the ledger.
# Two distinct jobs, and neither one is the prompt:
#   1. .foreman/ACTIVE-GATES.md is what the PreToolUse guard reads. The guard
#      must not have to reach across the filesystem to a file that may have
#      changed or vanished since launch — the gates that govern a build sit
#      beside that build, written once, by the launch that already refused to
#      start without them.
#   2. the ledger event is the ONLY durable record of WHICH gate set governed
#      this build. Prove it from state, not from the document's own claim.
# Deliberately ABOVE the FM_CLAIM_ONLY exit, so the cheap test path and the real
# launch execute the same lines — the same reason the collision guard is written
# that way.
GATE_DIGEST=""
if [ "$FM_GATES_ON" = 1 ]; then
  if fm_gates_available && fm_gates_install "$WORKDIR"; then
    GATE_DIGEST="$(fm_gates_digest)"
    fm_event "$BUILD_ID" "gates" "digest=$GATE_DIGEST count=$(fm_gates_count) source=$FOREMAN_ROOT/ACTIVE-GATES.md installed=$WORKDIR/.foreman/ACTIVE-GATES.md"
  else
    fm_event "$BUILD_ID" "gates" "UNGATED — launched with FM_GATES_OPTOUT: $FM_GATES_OPTOUT"
  fi
fi

if [ -n "${FM_CLAIM_ONLY:-}" ]; then
  [ -z "$ITEM_KEY" ] || fm_item_claim_release
  echo "BUILD_ID=$BUILD_ID"
  echo "CLAIM_ONLY: workdir claimed and build registered; no runtime spawned."
  exit 0
fi

# Hand the claim to the pane. From here the lock belongs to the session process
# (fm_hold_lock.sh), which holds it for the life of the build and lets the kernel
# release it on exit, crash, kill or reboot.
fm_claim_release
HOLD_LOCK="$FOREMAN_ROOT/bin/fm_hold_lock.sh"

AGENT_CAP="$(python3 -c "print('$AGENT'.capitalize())")"

# ── THE GATE BLOCK ENTERS THE PROMPT ───────────────────────────────────────
# Every spawn prompt carries the active gate list VERBATIM — not a paraphrase,
# not "respect the gates". A gate that depends on the operator remembering to
# paste it will eventually be missing.
#
# VERBATIM, INLINE, not a pointer: the reader who most needs a ruling is exactly
# the reader who will not go and fetch it. The workspace copy written above is
# for the GUARD, which is a program and does fetch it. The prompt copy is for
# the agent.
#
# SIZE IS MEASURED, NOT ASSUMED. ~15KB through `tmux send-keys` arrives
# byte-identical, so transport is not the constraint. When the set outgrows
# FM_GATES_MAX_INLINE the block SAYS SO IN PLAIN WORDS at its head and names
# what was left out — a silent truncation would ship a gate list that reads
# complete and is not.
GATE_PREFIX=""
if [ "$FM_GATES_ON" = 1 ] && [ -n "$GATE_DIGEST" ]; then
  GATE_PREFIX="$(fm_gates_render "$RUNTIME")"$'\n\n'
fi

# The skills-shelf sentence is added only when a shelf is installed.
SKILLS_SHELF="$AHI_HOME/skills/README.md"
SKILLS_CLAUSE=""
if [ -f "$SKILLS_SHELF" ]; then
  SKILLS_CLAUSE=" Skills shelf: before you start, open $SKILLS_SHELF and use the newest verified skill for this task's category; if this build taught a repeatable how-to, land it on its shelf before you report ready (a new skill, or a version bump of the existing one)."
fi

BRIEF="$GATE_PREFIX$AGENT_CAP — you are in a foreman-supervised build session (build: $BUILD_ID). Michael supervises via steer messages; the owner may watch or type at any time — from a terminal or the Claude/Codex apps. Work autonomously; when you finish a phase or get blocked, end your turn with a clear one-paragraph status. Also record each checkpoint, from your worktree: python3 -B $FOREMAN_ROOT/bin/fm_status.py emit --kind progress|needs_owner|closed|failed --finished \"<one line>\" --now \"<one line>\" [--checks PASSED/TOTAL, as measured] [--question \"<one question?>\", needs_owner only]. The owner sees needs_owner, closed and failed in chat, rendered in code from that record; progress stays on the build timeline. Plain sentences: no paths, ids, brackets or markup. Last step before you report ready for review: run ONE simplify pass over your own diff (Claude: the simplify skill; Codex: the same review by hand) — cut bloat, duplication, needless layers and comments, no behaviour changes; NEVER cut security or trust-boundary checks, input validation, data-loss or error handling, or accessibility — then rerun the tests and note in REPORT.md what it removed.$SKILLS_CLAUSE The brief: $PROMPT"

# ── THE LAUNCHER CHECKS ITS OWN WORK ───────────────────────────────────────
# The composed brief is written to the workspace and then VERIFIED to carry
# every active gate, before any runtime is spawned.
#
# "I wrote a prepend, therefore the prompt carries the gates" is a textual claim
# about a variable. If a future edit reorders these lines, drops $GATE_PREFIX,
# or truncates BRIEF, the prepend fails SILENTLY and the build launches looking
# perfectly normal — the gates simply stop arriving. This makes that loud: it
# re-reads the composed text and asks the gate source.
#
# verify-prompt compares on NORMALISED text, so re-wrapping is invisible to it
# and a paraphrase is not. That asymmetry is why this is a real check and not a
# grep -l.
#
# BRIEF.txt is not a debug artefact — it is the record of what was ACTUALLY
# delivered, so "was this build gated, and with what text" is answerable from
# state rather than from the launcher's own claim to have done it.
if [ "$FM_GATES_ON" = 1 ] && [ -n "$GATE_DIGEST" ]; then
  mkdir -p "$WORKDIR/.foreman"
  printf '%s' "$BRIEF" > "$WORKDIR/.foreman/BRIEF.txt"
  if ! GATE_VERIFY="$(fm_gates_verify "$WORKDIR/.foreman/BRIEF.txt")"; then
    {
      echo "GATE GATE — launch refused AFTER composition, no runtime was spawned."
      echo "  ✗ the composed brief does not carry the active gates:"
      printf '%s\n' "$GATE_VERIFY"
      echo
      echo "  This is a defect in build_start.sh itself, not in your invocation."
      echo "  The brief as composed is at $WORKDIR/.foreman/BRIEF.txt"
    } >&2
    fm_event "$BUILD_ID" "launch-blocked" "composed brief failed gate self-check: $GATE_VERIFY"
    fm_event "$BUILD_ID" "status:failed" "never launched; gate self-check"
    exit 3
  fi
  fm_event "$BUILD_ID" "gates-delivered" "brief carries all $(fm_gates_count) gates verbatim; brief=${#BRIEF} bytes gate-set=$GATE_DIGEST"
fi

# FM_BRIEF_ONLY — the composition test path, and the exact sibling of
# FM_CLAIM_ONLY: it stops after the brief is built and checked, so the delivery
# can be inspected byte-for-byte without spawning a runtime or burning a token.
# Everything above this line is the real launch path; the flag appears nowhere in it.
if [ -n "${FM_BRIEF_ONLY:-}" ]; then
  echo "BRIEF_ONLY: composed and gate-checked; no runtime spawned."
  echo "BRIEF_FILE=$WORKDIR/.foreman/BRIEF.txt"
  exit 0
fi

# ── TMUX SERVER PLACEMENT, CHECKED AT EACH new-session ─────────────────────
# Called immediately before both `tmux new-session` sites, not once up top: the
# server can vanish between the two, and a new-session with no server running
# forks one into whatever cgroup THIS process is in — the gateway's, when a
# gateway-launched turn runs the start — and the next gateway restart then kills
# every build. fm_tmux_ensure_server (lib.sh) starts a scoped server or refuses
# with the fix.
fm_tmux_placement_or_refuse() {
  local spid
  if FM_TMUX_SOCKET="" fm_tmux_ensure_server; then
    spid="$(FM_TMUX_SOCKET="" fm_tmux_server_pid)"
    fm_event "$BUILD_ID" "tmux-server" "pid=$spid cgroup=$(sed -n 's/^0:://p' "/proc/$spid/cgroup" 2>/dev/null || true)"
    return 0
  fi
  fm_event "$BUILD_ID" "launch-failed" "tmux server missing or inside $FM_GATEWAY_UNIT's cgroup — a gateway restart would kill this build (see stderr for the fix)"
  fm_event "$BUILD_ID" "status:failed" "never launched; workdir claim released"
  echo "LAUNCH FAILED: $BUILD_ID — tmux server placement refused; nothing was spawned." >&2
  exit 1
}

if [ "$RUNTIME" = "claude" ]; then
  # ── THE ENFORCEMENT HALF ─────────────────────────────────────────────────
  # The block in the prompt is KNOWLEDGE, and prompt rails are advisory — an
  # agent told not to print a credential value can still do it on its first
  # command. So the gates with teeth also become a PreToolUse hook, which does
  # not care whether the agent read, believed, or remembered anything.
  #
  # EMITTED ONLY WHEN THERE IS A GUARD AND A GATE SET TO ENFORCE. A settings.json
  # naming a hook script that is not there would make every tool call in the
  # build emit a hook error — a rollback that breaks builds is not a rollback.
  #
  # THE MATCHER comes from evidence, not memory: counting tool_use names across
  # real transcripts showed the spawn tool is `Agent` (not `Task`), plus
  # `Workflow` and `TaskCreate`, which also hand a prompt to a spawned agent. A
  # live probe hook returning 2 refused the spawn; a control matcher of "Bash"
  # let it through, so the matcher is what carries the weight. `Task` stays:
  # other CLI versions use it, and naming a tool that does not exist costs nothing.
  FM_GATE_HOOK=0
  if [ "$FM_GATES_ON" = 1 ] && [ -n "$GATE_DIGEST" ] && [ -f "$FOREMAN_ROOT/bin/fm_gate_guard.py" ]; then
    FM_GATE_HOOK=1
  fi

  # Inject hooks + permissions into the build workspace.
  #
  # ── DOUBLE SLASH IS LOAD-BEARING. DO NOT "TIDY" IT. ──────────────────────
  # In a Claude Code permission rule a path-scoped verb — Read/Edit/Write — reads
  # a SINGLE leading slash as relative to the settings file's own directory. So
  # "Write(/abs/agents/soul/**)" resolves to "$WORKDIR/abs/agents/soul/**", a
  # path that never exists, and the rail is INERT while looking correct. Only
  # Bash(...) rules enforce regardless — which is why one rail that rings (git
  # push) is not proof the whole array works. "//" is filesystem-absolute and it
  # is what enforces. Proven behaviourally against decoys: single-slash rule +
  # write to the named dir → ALLOWED; identical run with "//" → REFUSED; a Bash
  # deny in the same file refused in both runs as the control.
  # Claude Code does NOT expand env vars inside settings.json, so every path is
  # resolved HERE and written literally. Where a configured path is a symlink,
  # both the configured and the resolved spelling are denied (belt-and-braces).
  # The canary/** pair exists so a build can RING its own path rail against a
  # target that is safe to attempt — no build can test a rail whose every target
  # is a file it must not touch.
  # LIMIT: headless `claude -p` has been seen to honour NO path rule in any
  # syntax. These rails are proven for interactive build sessions only.
  #
  # MERGED, NOT OVERWRITTEN. A workdir that already carries its own
  # .claude/settings.json keeps every key it had; the block below is the
  # foreman's OVERLAY, unioned in by fm_settings_merge (lib.sh) — idempotent,
  # original kept once as settings.json.pre-foreman. An unparseable file refuses
  # the launch rather than being clobbered.
  mkdir -p "$WORKDIR/.claude"
  FM_OVERLAY="$(mktemp /tmp/fm_settings_overlay.XXXXXX)"
  if ! python3 - "$FM_OVERLAY" "$FOREMAN_ROOT" "$FM_GATEWAY_DIR" "$AHI_HOME" "$FM_GATE_HOOK" <<'PY'
import json, os, shlex, sys
out, foreman, gateway, ahi_home, gate_hook = sys.argv[1:6]

def spellings(p):
    """The configured absolute path, plus its resolved form when that differs."""
    p = os.path.abspath(p)
    r = os.path.realpath(p)
    return [p] if r == p else [p, r]

def rule(verb, path):
    return f"{verb}(/{path})"   # "/" + absolute path = the "//" absolute form

deny = []
def add(verbs, path, suffix=""):
    for sp in spellings(path):
        for v in verbs:
            r = rule(v, sp + suffix)
            if r not in deny:
                deny.append(r)

add(("Read", "Edit", "Write"), os.path.join(gateway, ".env"))
add(("Edit", "Write"), os.path.join(ahi_home, "agents", "memory", "michael", "STYLE.md"))
add(("Edit", "Write"), os.path.join(ahi_home, "agents", "soul"), "/**")
add(("Edit", "Write"), os.path.join(foreman, "canary"), "/**")
deny += ["Bash(systemctl*)", "Bash(rm -rf*)", "Bash(git push*)"]

def cmd(name):
    return {"type": "command", "command": shlex.quote(os.path.join(foreman, "bin", name))}

hooks = {}
if gate_hook == "1":
    hooks["PreToolUse"] = [{"matcher": "Bash|Task|Agent|TaskCreate|Workflow",
                            "hooks": [cmd("fm_gate_guard.py")]}]
hooks["Stop"] = [{"hooks": [cmd("foreman_wake.sh")]}]
hooks["Notification"] = [{"hooks": [cmd("foreman_notify.sh")]}]

overlay = {
    "permissions": {
        "allow": [
            "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add*)",
            "Bash(git commit*)", "Bash(git checkout*)", "Bash(git branch*)",
            "Bash(npm run*)", "Bash(npm test*)", "Bash(npm install)", "Bash(npx tsc*)",
            "Bash(node *)", "Bash(python3 *)", "Bash(ls*)", "Bash(mkdir*)",
            "Bash(grep*)", "Bash(rg*)", "Bash(cat*)", "Bash(curl -s http://localhost*)",
        ],
        "deny": deny,
    },
    "hooks": hooks,
}
with open(out, "w") as fh:
    json.dump(overlay, fh, indent=2)
    fh.write("\n")
PY
  then
    rm -f "$FM_OVERLAY"
    fm_event "$BUILD_ID" "launch-failed" "settings overlay could not be composed — not launched"
    fm_event "$BUILD_ID" "status:failed" "never launched; workdir claim released"
    echo "LAUNCH FAILED: $BUILD_ID — the foreman settings overlay could not be composed." >&2
    exit 1
  fi
  if ! fm_settings_merge "$WORKDIR/.claude/settings.json" "$FM_OVERLAY"; then
    rm -f "$FM_OVERLAY"
    fm_event "$BUILD_ID" "launch-failed" "workdir .claude/settings.json could not be merged (see stderr) — not overwritten, not launched"
    fm_event "$BUILD_ID" "status:failed" "never launched; workdir claim released"
    echo "LAUNCH FAILED: $BUILD_ID — $WORKDIR/.claude/settings.json could not be merged; fix it and re-run." >&2
    exit 1
  fi
  # Keep the overlay beside the ledger. Anything that regenerates the workdir's
  # settings.json (a gateway booted from the worktree, say) strips the Stop
  # hook; the heartbeat re-merges this exact file each tick, so the hooks come
  # back without a human.
  mv "$FM_OVERLAY" "$BUILD_DIR/settings.overlay.json" 2>/dev/null || rm -f "$FM_OVERLAY"

  # Remote Control needs the full-scope login credential
  # (~/.claude/.credentials.json) — CLAUDE_CODE_OAUTH_TOKEN would override it
  # and silently disable RC, so it is explicitly UNSET here. Headless gateway
  # spawns keep using the env token; this only affects build sessions.
  # bypassPermissions: no permission pauses mid-build. The injected deny list
  # above still holds — deny rules are enforced even in bypass mode — so the
  # rails (no push/systemctl/rm -rf/.env) survive.
  # -x/-y: a detached session defaults to 80x24. A long brief then overflows the
  # composer, its tail is never on screen, and fm_send_submit's needle check can
  # never match — the launcher declares success while the brief sits unsubmitted
  # and the build stays dark. Give the composer room to be seen.
  # AUTH FALLBACK. Stripping the env token is only correct while the login file
  # holds a LIVE login. A stale file (e.g. synced from another machine) beside a
  # working env token 401s at launch, and looks like a phantom permission dialog.
  # So: strip only when the file is live. When it is expired/absent but the env
  # token exists, KEEP the env token — the build runs, RC stays dark for that
  # session, and the event log says so out loud. When BOTH are dead, refuse to
  # launch into a guaranteed 401 (no pane exists yet, so releasing the registry
  # entry is safe).
  AUTH_STRIP="env -u CLAUDE_CODE_OAUTH_TOKEN "
  # AUTH_ENV closes the fallback's real gap: the pane inherits the tmux SERVER's
  # environment, not build_start's, and the server global env may carry no
  # token. Checking $CLAUDE_CODE_OAUTH_TOKEN here proves nothing about what the
  # pane will see — the token must be injected explicitly via `new-session -e`
  # (tmux ≥3.2) or the fallback 401s anyway.
  AUTH_ENV=()
  # Read for a yes/no on expiry only; nothing from the file is ever printed.
  CLAUDE_CREDS_FILE="$HOME/.claude/.credentials.json"
  creds_live() {
    python3 - "$CLAUDE_CREDS_FILE" <<'PY' 2>/dev/null || echo no
import json, sys, time
try:
    c = json.load(open(sys.argv[1])).get("claudeAiOauth", {})
    e = c.get("expiresAt", 0)
    e = e / 1000 if e > 1e12 else e
    print("yes" if e > time.time() + 300 else "no")
except Exception:
    print("no")
PY
  }
  CREDS_LIVE="$(creds_live)"
  # An EXPIRED access token is normal — the OAuth access token is short-lived and
  # the CLI only refreshes it on use. Refusing here raises false "/login owed"
  # alarms while the refresh token is fine. So nudge one tiny CLI call to
  # refresh, then re-check before refusing.
  if [ "$CREDS_LIVE" != "yes" ]; then
    timeout 90 env -u CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_BIN" -p "ok" --model claude-haiku-5-5 >/dev/null 2>&1 || true
    CREDS_LIVE="$(creds_live)"
    [ "$CREDS_LIVE" = "yes" ] && fm_event "$BUILD_ID" "auth-refreshed" "credentials.json was expired; CLI refresh succeeded before launch — no /login needed."
  fi
  if [ "$CREDS_LIVE" != "yes" ]; then
    if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      AUTH_STRIP=""
      AUTH_ENV=(-e "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}")
      fm_event "$BUILD_ID" "auth-fallback" "credentials.json expired/absent — launching with env CLAUDE_CODE_OAUTH_TOKEN instead. RC will be DARK for this session (expect rc-missing below; it is explained, not mysterious). A one-time /login on this box restores RC for future builds."
    else
      fm_event "$BUILD_ID" "launch-failed" "credentials.json expired/absent AND no CLAUDE_CODE_OAUTH_TOKEN in env — refusing to launch into a guaranteed 401. Run /login on this box."
      fm_event "$BUILD_ID" "status:failed" "never launched; workdir claim released"
      echo "LAUNCH FAILED: $BUILD_ID — no live Claude credential (file expired, no env token). Run /login." >&2
      exit 1
    fi
  fi
  fm_tmux_placement_or_refuse
  tmux new-session -d -s "$TMUX_SESSION" -c "$WORKDIR" -x 200 -y 50 "${AUTH_ENV[@]}" \
    "$HOLD_LOCK $LOCK $BUILD_ID ${AUTH_STRIP}$CLAUDE_BIN --permission-mode bypassPermissions --model $MODEL${EFFORT:+ --effort $EFFORT} --remote-control $TMUX_SESSION"
  [ -z "$ITEM_KEY" ] || fm_item_claim_release
  sleep 15

  # FOLDER-TRUST DIALOG — handled FIRST, and explicitly. Claude Code shows it for
  # any workdir it has not opened before, which is EVERY new lane, every fresh
  # worktree and every throwaway test dir. Its accept option is "Yes, I trust
  # this folder"; ESCAPE IS "No, exit", so a generic Escape loop answers it
  # wrong, claude dies, and the launcher registers a build with no session.
  #
  # Answering it here rather than pre-seeding trust in ~/.claude.json is
  # deliberate: there is no --trust flag (only headless -p skips the dialog), the
  # config key is an undocumented private schema, and it lives outside this repo.
  # Nothing is being widened either — the workdir is one the foreman named and
  # build_start just created, and the session already runs bypassPermissions.
  #
  # NEEDLE IS THE OPTION TEXT, not the question: it is gone once accepted, so it
  # cannot re-match later and fire a stray Enter into a live composer.
  for _ in 1 2 3; do
    _TP="$(tmux capture-pane -t "$TMUX_SESSION" -p)"
    printf '%s' "$_TP" | grep -q "Yes, I trust this folder" || break
    # Some CLI versions list "❯ No, exit" FIRST, so a bare Enter quits. Move the
    # cursor to "Yes" when it sits on "No".
    if printf '%s' "$_TP" | grep -q "❯ No, exit"; then
      tmux send-keys -t "$TMUX_SESSION" Down; sleep 1
    fi
    tmux send-keys -t "$TMUX_SESSION" Enter; sleep 3
  done

  # Bypass-mode acknowledgement dialog (option 2 = accept). Must be handled
  # BEFORE the generic Escape loop — Escape on THIS dialog exits claude.
  #
  # THE NEEDLE REQUIRES A DIALOG AFFORDANCE. A bare case-insensitive match on
  # "bypass permissions" also matches the HEALTHY FOOTER ("⏵⏵ bypass permissions
  # on (shift+tab to cycle)"), present on every started session — so it would
  # type a stray "2", re-match the same footer, and press Enter, submitting "2"
  # as the build's first message. Match the chooser, never the banner. "Enter to
  # confirm" appears only on a live dialog.
  PANE="$(tmux capture-pane -t "$TMUX_SESSION" -p)"
  if printf '%s' "$PANE" | grep -qi "bypass permissions" && printf '%s' "$PANE" | grep -q "Enter to confirm"; then
    tmux send-keys -t "$TMUX_SESSION" "2"; sleep 2
    PANE="$(tmux capture-pane -t "$TMUX_SESSION" -p)"
    if printf '%s' "$PANE" | grep -qi "bypass permissions" && printf '%s' "$PANE" | grep -q "Enter to confirm"; then
      tmux send-keys -t "$TMUX_SESSION" Enter; sleep 2
    fi
  fi

  # Remaining one-time onboarding/feature dialogs (renderer opt-in, ...) are
  # dismissed with Escape. GUARDED: if the trust dialog is somehow still up,
  # Escape would answer "No, exit" — refuse to touch the pane and fail loudly
  # instead of killing the session and leaving a record behind.
  if tmux capture-pane -t "$TMUX_SESSION" -p | grep -q "Yes, I trust this folder"; then
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    fm_event "$BUILD_ID" "launch-blocked" "folder-trust dialog would not accept — refusing to Escape it (that answers 'No, exit')"
    fm_event "$BUILD_ID" "status:failed" "never launched; workdir claim released"
    echo "LAUNCH BLOCKED: $BUILD_ID — the folder-trust dialog for $WORKDIR did not accept." >&2
    echo "                Session killed, registration released, nothing started." >&2
    exit 1
  fi
  for _ in 1 2; do
    if tmux capture-pane -t "$TMUX_SESSION" -p | grep -qE "Enter to confirm|❯ 1\."; then
      tmux send-keys -t "$TMUX_SESSION" Escape; sleep 3
    fi
  done

  # Remote Control registration check.
  #
  # Registration is ASYNCHRONOUS. A one-shot grep for the claude.ai URL right
  # after launch is a race that always loses, so it alarmed "rc-missing" on
  # every build while RC was working — an alarm that fires every time carries
  # zero information, and a genuine failure looks identical. The URL also prints
  # once in the footer and SCROLLS AWAY, so its absence means nothing.
  #
  # THE REAL SIGNAL is the CLI's own status line. A registered session renders
  # "/rc active" at the right edge of the footer, and it STAYS THERE for the life
  # of the session — that is what makes it pollable instead of a race. Verify a
  # signal in both directions (present on a registered build, absent on a plain
  # tmux session) before trusting it, and never ship a comment claiming a check
  # works without grepping events.jsonl to prove it.
  RC_URL=""
  RC_ACTIVE=""
  for _ in $(seq 1 10); do
    RC_PANE="$(tmux capture-pane -t "$TMUX_SESSION" -p 2>/dev/null || true)"
    # The URL is a BONUS (cross-device link), never a verdict.
    if [ -z "$RC_URL" ]; then
      RC_URL="$(printf '%s' "$RC_PANE" | grep -oE 'https://claude\.ai/code/[a-zA-Z0-9_]+' | head -1 || true)"
    fi
    RC_ACTIVE="$(printf '%s' "$RC_PANE" | grep -oE '/rc active' | head -1 || true)"
    if [ -n "$RC_ACTIVE" ]; then break; fi
    sleep 2
  done
  if [ -n "$RC_ACTIVE" ] && [ -n "$RC_URL" ]; then
    fm_event "$BUILD_ID" "rc-url" "$RC_URL"
  elif [ -n "$RC_ACTIVE" ]; then
    fm_event "$BUILD_ID" "rc-connected" "status line reads /rc active — session is registered. No claude.ai URL in the pane, which is normal: the footer link scrolls away and its absence is NOT a failure."
  else
    fm_event "$BUILD_ID" "rc-missing" "no '/rc active' in the status line after 20s — session is probably local-only and will NOT appear in the owner's Claude apps."
  fi

  # See the codex branch below: "started" is only honest if the brief actually
  # went in. A phantom started-but-dead build holds the workdir against the
  # collision guard and keeps the chain from waking.
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    # RELEASE THE CLAIM. The session is already proven gone, so the kernel lock is
    # already released — but the REGISTRY entry would stay "active" forever and
    # hold the workdir against every future start, curable only by a human
    # noticing and running build_done.sh. A claim that outlives its build is the
    # exact failure this whole guard exists to prevent, so build_start closes
    # what build_start opened. Deliberately NOT done on the submit-failed and
    # launch-blocked paths below: those leave a LIVE pane in the workdir, and
    # freeing the lane under a running process is how collisions happen.
    fm_event "$BUILD_ID" "launch-failed" "claude exited during startup — no session to submit into"
    fm_event "$BUILD_ID" "status:failed" "never launched; workdir claim released"
    echo "LAUNCH FAILED: $BUILD_ID — claude died at startup. Nothing started." >&2
    exit 1
  fi
  if fm_send_submit "$TMUX_SESSION" "$BRIEF" "$RUNTIME" "$WORKDIR"; then
    fm_event "$BUILD_ID" "started" "runtime=claude model=$MODEL effort=${EFFORT:-default}${EFFORT_REQUESTED:+ effort_asked=$EFFORT_REQUESTED} agent=$AGENT tmux=$TMUX_SESSION workdir=$WORKDIR"
  else
    # A submit failure is a PHANTOM only when the session is gone. Distinguish,
    # because the two cases need opposite handling:
    #   GONE  → the runtime died. Release the claim. A build record that outlives
    #           its session is a ghost claim — the exact failure the workdir lock
    #           exists to prevent.
    #   ALIVE → a real runtime is sitting in that workdir with a wedged composer.
    #           The record is ACCURATE; hold the lane and let a human decide.
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      fm_event "$BUILD_ID" "submit-failed" "composer still holds the brief after 3 Enters — session is idle, not working"
      echo "SUBMIT FAILED: $BUILD_ID — brief never went in; session is ALIVE and still holds $WORKDIR." >&2
      echo "               Inspect: tmux attach -rt $TMUX_SESSION" >&2
      echo "               Close:   $FOREMAN_ROOT/bin/build_done.sh $BUILD_ID abandoned" >&2
    else
      fm_event "$BUILD_ID" "submit-failed" "runtime died during submit — no session left"
      fm_event "$BUILD_ID" "status:failed" "never ran; workdir claim released"
      echo "SUBMIT FAILED: $BUILD_ID — runtime died during submit. Registration released, nothing started." >&2
    fi
    exit 1
  fi
  echo "BUILD_ID=$BUILD_ID"
  [ -n "$RC_URL" ] && echo "watch anywhere: $RC_URL (also in the Claude mobile app → Code tab)"
  echo "watch (terminal): tmux attach -rt $TMUX_SESSION"

else
  # Codex lane. Sessions land in $CODEX_HOME/sessions (the store the Codex apps
  # read). Wake loop: codex `notify` hook fires our shim on turn completion; the
  # shim reuses the hardened foreman_wake pipeline (locks, backoff-retry, stall
  # cap) via synthesized hook JSON.
  # Uses $CODEX_BIN explicitly — the tmux server's PATH may resolve a stale
  # binary. The path is NOT written twice: the existence probe reads the same
  # variable, so it is structurally impossible for the probe to clear a binary
  # this line does not run.
  # -x/-y: see the claude branch above — 80x24 hides the composer tail and
  # defeats submit verification on any long brief.
  CODEX_NOTIFY="$FOREMAN_ROOT/bin/foreman_codex_notify.sh"
  fm_tmux_placement_or_refuse
  tmux new-session -d -s "$TMUX_SESSION" -c "$WORKDIR" -x 200 -y 50 \
    "umask 077; exec $HOLD_LOCK $LOCK $BUILD_ID $CODEX_BIN -m $MODEL -c 'features.shell_snapshot=false' -c 'notify=[\"$CODEX_NOTIFY\",\"$BUILD_ID\"]' -c 'projects.\"$WORKDIR\".trust_level=\"trusted\"'${EFFORT:+ -c 'model_reasoning_effort=\"$EFFORT\"'}"
  [ -z "$ITEM_KEY" ] || fm_item_claim_release
  sleep 15

  # Codex startup dialog guard. On a new upstream release the TUI can open on an
  # "Update available" chooser whose FIRST option is "Update now" — which shells
  # out to the installer and then EXITS codex. The pane is the session's only
  # process, so the session dies with it: build_start would print "started", the
  # heartbeat later finds "tmux session gone", and nothing ever ran.
  # "3" = skip until next version, and the DIGIT ALONE commits it (the chooser
  # records the dismissed version in $CODEX_HOME/version.json). So do NOT send
  # Enter afterwards: the selector sits on option 1 = "Update now", and "3" then
  # Enter has killed sessions within seconds. Digit only.
  # NEEDLE IS THE CHOOSER'S OWN PROMPT LINE, not "Update available" — that string
  # survives as an informational banner after dismissal, and matching it would
  # type a stray "3" into a live composer and submit it as the build's message.
  for _ in 1 2; do
    if tmux capture-pane -t "$TMUX_SESSION" -p | grep -qE "Press enter to continue"; then
      tmux send-keys -t "$TMUX_SESSION" "3"; sleep 5
    fi
  done

  # LAUNCH VERIFICATION. The keystrokes above are a guess about a dialog that
  # only appears on an upstream release day, so do not trust them — verify the
  # outcome instead. Two dead-stops, both of which would otherwise be logged as
  # "started" on a session that does not exist:
  #   1. pane process gone  → the dismissal (or the launch) killed codex
  #   2. chooser still up   → typing a multi-KB brief into a menu is how the
  #                           installer gets selected
  # Fail loudly and leave NO "started" event; the queue must see this as unbuilt.
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    # See the claude branch: the session is proven gone, so release the registry
    # claim too rather than leaving an unclosable phantom holding the workdir.
    fm_event "$BUILD_ID" "launch-failed" "codex exited during startup — no session to submit into"
    fm_event "$BUILD_ID" "status:failed" "never launched; workdir claim released"
    echo "LAUNCH FAILED: $BUILD_ID — codex died at startup (update chooser?). Nothing started." >&2
    exit 1
  fi
  if tmux capture-pane -t "$TMUX_SESSION" -p | grep -qE "Press enter to continue"; then
    # Kill the session and release the claim. A live pane with no runtime turn
    # holds the workdir lock AND keeps a registration that nothing will ever
    # close — a ghost claim by a different door. The events ledger below records
    # why it failed; that is the diagnostic. Nothing started, so nothing is left.
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    fm_event "$BUILD_ID" "launch-blocked" "startup dialog still on screen after dismissal — refusing to type the brief into a menu"
    fm_event "$BUILD_ID" "status:failed" "never launched; workdir claim released"
    echo "LAUNCH BLOCKED: $BUILD_ID — startup dialog would have eaten the brief." >&2
    echo "                Session killed, registration released, nothing started." >&2
    exit 1
  fi

  if fm_send_submit "$TMUX_SESSION" "$BRIEF" "$RUNTIME" "$WORKDIR"; then
    fm_event "$BUILD_ID" "started" "runtime=codex model=$MODEL effort=${EFFORT:-default}${EFFORT_REQUESTED:+ effort_asked=$EFFORT_REQUESTED} agent=$AGENT tmux=$TMUX_SESSION workdir=$WORKDIR"
    # LIVE VIEW. Codex creates the session's rollout file only when the brief is
    # submitted, so record which file it is now — a UI can tail it to show this
    # build live. Background and bounded (fm_codex_rollout.py waits <=120s,
    # appends ONE codex-rollout event, always exits 0): it can neither delay nor
    # fail the launch. If it never runs, a reader can find the same file by
    # workdir + start time.
    if [ -x "$FOREMAN_ROOT/bin/fm_codex_rollout.py" ]; then
      setsid python3 -B "$FOREMAN_ROOT/bin/fm_codex_rollout.py" record "$BUILD_ID" </dev/null >/dev/null 2>&1 &
      disown 2>/dev/null || true
    fi
  else
    # NEVER emit "started" after an unverified Codex submit. Kill the throwaway
    # pane and close the registry claim: an idle pane holding an unsent brief is
    # not a build and must not occupy the lane until somebody notices it.
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
      fm_event "$BUILD_ID" "launch-blocked" "codex submission not verified — session killed, claim released"
    else
      fm_event "$BUILD_ID" "launch-blocked" "codex submission not verified — runtime already gone"
    fi
    fm_event "$BUILD_ID" "status:failed" "never ran; workdir claim released"
    echo "LAUNCH BLOCKED: $BUILD_ID — Codex submission was not positively verified." >&2
    echo "                Session killed, registration released, nothing started." >&2
    exit 1
  fi
  echo "BUILD_ID=$BUILD_ID"
  # FM_APP_URL (optional): a web UI that shows builds; printed only when configured.
  [ -n "${FM_APP_URL:-}" ] && echo "watch anywhere: $FM_APP_URL/#builds/bld-$BUILD_ID"
  echo "watch (terminal): tmux attach -rt $TMUX_SESSION"
fi
