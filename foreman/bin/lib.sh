#!/usr/bin/env bash
# Foreman shared helpers. Sourced by all foreman scripts.
#
# LEDGER DESIGN: the ledger is APPEND-ONLY and lives outside every caching
# process. Per build: meta.json (written exactly once at create), events.jsonl
# (append-only, >> only). Status is DERIVED from the last status:* event — there
# is no status file to rewrite, so there is nothing a whole-file-rewriting
# process can clobber. The gateway process never opens these files.

# ── Paths: the one contract every foreman script relies on ─────────────────
# Every location is an env var with a default under $AHI_HOME, so an install
# anywhere works without editing a script. Exported because the python helpers
# (fm_wake_state.py, fm_status.py, fm_brief.py, …) read the same names.
# FM_AHI_HOME wins over AHI_HOME: set it when the host app's AHI_HOME is not the folder that holds
# foreman/ (AHI Setup installs the foreman in AHI_OS/ while its server runs with AHI_HOME=<AHI>).
AHI_HOME="${FM_AHI_HOME:-${AHI_HOME:-$HOME/ahi}}"
FOREMAN_ROOT="${FOREMAN_ROOT:-$AHI_HOME/foreman}"
FM_GATEWAY_DIR="${FM_GATEWAY_DIR:-$AHI_HOME/gateway}"      # the gateway source/install tree
FM_WORKTREES_DIR="${FM_WORKTREES_DIR:-$AHI_HOME/builds}"   # where build copies / worktrees live
FM_LOG_DIR="${FM_LOG_DIR:-$AHI_HOME/state/logs}"
FM_STATE_DIR="${FM_STATE_DIR:-$AHI_HOME/state/foreman}"    # timeline and other foreman runtime state
FM_LIVE_REGISTRY="${FM_LIVE_REGISTRY:-$FOREMAN_ROOT/builds}"
BUILDS_DIR="${BUILDS_DIR:-$FOREMAN_ROOT/builds}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:18789}"
export AHI_HOME FOREMAN_ROOT FM_GATEWAY_DIR FM_WORKTREES_DIR FM_LOG_DIR FM_STATE_DIR \
       FM_LIVE_REGISTRY BUILDS_DIR GATEWAY_URL

# The claude binary every launcher and check uses. A native install under
# ~/.local/bin is preferred because a stale package-manager copy can own PATH.
fm_claude_bin() {
  if [ -n "${AHI_FM_CLAUDE_BIN:-}" ]; then echo "$AHI_FM_CLAUDE_BIN"
  elif [ -x "$HOME/.local/bin/claude" ]; then echo "$HOME/.local/bin/claude"
  else command -v claude 2>/dev/null || echo claude
  fi
}

# Every open work order in QUEUE.md, one per line. A work order is an UNCHECKED
# task line ("- [ ] do the thing") and nothing else, so a separator or a line of
# prose can never be read as an order. The chain, the heartbeat and desks share it.
fm_queue_open() {
  [ -f "$FOREMAN_ROOT/QUEUE.md" ] || return 0
  grep -E '^[[:space:]]*-[[:space:]]*\[[[:space:]]\]' "$FOREMAN_ROOT/QUEUE.md" || true
}

# Append one event to a build's ledger. Args: build_id, type, detail(optional)
fm_event() {
  local id="$1" type="$2" detail="${3:-}"
  python3 - "$BUILDS_DIR/$id/events.jsonl" "$type" "$detail" <<'PY'
import json, sys, time
path, etype, detail = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "a") as f:
    f.write(json.dumps({"ts": int(time.time()), "type": etype, "detail": detail}) + "\n")
PY
}

# Derived status: last status:* event, else "active".
fm_status() {
  local id="$1"
  python3 - "$BUILDS_DIR/$id/events.jsonl" <<'PY'
import json, sys
status = "active"
try:
    for line in open(sys.argv[1]):
        e = json.loads(line)
        if e["type"].startswith("status:"):
            status = e["type"].split(":", 1)[1]
except FileNotFoundError:
    status = "unknown"
print(status)
PY
}

fm_meta() { # build_id, key
  python3 -c "import json,sys; print(json.load(open('$BUILDS_DIR/$1/meta.json'))[sys.argv[1]])" "$2"
}

# The gateway bearer token: $FM_GATEWAY_TOKEN if set, else the token of the
# first user with "admin": true in $FM_GATEWAY_DIR/config/users.json (a list, or
# {"users": …}). Prints the token for the calling curl/python only — never log
# or echo it. Prints nothing (rc 0) when there is none, so a caller under
# `set -e` never dies here; callers then refuse to POST and log why.
fm_token() {
  if [ -n "${FM_GATEWAY_TOKEN:-}" ]; then printf '%s\n' "$FM_GATEWAY_TOKEN"; return 0; fi
  FM_USERS_JSON="${FM_USERS_JSON:-$FM_GATEWAY_DIR/config/users.json}" python3 - <<'PY' 2>/dev/null || true
import json, os
try:
    d = json.load(open(os.environ["FM_USERS_JSON"]))
except Exception:
    raise SystemExit(0)
users = d["users"] if isinstance(d, dict) and "users" in d else d
if isinstance(users, dict): users = list(users.values())
if not isinstance(users, list): raise SystemExit(0)
for u in users:
    if isinstance(u, dict) and u.get("admin") is True:
        tok = u.get("token") or u.get("bearer_token") or u.get("bearerToken")
        if tok:
            print(tok)
            break
PY
}

# ── WHICH REGISTRY AM I OPERATING ON? ─────────────────────────────────────
# ONE definition of "this is the live system", used by every guard that needs
# it. Copies of an inline check at each caller cannot be proven complete — a
# sandboxed close once declined to touch the live registry and then rang the
# real wake anyway, because the notify path never got a copy. So the question
# "am I live" is answered here, at the chokepoint, and only here.
#
# FM_LIVE_REGISTRY is a PARAMETER, not a bypass: it names which path counts as
# live, defaults to the real one, and exists so a test can build a fake-live
# registry and exercise the DELIVERING branch with byte-identical code. A flag
# that said "skip the check" would be a bypass; this one cannot make the live
# registry stop being live. (Default set in the path block above.)
fm_is_live() {
  [ "$(fm_resolve_workdir "$BUILDS_DIR")" = "$(fm_resolve_workdir "$FM_LIVE_REGISTRY")" ]
}

# ── SERIALIZE FOREMAN WAKES AT THE CHOKEPOINT ─────────────────────────────
# Two wake sources (the idle stop-hook and the close chain) can fire seconds
# apart at a build's close; each would make the gateway resume the SAME
# supervisor session, giving two concurrent writers to one conversation. The
# per-build fm_wake_lock_* cannot catch it — the sources differ. Every wake
# passes through fm_wake_michael, so serialization lives HERE, once, where no
# caller can route around it. Two signals, each covering the other's blind spot:
#   (1) IN-FLIGHT — is a `claude … --resume <michael-session-id>` running right
#       now? Matches ps LINES for specific session ids (never a count, never a
#       bare `--resume` that would false-refuse a Tzali/Avi resume); our own pid
#       tree is excluded so the probe cannot match itself.
#   (2) a short SETTLE timestamp — covers only the seconds between the POST and
#       the resume appearing in ps. Small on purpose, so a legitimate SEQUENTIAL
#       wake is not refused; the in-flight check guards long resumes.
#
# FAIL-OPEN is the law of this function: a lock it cannot take, a dir it cannot
# make, a ps it cannot run — every one PROCEEDS with the wake. A guard that could
# silence the foreman's only wake source is worse than the collision it prevents.
# A refusal is never silent: the payload is preserved in refused-wakes.log and
# the caller gets a labelled JSON marker, so nothing is lost, only deferred.
FM_WAKE_SETTLE="${FM_WAKE_SETTLE:-10}"
# Defined before first use: build_start.sh sources this file under `set -u`.
FM_LOCKS_DIR="${FM_LOCKS_DIR:-$FOREMAN_ROOT/locks}"
FM_WAKE_GLOBAL_LOCK="${FM_WAKE_GLOBAL_LOCK:-$FM_LOCKS_DIR/foreman-wake.lock}"
FM_WAKE_TS_FILE="${FM_WAKE_TS_FILE:-$FM_LOCKS_DIR/foreman-wake.ts}"
FM_WAKE_GUARD_LOG="${FM_WAKE_GUARD_LOG:-$FOREMAN_ROOT/refused-wakes.log}"
FM_WAKE_FAIL_LOG="${FM_WAKE_FAIL_LOG:-$FOREMAN_ROOT/failed-wakes.log}"
FM_SESSIONS_JSON="${FM_SESSIONS_JSON:-$AHI_HOME/state/sessions.json}"

# Is a claude process resuming a MICHAEL/foreman session running right now?
# Echoes "yes" | "no". Fail-open ⇒ "no" (never manufacture a refusal on error).
fm_foreman_resume_inflight() {
  local ids psout self=$$ ppid=$PPID sid line pid
  ids="$(FM_SESSIONS_JSON="$FM_SESSIONS_JSON" python3 - <<'PY' 2>/dev/null
import json, os
seen=set()
try:
    d=json.load(open(os.environ["FM_SESSIONS_JSON"]))
except Exception:
    d={}
for v in (d.values() if isinstance(d,dict) else []):
    if isinstance(v,dict) and v.get("botName")=="michael":
        sid=v.get("claudeSessionId")
        if sid: seen.add(sid)
print("\n".join(sorted(seen)))
PY
)"
  [ -z "$ids" ] && { echo "no"; return 0; }
  psout="$(ps -eo pid=,args= 2>/dev/null)" || { echo "no"; return 0; }
  while IFS= read -r sid; do
    [ -z "$sid" ] && continue
    while IFS= read -r line; do
      pid="${line%%[![:space:]]*}"; pid="${line#"$pid"}"; pid="${pid%% *}"
      [ "$pid" = "$self" ] && continue
      [ "$pid" = "$ppid" ] && continue
      case "$line" in
        *"--resume"*"$sid"*) echo "yes"; return 0;;
      esac
    done <<EOF_PS
$psout
EOF_PS
  done <<EOF_IDS
$ids
EOF_IDS
  echo "no"
}

# Decide whether THIS wake may fire. rc 0 = proceed (and stamps the ts under the
# lock); rc 1 = refuse. Any error ⇒ rc 0 (fail-open). The check-and-stamp is done
# under a global flock so two truly-simultaneous callers cannot both read "clear".
fm_foreman_wake_guard() {
  mkdir -p "$FM_LOCKS_DIR" 2>/dev/null || return 0
  # The brace group scopes 2>/dev/null to this one open. A bare
  # `exec 8>>file 2>/dev/null` would ALSO redirect the calling shell's stderr to
  # /dev/null for the rest of its life, silencing every later error message.
  { exec 8>>"$FM_WAKE_GLOBAL_LOCK"; } 2>/dev/null || return 0
  flock -w 5 8 2>/dev/null || { exec 8>&-; return 0; }
  local now ts age inflight
  now="$(date +%s)"
  ts="$(cat "$FM_WAKE_TS_FILE" 2>/dev/null || echo 0)"
  case "$ts" in ''|*[!0-9]*) ts=0;; esac
  age=$(( now - ts ))
  inflight="$(fm_foreman_resume_inflight)"
  # The --resume probe above is blind to a brand-new supervisor session and to
  # any session absent from sessions.json. Process shape catches what session
  # identity cannot.
  [ "$inflight" = "yes" ] || inflight="$(fm_michael_supervisor_inflight)"
  if [ "$age" -lt "$FM_WAKE_SETTLE" ] || [ "$inflight" = "yes" ]; then
    exec 8>&-
    return 1
  fi
  # FM_WAKE_GUARD_PEEK asks the SAME question without taking the slot — a hook deciding "send now, or hold in the build's slot?" must not
  # stamp the settle clock, or the real send a moment later refuses itself.
  [ -n "${FM_WAKE_GUARD_PEEK:-}" ] || printf '%s' "$now" > "$FM_WAKE_TS_FILE" 2>/dev/null || true
  exec 8>&-
  return 0
}

# ══ DUPLICATE-SUPERVISOR CONTAINMENT — DETECTION *AND* REPLAY ════════════════
# Why the session-id guard above is not enough on its own:
#   - a brand-new supervisor turn carries NO `--resume` flag (the gateway adds it
#     only when continuing a session), so it is invisible to a `--resume <sid>`
#     probe for its whole duration;
#   - the gateway's session map can lose the supervisor's key entirely (a
#     context clear deletes it), so the one chat that produces supervisors is
#     the one the map cannot name.
#
# DETECTION AND REPLAY SHIP TOGETHER. Detection alone turns a duplicate-
# supervisor bug into a DROPPED-WAKE bug — a refusal nobody replays, a stop-hook
# that fires once — and a dark chain is the more expensive failure. So:
# refuse => queue => drain. A refusal here is a DEFERRAL.
#
# KILL SWITCH: FM_CONC_DISABLE=1 makes every function below inert and restores
# the session-id-only behaviour without touching a file.

FM_PENDING_DIR="${FM_PENDING_DIR:-$FOREMAN_ROOT/pending-wakes}"
FM_PENDING_MAX="${FM_PENDING_MAX:-50}"

# Is a MICHAEL SUPERVISOR live right now, by PROCESS SHAPE rather than by
# session id? Echoes "yes" | "no". Fail-open => "no" (never manufacture a
# refusal out of an error).
#
# THE TELL never appears in argv, so the detector cannot match itself: the
# pattern is absent from every process-table row this function creates. Closed
# by construction, not by a pid exclusion list.
#
# ANCESTORS ARE DELIBERATELY *NOT* EXCLUDED. A wake fired from inside a live
# supervisor's own process tree is exactly the wake that would spawn a second
# writer on that supervisor's transcript. Deferring it is correct; the drain
# below delivers it once the tree is gone. The safe direction here is to refuse.
fm_michael_supervisor_inflight() {
  [ -n "${FM_CONC_DISABLE:-}" ] && { echo "no"; return 0; }
  local psout
  psout="$(eval "${FM_PS_CMD:-ps -eo pid=,args=}" 2>/dev/null)" || { echo "no"; return 0; }
  # The table travels by ENVIRONMENT, not stdin and not argv. Not stdin, because
  # a heredoc script already owns stdin and would silently read an empty table —
  # a detector that always answers "no" is the failure this whole gate exists to
  # stop, and it is invisible unless something asserts the positive case. Not
  # argv, because `ps -eo args` would then show the tell on the detector's own
  # row. (Belt: the program-name test below cannot match `python3` regardless.)
  FM_SUP_TELL="${FM_SUP_TELL:-You are Michael}" FM_SUP_PS="$psout" python3 -c '
import os, sys
tell = os.environ.get("FM_SUP_TELL", "")
if not tell:
    print("no"); sys.exit(0)
for line in os.environ.get("FM_SUP_PS", "").splitlines():
    line = line.strip()
    if not line:
        continue
    pid, _, args = line.partition(" ")
    if not pid.isdigit() or not args:
        continue
    argv = args.split()
    if not argv:
        continue
    prog = os.path.basename(argv[0])
    # Program name, not a substring of the command line: `grep claude` is not a
    # supervisor and must never be counted as one.
    if prog != "claude":
        continue
    # Headless only. An interactive `claude` in a tmux build pane is an
    # EXECUTOR, not a supervisor, and never writes the Michael transcript.
    if "-p" not in argv and "--print" not in argv:
        continue
    if tell in args:
        print("yes"); sys.exit(0)
print("no")
' 2>/dev/null || echo "no"
}

# Queue a refused wake for replay. $1 = originating caller ($0 / BASH_SOURCE[1]
# as fm_wake_michael sees it). Payload on stdin.
#
# The header exists because THE DECLARATION MUST SURVIVE THE DEFERRAL. The
# briefing classifier reaches PROGRESS only by explicit declaration; if the
# replay lost FM_BRIEF_CLASS a deferred milestone would come back as INTERNAL —
# delivered but demoted, which is harder to notice than dropped.
fm_queue_pending_wake() {
  [ -n "${FM_CONC_DISABLE:-}" ] && { cat >/dev/null 2>&1; return 0; }
  local caller="${1:-}"
  mkdir -p "$FM_PENDING_DIR" 2>/dev/null || { cat >/dev/null 2>&1; return 0; }
  local n
  n="$(find "$FM_PENDING_DIR" -maxdepth 1 -name '*.wake' 2>/dev/null | wc -l | tr -d ' ')"
  case "$n" in ''|*[!0-9]*) n=0;; esac
  if [ "$n" -ge "$FM_PENDING_MAX" ]; then
    printf '[%s] PENDING QUEUE FULL (%s >= %s) — WAKE NOT QUEUED, THIS ONE IS LOST\n' \
      "$(date -Is)" "$n" "$FM_PENDING_MAX" >> "$FM_WAKE_GUARD_LOG" 2>/dev/null || true
    cat >/dev/null 2>&1
    return 0
  fi
  local f="$FM_PENDING_DIR/$(date +%s)-$$-${RANDOM}.wake"
  {
    printf '#FMPEND1\n'
    printf 'ts=%s\n'       "$(date +%s)"
    printf 'caller=%s\n'   "$caller"
    printf 'class=%s\n'    "${FM_BRIEF_CLASS:-}"
    printf 'category=%s\n' "${FM_BRIEF_CATEGORY:-}"
    printf 'build=%s\n'    "${FM_BRIEF_BUILD_ID:-}"
    printf 'producer=%s\n' "${FM_BRIEF_PRODUCER:-}"
    printf 'transport=%s\n' "${FM_BRIEF_TRANSPORT:-}"
    # heartbeat-owner: a wake QUEUED ON PURPOSE (not refused) says why, so the
    # replay does not claim a supervisor was live when none was.
    [ -z "${FM_PENDING_WHY:-}" ] || printf 'why=%s\n' "$(printf '%s' "$FM_PENDING_WHY" | tr '\n' ' ')"
    printf '#FMPEND-END\n'
    cat
  } > "$f.part" 2>/dev/null && mv "$f.part" "$f" 2>/dev/null || { rm -f "$f.part" 2>/dev/null; return 0; }
  return 0
}

# Deliver at most ONE deferred wake, oldest first. Called from the every-2-minute
# cron tick (fm_stop_watch.sh) — cron is a reliable wake fabric; ad-hoc
# sleep-watchers die silently. One per tick on purpose: each delivery re-arms
# FM_WAKE_SETTLE, so a burst is paced instead of being dumped into one turn.
#
# The same tick also delivers the per-build slots (fm_drain_build_slots, below),
# and the OLDEST held item goes first whichever store holds it.
# `fm_drain_pending_wakes <build>` is the targeted form: that build's slot only,
# never the FIFO. The slot half runs even under FM_CONC_DISABLE — the hooks hold
# wakes there whatever that switch says, so its drain must not share it
# (FM_WAKE_DEFER_DISABLE is its own).
fm_drain_pending_wakes() {
  local _fifo_first="" _c
  if [ -z "${FM_CONC_DISABLE:-}" ]; then
    for _c in "$FM_PENDING_DIR"/*.wake; do
      [ -f "$_c" ] || continue
      _fifo_first="$(basename "$_c")"; _fifo_first="${_fifo_first%%-*}"; break
    done
  fi
  fm_drain_build_slots "${1:-}" "$_fifo_first" && return 0
  [ -n "${1:-}" ] && return 0
  [ -n "${FM_CONC_DISABLE:-}" ] && return 0
  [ -d "$FM_PENDING_DIR" ] || return 0
  mkdir -p "$FM_PENDING_DIR/.inflight" 2>/dev/null || return 0
  local f=""
  # Filenames lead with epoch seconds, so lexical order IS chronological.
  for cand in "$FM_PENDING_DIR"/*.wake; do
    [ -f "$cand" ] || continue
    f="$cand"; break
  done
  [ -n "$f" ] || return 0
  # Atomic claim: mv is the lock. A second drainer loses the race and finds nothing.
  local claim="$FM_PENDING_DIR/.inflight/$(basename "$f")"
  mv "$f" "$claim" 2>/dev/null || return 0

  local hdr body qts qcaller qclass qcat qbuild qproducer qtransport qwhy age trailer
  hdr="$(sed -n '1,/^#FMPEND-END$/p' "$claim" 2>/dev/null)"
  case "$hdr" in
    '#FMPEND1'*) ;;
    *) # Not one of ours / truncated. Do not guess at a payload; park it.
       mv "$claim" "$claim.malformed" 2>/dev/null || true
       printf '[%s] DRAIN: malformed pending file parked: %s.malformed\n' \
         "$(date -Is)" "$claim" >> "$FM_WAKE_GUARD_LOG" 2>/dev/null || true
       return 0 ;;
  esac
  qts="$(printf '%s\n' "$hdr"      | sed -n 's/^ts=//p'       | head -1)"
  qcaller="$(printf '%s\n' "$hdr"  | sed -n 's/^caller=//p'   | head -1)"
  qclass="$(printf '%s\n' "$hdr"   | sed -n 's/^class=//p'    | head -1)"
  qcat="$(printf '%s\n' "$hdr"     | sed -n 's/^category=//p' | head -1)"
  qbuild="$(printf '%s\n' "$hdr"   | sed -n 's/^build=//p'    | head -1)"
  qproducer="$(printf '%s\n' "$hdr" | sed -n 's/^producer=//p' | head -1)"
  qtransport="$(printf '%s\n' "$hdr" | sed -n 's/^transport=//p' | head -1)"
  qwhy="$(printf '%s\n' "$hdr" | sed -n 's/^why=//p' | head -1)"
  body="$(sed -e '1,/^#FMPEND-END$/d' "$claim" 2>/dev/null)"
  case "$qts" in ''|*[!0-9]*) qts=0;; esac
  age=$(( $(date +%s) - qts ))
  [ "$qts" = 0 ] && age=0

  # The deferral is SAID OUT LOUD, at the end of the payload so no line-anchored
  # classifier rule shifts. A wake that arrives late without saying it was late
  # is a wake that lies about when its facts were true. The "(FM-15:" prefix is
  # matched by fm_brief.py (DEFERRAL_RE) — it is a marker, keep it verbatim.
  trailer="(note: this wake was DEFERRED ${age}s — a Michael supervisor was already live when it fired — and replayed by fm_drain_pending_wakes. Its facts were true ${age}s ago.)"
  [ -z "$qwhy" ] || trailer="(Queued by the foreman heartbeat ${age}s ago — $qwhy — and delivered by the drain. Its facts were true ${age}s ago.)"
  local out=""
  out="$(FM_DRAIN_REPLAY=1 \
         FM_BRIEF_CALLER="$qcaller" \
         FM_BRIEF_CLASS="$qclass" \
         FM_BRIEF_CATEGORY="$qcat" \
         FM_BRIEF_BUILD_ID="$qbuild" \
         FM_BRIEF_PRODUCER="lib.sh:deferred-replay" \
         FM_BRIEF_TRANSPORT="replay" \
         FM_BRIEF_ORIGIN_PRODUCER="$qproducer" \
         FM_BRIEF_ORIGIN_TRANSPORT="$qtransport" \
         fm_wake_michael <<EOF
$body

$trailer
EOF
)" || out=""

  case "$out" in
    *'"refused"'*|"")
      # Still blocked, or delivery failed. Re-queue under a fresh name, keeping
      # the ORIGINAL ts so the age keeps counting up and nothing resets its clock.
      local again="$FM_PENDING_DIR/$(date +%s)-$$-${RANDOM}.wake"
      {
        printf '#FMPEND1\nts=%s\ncaller=%s\nclass=%s\ncategory=%s\nbuild=%s\nproducer=%s\ntransport=%s\n' \
          "$qts" "$qcaller" "$qclass" "$qcat" "$qbuild" "$qproducer" "$qtransport"
        [ -z "$qwhy" ] || printf 'why=%s\n' "$qwhy"
        printf '#FMPEND-END\n'
        printf '%s' "$body"
      } > "$again.part" 2>/dev/null && mv "$again.part" "$again" 2>/dev/null
      rm -f "$claim" 2>/dev/null || true
      ;;
    *)
      rm -f "$claim" 2>/dev/null || true
      ;;
  esac
  return 0
}

# Wake Michael (the supervisor) through the gateway. Message on stdin.
# The message is captured in bash and handed to python via the ENVIRONMENT:
# a <<'PY' heredoc owns python's stdin, so sys.stdin.read() would always be
# empty and every wake would arrive blank.
fm_wake_michael() { # message on stdin
  local msg; msg="$(cat)"

  # ── A WAKE CARRIES ITS OWN PROVENANCE ────────────────────────────────────
  # A wake's claims ("zero builds active", "next item is X") must be checkable
  # from the message itself. Every wake states the registry it counted and the
  # queue it read, so a tired reader — or a script — can catch a false order.
  local prov="provenance: builds_dir=$BUILDS_DIR queue=${QUEUE:-<unset>} host=$(hostname -s 2>/dev/null || echo ?)"

  # ── A HARNESS MUST NOT BE ABLE TO WAKE THE FOREMAN ───────────────────────
  # Default is refusal, not labelling. Labelling alone would still put a message
  # in Michael's channel every time a test closes a build, and a channel that
  # cries wolf is how a real order gets skimmed. If a harness wake is genuinely
  # needed, FM_HARNESS_WAKE_ALLOW lets it through — and then it is unmistakably
  # marked in its FIRST LINE and stripped of anything that reads as an order.
  if ! fm_is_live; then
    if [ -z "${FM_HARNESS_WAKE_ALLOW:-}" ]; then
      printf '[%s] WAKE SUPPRESSED (harness registry) %s\n%s\n---\n' \
        "$(date -Is)" "$prov" "$msg" \
        >> "${FM_WAKE_LOG:-${FOREMAN_ROOT:-/tmp}/suppressed-wakes.log}"
      echo '{"ok":true,"suppressed":"harness-originated"}'
      return 0
    fi
    msg="⚠⚠ HARNESS-ORIGINATED MESSAGE — THIS IS NOT A CHAIN INSTRUCTION ⚠⚠
This did NOT come from the live foreman registry. Nothing in it is an order, no
build has actually closed in the live system, and no next item should be started
on the strength of it. It is a test harness reporting on its own fixtures.
$prov

--- harness payload follows, for information only ---
$msg"
  else
    msg="$msg

($prov)"
  fi

  # ── The concurrent-resume chokepoint (see the block above). ──
  # Only genuinely-concurrent (or spawn-latency-window) resumes are refused; a
  # refusal preserves the whole payload in refused-wakes.log and returns a
  # labelled marker, so the caller's `|| true` is undisturbed and nothing is lost.
  if ! fm_foreman_wake_guard; then
    # A DRAIN RETRY must not re-log the whole payload: while a supervisor is live
    # the drain re-attempts every tick and the log would grow by the full payload
    # each time. The payload is already held verbatim in the queue file, so a
    # retry gets one line. Every non-drain caller gets the full record.
    if [ -z "${FM_DRAIN_REPLAY:-}" ]; then
      printf '[%s] WAKE REFUSED (concurrent foreman resume in flight / within %ss settle) %s\n%s\n---\n' \
        "$(date -Is)" "$FM_WAKE_SETTLE" "$prov" "$msg" \
        >> "$FM_WAKE_GUARD_LOG" 2>/dev/null || true
    else
      printf '[%s] DRAIN RETRY still refused (supervisor live); payload held in %s\n' \
        "$(date -Is)" "$FM_PENDING_DIR" >> "$FM_WAKE_GUARD_LOG" 2>/dev/null || true
    fi
    # A REFUSAL IS A DEFERRAL, NOT A DROP. Queued here, re-delivered by
    # fm_drain_pending_wakes off the every-2-minute cron; a dark chain costs more
    # than a late wake. FM_DRAIN_REPLAY marks a wake that is ALREADY queued: the
    # drain owns its own re-queue.
    if [ -z "${FM_DRAIN_REPLAY:-}" ]; then
      printf '%s' "$msg" | fm_queue_pending_wake "${FM_BRIEF_CALLER:-${BASH_SOURCE[1]:-$0}}" || true
    fi
    echo '{"ok":true,"refused":"concurrent-foreman-resume"}'
    return 0
  fi

  # ── BRIEFING CONTRACT — ADDITIVE, FAIL-OPEN, ONE-FILE ROLLBACK ───────────
  # Placed AFTER both guards above, so the harness-suppression and refusal paths
  # (which `return 0` earlier) cannot be altered by it; their payloads stay
  # verbatim in suppressed-wakes.log and refused-wakes.log (BRIEFING-CONTRACT.md).
  #
  # FAIL-OPEN IS THE WHOLE POINT. fm_brief.py absent, unreadable, erroring,
  # timing out, or emitting anything not FRAMED (sentinel first line, end-marker
  # last line, non-empty body between) ⇒ $msg is untouched and the POST below is
  # the unformatted payload. A formatter that can silence the foreman's only wake
  # source is far worse than the noise it removes.
  #
  # Why framing rather than "output must contain the payload verbatim": the wire
  # carries a concise rendered body and the briefing ledger keeps the raw payload,
  # so containment would forbid exactly the thinning we want. Truncation, garbage,
  # a crash mid-write and an empty emit still fail the frame and fall open. What
  # the hook can no longer detect is a well-framed rewrite; the ledger records
  # `raw` and `wire` for every wake so that remains auditable.
  local _fmb="${FM_BRIEF:-$FOREMAN_ROOT/bin/fm_brief.py}"
  if [ -z "${FM_BRIEF_DISABLE:-}" ] && [ -r "$_fmb" ]; then
    local _briefed=""
    _briefed="$(printf '%s' "$msg" | \
      FOREMAN_ROOT="$FOREMAN_ROOT" \
      FM_BRIEF_LOG_DIR="${FM_BRIEF_LOG_DIR:-}" \
      FM_BRIEF_CALLER="${FM_BRIEF_CALLER:-${BASH_SOURCE[1]:-$0}}" \
      FM_BRIEF_CLASS="${FM_BRIEF_CLASS:-}" \
      FM_BRIEF_CATEGORY="${FM_BRIEF_CATEGORY:-}" \
      FM_BRIEF_BUILD_ID="${FM_BRIEF_BUILD_ID:-}" \
      timeout 5 python3 -B "$_fmb" classify \
        --origin-producer "${FM_BRIEF_ORIGIN_PRODUCER:-}" \
        --origin-transport "${FM_BRIEF_ORIGIN_TRANSPORT:-}" \
        2>/dev/null)" || _briefed=""
    case "$_briefed" in
      "#FMBRIEF1"$'\n'*$'\n'"#FMBRIEF-END")
        # Framing check: first line is the sentinel, last line is the end
        # marker. Command substitution has already stripped trailing newlines,
        # so the marker is the final bytes or the frame is broken.
        local _body="${_briefed#*$'\n'}"          # drop the sentinel line
        _body="${_body%$'\n'"#FMBRIEF-END"}"      # drop the end marker
        # An empty body is silence, not concision. Fall open.
        [ -n "${_body//[[:space:]]/}" ] && msg="$_body"
        ;;
    esac
  fi

  # ── DELIVERY: /foreman/wake if the gateway has it, else /ui/send ─────────
  # A gateway with a dedicated /foreman/wake endpoint runs the same Michael turn
  # /ui/send runs, but keeps the wake and Michael's reply on the build's timeline
  # instead of the owner's chat feed. A gateway without it answers 404/405 and
  # the wake goes to /ui/send (the standard endpoint). FM_WAKE_ENDPOINT=legacy
  # skips the probe and posts to /ui/send directly.
  # A wake that cannot be delivered (no gateway running, no token, refused) is
  # logged to $FM_WAKE_FAIL_LOG and returns 1; callers treat that as fail-open
  # and carry on — a missing gateway never stops a start, status or close.
  local token rc=0 err=""
  token="$(fm_token)"
  if [ -z "$token" ]; then
    printf '[%s] WAKE NOT SENT: no gateway token (set FM_GATEWAY_TOKEN, or add an admin user to %s/config/users.json) %s\n' \
      "$(date -Is)" "$FM_GATEWAY_DIR" "$prov" >> "$FM_WAKE_FAIL_LOG" 2>/dev/null || true
    echo "WAKE NOT SENT: no gateway token; logged to $FM_WAKE_FAIL_LOG" >&2
    return 1
  fi
  # The token travels by environment, never argv, so it cannot show up in `ps`.
  { err="$(FM_WAKE_MSG="$msg" FM_WAKE_TOKEN="$token" python3 - "$GATEWAY_URL" "${FM_WAKE_ENDPOINT:-quiet}" 2>&1 >&3 <<'PY'
import json, os, sys, urllib.error, urllib.request
base, mode = sys.argv[1], sys.argv[2]
token = os.environ.get("FM_WAKE_TOKEN", "")
text = os.environ["FM_WAKE_MSG"]
def post(path, extra):
    req = urllib.request.Request(
        base + path,
        data=json.dumps({"bot": "michael", "text": text}).encode(),
        headers={"Authorization": "Bearer " + token, "X-AHI-Token": token,
                 "Content-Type": "application/json", **extra},
    )
    return urllib.request.urlopen(req, timeout=30).read().decode()[:200]
try:
    if mode != "legacy":
        try:
            print(post("/foreman/wake", {"X-AHI-Foreman": "1"}))
            sys.exit(0)
        except urllib.error.HTTPError as e:
            if e.code not in (404, 405):
                raise
            print("WAKE: gateway has no /foreman/wake; falling back to /ui/send", file=sys.stderr)
    print(post("/ui/send", {}))
except SystemExit:
    raise
except Exception as e:
    print(f"WAKE-POST-FAILED: {e}", file=sys.stderr)
    sys.exit(1)
PY
)"; } 3>&1 || rc=$?
  [ -z "$err" ] || printf '%s\n' "$err" >&2
  if [ "$rc" -ne 0 ]; then
    printf '[%s] WAKE NOT DELIVERED (rc=%s) %s: %s\n' "$(date -Is)" "$rc" "$prov" \
      "$(printf '%s' "$err" | tail -1 | head -c 300)" >> "$FM_WAKE_FAIL_LOG" 2>/dev/null || true
  fi
  return "$rc"
}

# Last assistant text from a Claude Code transcript (for wake context).
fm_transcript_tail() { # transcript_path, max_chars
  python3 - "$1" "${2:-1200}" <<'PY'
import json, sys
path, maxc = sys.argv[1], int(sys.argv[2])
last = ""
try:
    for line in open(path, errors="replace"):
        try: rec = json.loads(line)
        except: continue
        msg = rec.get("message") or {}
        if rec.get("type") == "assistant" and isinstance(msg.get("content"), list):
            texts = [c.get("text", "") for c in msg["content"] if c.get("type") == "text"]
            if any(texts): last = "\n".join(t for t in texts if t)
except FileNotFoundError:
    pass
print(last[-maxc:])
PY
}

# ── Workdir claim lock ─────────────────────────────────────────────────────
# Deciding "is this workdir free?" by scanning the registry and registering
# afterwards leaves a window — seconds wide, not milliseconds — in which two
# starts (e.g. two foremen woken on one queue line) both read "free" and both
# proceed into the same workdir.
#
# The primitive is flock(2), keyed on the RESOLVED workdir path:
#   * atomic       — the kernel decides the winner, not a read-then-write
#   * self-releasing — the lock dies with the open file description, so process
#                    exit, SIGKILL, a killed tmux and a reboot all release it
#                    identically. Nothing on disk carries a claim, so there is
#                    no reaper to write and no staleness rule to get wrong.
# Contrast fm_wake_lock_* below, which is a timestamp + expiry — i.e. exactly the
# reaper pattern this deliberately avoids. That one can go stale; this one cannot.
#
# LIFETIME, in two phases, because a lock cannot be inherited through tmux (the
# tmux SERVER forks the pane, not our shell, so our descriptors never reach it):
#   phase 1  build_start.sh holds it across check + registration, then closes it
#   phase 2  the pane process re-takes it via fm_hold_lock.sh and holds it for
#            the life of the session
# The handoff gap between the two is covered by the REGISTRY, which is written
# inside phase 1 — a racer that grabs the lock in the gap still sees the winner's
# meta.json and loses on the registry check. Correctness never rests on the gap.
FM_LOCKS_DIR="${FM_LOCKS_DIR:-$FOREMAN_ROOT/locks}"

# Canonical workdir: absolute, symlinks resolved, no trailing slash. MUST be used
# for both the lock key and the registry comparison — a directory and a
# symlink pointing at it are the same lane, and if they hash differently or
# string-compare differently then two builds both "win" and the guard reads green
# while the collision happens anyway. -m so a workdir that does not exist yet
# (build_start creates it) still resolves.
fm_resolve_workdir() { # path → canonical path
  realpath -m -- "$1" 2>/dev/null || printf '%s' "${1%/}"
}

# Trust exactly one Codex workdir without rewriting config.toml. The config fd
# is locked across parse, backup, append and verification so two independent
# launches cannot interleave additions to the process-wide Codex config.
fm_codex_trust_workdir() { # absolute_workdir, config_path, rollback_path
  python3 - "$1" "$2" "$3" <<'PY'
import fcntl
import json
import os
from pathlib import Path
import stat
import sys
import tomllib

workdir, config_name, backup_name = sys.argv[1:4]
config = Path(config_name)
backup = Path(backup_name)

def refuse(message):
    print("CODEX TRUST REFUSED: " + message, file=sys.stderr)
    raise SystemExit(1)

if not os.path.isabs(workdir):
    refuse("workdir is not absolute")
if not config.is_file():
    refuse("config.toml is missing: %s" % config)

with config.open("rb") as locked:
    fcntl.flock(locked.fileno(), fcntl.LOCK_EX)
    original = locked.read()
    original_stat = os.fstat(locked.fileno())
    try:
        parsed = tomllib.loads(original.decode("utf-8"))
    except Exception:
        refuse("existing config.toml is not valid TOML; no write made")

    projects = parsed.get("projects", {})
    exact = projects.get(workdir) if isinstance(projects, dict) else None
    if exact is not None:
        if isinstance(exact, dict) and exact.get("trust_level") == "trusted":
            print("CODEX TRUST: exact workdir already trusted; config unchanged: %s" % workdir)
            raise SystemExit(0)
        refuse("exact workdir entry exists but is not trusted; no write made: %s" % workdir)

    backup.parent.mkdir(parents=True, exist_ok=True)
    try:
        backup_fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                            stat.S_IMODE(original_stat.st_mode))
    except FileExistsError:
        refuse("rollback path already exists; refusing to overwrite it: %s" % backup)
    try:
        with os.fdopen(backup_fd, "wb") as saved:
            saved.write(original)
            saved.flush()
            os.fsync(saved.fileno())
        os.utime(backup, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    except Exception:
        try:
            backup.unlink()
        except OSError:
            pass
        refuse("could not create rollback copy; config.toml was not written")

    quoted = json.dumps(workdir, ensure_ascii=False)
    prefix = b"" if original.endswith(b"\n") else b"\n"
    addition = prefix + ("\n[projects.%s]\ntrust_level = \"trusted\"\n" % quoted).encode("utf-8")
    try:
        with config.open("ab") as destination:
            destination.write(addition)
            destination.flush()
            os.fsync(destination.fileno())
        reparsed = tomllib.loads(config.read_text(encoding="utf-8"))
        entry = reparsed.get("projects", {}).get(workdir)
        if not isinstance(entry, dict) or entry.get("trust_level") != "trusted":
            raise ValueError("exact trust entry absent after append")
    except Exception:
        restored = backup.read_bytes()
        with config.open("wb") as destination:
            destination.write(restored)
            destination.flush()
            os.fsync(destination.fileno())
        os.chmod(config, stat.S_IMODE(original_stat.st_mode))
        os.utime(config, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        if config.read_bytes() != original:
            refuse("post-append parse failed AND rollback verification failed")
        refuse("post-append TOML parse failed; restored byte-for-byte from %s" % backup)

    print("CODEX TRUST: appended exact workdir trust; TOML re-parse passed: %s" % workdir)
    print("CODEX TRUST: rollback copy: %s" % backup)
PY
}

# Make the Codex shell-snapshot location private without opening snapshot
# contents. `features.shell_snapshot=false` prevents new files in the normal
# path; this is the fail-safe for an existing directory and for any future CLI
# regression that creates a file despite the feature override.
fm_codex_secure_snapshot_dir() { # absolute_shell_snapshot_dir
  python3 - "$1" <<'PY'
import os
from pathlib import Path
import stat
import sys

root = Path(sys.argv[1])
old_umask = os.umask(0o077)
try:
    if root.is_symlink():
        raise RuntimeError("snapshot directory is a symlink")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    for entry in root.iterdir():
        if not entry.is_symlink() and entry.is_file():
            os.chmod(entry, 0o600)
    if stat.S_IMODE(root.stat().st_mode) != 0o700:
        raise RuntimeError("snapshot directory mode is not 0700 after chmod")
    for entry in root.iterdir():
        if (not entry.is_symlink() and entry.is_file()
                and stat.S_IMODE(entry.stat().st_mode) != 0o600):
            raise RuntimeError("snapshot file mode is not 0600: %s" % entry.name)
except Exception as exc:
    print("CODEX SNAPSHOT SECURITY REFUSED: %s" % exc, file=sys.stderr)
    raise SystemExit(1)
finally:
    os.umask(old_umask)
print("CODEX SNAPSHOT SECURITY: directory=0700 files=0600")
PY
}

# Lock file for a workdir. Slug is for humans reading `ls locks/`; the hash is
# what makes it collision-free.
fm_lock_path() { # resolved_workdir → lock file path
  local wd="$1" slug hash
  slug="$(printf '%s' "${wd##*/}" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-40)"
  hash="$(printf '%s' "$wd" | sha256sum | cut -c1-12)"
  printf '%s/wd-%s-%s.lock' "$FM_LOCKS_DIR" "${slug:-root}" "$hash"
}

# Take the claim on fd 9, NON-BLOCKING. The fd stays open in the CALLER's shell —
# that is the point — until fm_claim_release or the process dies.
# 0 = acquired, 1 = held by someone else, 2 = could not open the lock file.
fm_claim_acquire() { # resolved_workdir
  local lock; lock="$(fm_lock_path "$1")"
  mkdir -p "$FM_LOCKS_DIR" || return 2
  exec 9>>"$lock" || return 2
  flock -n 9 || return 1
}

fm_claim_release() { exec 9>&-; }

# Bounded wait for the claim. NOT how a winner is chosen — that is always the
# non-blocking fm_claim_acquire above, so a loser never queues for a lane. This
# is used only AFTER a start has already lost, to wait out the winner's
# sub-second registration so the refusal can name it from the registry instead of
# guessing. 0 = acquired, 1 = still held, 2 = could not open.
fm_claim_wait() { # resolved_workdir, seconds
  local lock; lock="$(fm_lock_path "$1")"
  mkdir -p "$FM_LOCKS_DIR" || return 2
  exec 9>>"$lock" || return 2
  flock -w "${2:-5}" 9 || return 1
}

# Which ACTIVE build holds this workdir, by resolved path. Empty if none.
fm_workdir_holder() { # resolved_workdir
  local d id other
  for d in "$BUILDS_DIR"/*/; do
    [ -f "$d/meta.json" ] || continue
    id="$(basename "$d")"
    [ "$(fm_status "$id")" = "active" ] || continue
    other="$(fm_meta "$id" workdir 2>/dev/null)" || continue
    if [ "$(fm_resolve_workdir "$other")" = "$1" ]; then printf '%s' "$id"; return 0; fi
  done
  return 0
}

# Diagnostic only, never the source of truth: which build last claimed this lock.
# Written while the writer holds the lock; read by losers so the message can name
# a winner even when the registry cannot.
#
# IT LIVES IN A SIBLING FILE, AND THAT IS LOAD-BEARING TWICE OVER.
#  1. It is replaced by rename(2), so a reader sees either the whole old value or
#     the whole new one. Writing in place with `>` truncates first, and a loser
#     reading in that gap gets an empty string and can only report a generic
#     "busy" instead of naming the winner (seen in a few percent of racers).
#  2. The rename target is NOT the lock file. flock(2) binds to the INODE, so
#     renaming over the lock would hand the next caller a fresh inode and a lock
#     that conflicts with nobody — the mutex would silently stop working while
#     still appearing to. The lock file is opened, locked, and never written.
fm_claim_note_write() { # resolved_workdir, build_id
  local owner tmp
  owner="$(fm_lock_path "$1").owner"; tmp="$owner.$$"
  printf '%s\n' "$2" > "$tmp" && mv -f "$tmp" "$owner"
}
fm_claim_note_read() { # resolved_workdir
  head -1 "$(fm_lock_path "$1").owner" 2>/dev/null || true
}

# ── Claimed queue-item identity ─────────────────────────────────────────────
# A workdir is a lane, not a subject. Two launches can name different paths and
# still claim the same queue item, producing two live builds for one item.
#
# Atomic item keys are the canonical programme identifiers (PREFIX-NUMBER, e.g.
# "FM-9", "R-2", "D-6b") on the brief's first non-empty line. A compound order
# is ledgered in order ("FM-9 then FM-2" → "FM-9+FM-2") but owns EACH atomic
# key, so a second "FM-2" launch conflicts. Prefixes are deliberately finite;
# arbitrary words and phase labels such as "3A" are not silently promoted to
# identities. Old ledger rows have no item_key field, so callers may run this
# recogniser over their prompt as an audit fallback.
fm_item_key_from_text() { # text on stdin → canonical item key, or empty
  python3 -c '
import re, sys

text = sys.stdin.read()
line = next((part for part in text.splitlines() if part.strip()), "")
pattern = re.compile(
    r"(?<![A-Za-z0-9])(?P<prefix>FM|RA|R|F|G|W|D|H)-?"
    r"(?P<number>[0-9]+)(?P<suffix>[A-Za-z]?)(?![A-Za-z0-9])",
    re.IGNORECASE,
)
keys = []
for match in pattern.finditer(line):
    prefix = match.group("prefix").upper()
    suffix = match.group("suffix").lower()
    key = "%s-%d%s" % (prefix, int(match.group("number")), suffix)
    if key not in keys:
        keys.append(key)
print("+".join(keys))
'
}

# Emit the last real claim row per build as BUILD_ID<TAB>ITEM_KEY. A real claim
# is the literal CLAIMED (or CLAIMED + BUILDING) followed by an ISO date. That
# syntax covers both a comment-line `# CLAIMED <date> ... (R-6b)` convention and
# the top-level `- [x] FM-9 + FM-2 — CLAIMED <date> ...` form, without treating
# narrative uses of the word "claimed" as ownership records.
fm_queue_claim_rows() { # queue_path → latest build-id/item-key rows
  python3 - "$1" <<'PY'
import re, sys
from pathlib import Path

queue_path = Path(sys.argv[1])
try:
    lines = queue_path.read_text(encoding="utf-8").splitlines()
except (OSError, UnicodeError):
    raise SystemExit(0)

key_pattern = re.compile(
    r"(?<![A-Za-z0-9])(?P<prefix>FM|RA|R|F|G|W|D|H)-?"
    r"(?P<number>[0-9]+)(?P<suffix>[A-Za-z]?)(?![A-Za-z0-9])",
    re.IGNORECASE,
)
build_pattern = re.compile(
    r"(?<![0-9])20[0-9]{6}-[0-9]{6}-"
    r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?"
)
claim_pattern = re.compile(
    r"\bCLAIMED(?:\s*\+\s*[A-Z]+)?\s+20[0-9]{2}-[0-9]{2}-[0-9]{2}",
    re.IGNORECASE,
)

def canonical_keys(text):
    keys = []
    for match in key_pattern.finditer(text):
        key = "%s-%d%s" % (
            match.group("prefix").upper(),
            int(match.group("number")),
            match.group("suffix").lower(),
        )
        if key not in keys:
            keys.append(key)
    return keys

def nearest_item(index):
    # Only used when the claim line itself carries no key. Prefer the next queue
    # item: the legacy convention wrote CLAIMED immediately before its item.
    for cursor in range(index + 1, min(len(lines), index + 8)):
        if re.match(r"^- \[[ xX]\] ", lines[cursor]):
            keys = canonical_keys(lines[cursor])
            if keys:
                return keys
            break
        if not lines[cursor].strip():
            break
    for cursor in range(index - 1, -1, -1):
        if re.match(r"^- \[[ xX]\] ", lines[cursor]):
            return canonical_keys(lines[cursor])
    return []

latest = {}
for index, line in enumerate(lines):
    if not claim_pattern.search(line):
        continue
    key_text = build_pattern.sub("", line)
    if re.match(r"^- \[[ xX]\] ", line):
        key_text = key_text[: key_text.upper().index("CLAIMED")]
    keys = canonical_keys(key_text) or nearest_item(index)
    if not keys:
        continue
    item = "+".join(keys)
    # Build ids may wrap onto the next two comment lines; stop at a blank line.
    record = [line]
    for cursor in range(index + 1, min(len(lines), index + 3)):
        if not lines[cursor].strip():
            break
        record.append(lines[cursor])
    build_ids = build_pattern.findall("\n".join(record))
    if build_ids:
        latest[build_ids[0]] = item
for build_id in sorted(latest):
    print("%s\t%s" % (build_id, latest[build_id]))
PY
}

fm_queue_claimed_item() { # queue_path, build_id → canonical key, or empty
  fm_queue_claim_rows "$1" | awk -F '\t' -v id="$2" '$1 == id { print $2 }'
}

# Produce build ids whose last claim overlaps any requested atomic item. The
# queue is parsed once per launch, regardless of ledger size.
fm_queue_claimed_builds_for_item() { # queue_path, item_key → build ids
  fm_queue_claim_rows "$1" | awk -F '\t' -v wanted="$2" '
    BEGIN {
      count = split(wanted, parts, "+")
      for (i = 1; i <= count; i++) wants[parts[i]] = 1
    }
    {
      count = split($2, parts, "+")
      for (i = 1; i <= count; i++)
        if (parts[i] in wants) { print $1; next }
    }
  '
}

# Which EXACT tmux session currently holds this claimed item? Registry status
# and process searches are intentionally irrelevant: tmux is the liveness
# authority, and `has-session -t <exact name>` cannot count its own shell.
fm_claimed_item_live_holder() { # item_key, queue_path → build_id, or empty
  local wanted="$1" queue_path="$2" id session
  while IFS= read -r id; do
    [ -f "$BUILDS_DIR/$id/meta.json" ] || continue
    session="$(fm_meta "$id" tmux 2>/dev/null || true)"
    [ -n "$session" ] || continue
    if tmux has-session -t "$session" 2>/dev/null; then
      printf '%s' "$id"
      return 0
    fi
  done < <(fm_queue_claimed_builds_for_item "$queue_path" "$wanted")
  return 0
}

# Close the read/launch race with kernel locks keyed on ATOMIC ITEMS, not the
# workdir. The fds stay held until build_start exits; after the tmux session
# exists, exact-session liveness is the durable check. A stale lock FILE is
# harmless because only a held flock refuses. Compound keys acquire each atom
# in sorted order, so FM-9+FM-2 races correctly with FM-2 alone.
fm_item_lock_path() { # canonical item key → lock file path
  local item="$1" slug hash
  slug="$(printf '%s' "$item" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-40)"
  hash="$(printf '%s' "$item" | sha256sum | cut -c1-12)"
  printf '%s/item-%s-%s.lock' "$FM_LOCKS_DIR" "${slug:-unknown}" "$hash"
}

FM_ITEM_LOCK_FDS=()
fm_item_claim_acquire() { # canonical key set; 0=won, 1=busy, 2=open failure
  local item lock fd
  FM_ITEM_LOCK_FDS=()
  mkdir -p "$FM_LOCKS_DIR" || return 2
  while IFS= read -r item; do
    [ -n "$item" ] || continue
    lock="$(fm_item_lock_path "$item")"
    exec {fd}>>"$lock" || { fm_item_claim_release; return 2; }
    FM_ITEM_LOCK_FDS+=("$fd")
    flock -n "$fd" || { fm_item_claim_release; return 1; }
  done < <(printf '%s\n' "${1//+/$'\n'}" | sort -u)
}

fm_item_claim_release() {
  local fd
  for fd in "${FM_ITEM_LOCK_FDS[@]:-}"; do
    [ -n "$fd" ] && exec {fd}>&-
  done
  FM_ITEM_LOCK_FDS=()
}

# ── Inflight wake lock ─────────────────────────────────────────────────────
# Shared by foreman_wake.sh and foreman_notify.sh. While a dispatched wake is
# unactioned, a second wake must not fire — it would spawn a duplicate foreman
# invocation. Cleared by build_say / build_keys / build_done. Expires after
# 600s so a crash never leaves a permanent lock.
#
# WHAT "IN FLIGHT" MEANS. wake.lock is a timestamp written on every wake ATTEMPT
# and removed only when Michael says/keys/closes. Read naively it says "in
# flight" for the full 600s after any wake Michael answered WITHOUT acting on the
# build — and then swallows the next real wake (a finish, say) though no Michael
# turn is running. So: in flight = the marker is younger than
# FM_WAKE_INFLIGHT_SETTLE (POST → spawn latency), or a Michael turn is live RIGHT
# NOW (the two process probes above). Past that the file is history — kept as
# the time the last wake was rendered (fm_wake_state.py uses it to recognise a
# duplicate) — and holds nothing. FM_WAKE_DEFER_DISABLE=1 restores the old reading.
FM_WAKE_LOCK_EXPIRY=600
FM_WAKE_INFLIGHT_SETTLE="${FM_WAKE_INFLIGHT_SETTLE:-30}"

fm_wake_lock_check() { # build_id → "locked" | "clear"
  local lock="$BUILDS_DIR/$1/wake.lock"
  [ -f "$lock" ] || { echo "clear"; return; }
  local ts age
  ts="$(cat "$lock" 2>/dev/null)" || { echo "clear"; return; }
  case "$ts" in ''|*[!0-9]*) echo "clear"; return;; esac
  age=$(( $(date +%s) - ts ))
  [ "$age" -lt "$FM_WAKE_LOCK_EXPIRY" ] || { echo "clear"; return; }
  [ -n "${FM_WAKE_DEFER_DISABLE:-}" ] && { echo "locked"; return; }
  [ "$age" -lt "$FM_WAKE_INFLIGHT_SETTLE" ] && { echo "locked"; return; }
  if [ "$(fm_foreman_resume_inflight)" = "yes" ] || [ "$(fm_michael_supervisor_inflight)" = "yes" ]; then
    echo "locked"
  else
    echo "clear"
  fi
}

fm_wake_lock_set() { # build_id
  date +%s > "$BUILDS_DIR/$1/wake.lock"
}

fm_wake_lock_clear() { # build_id
  rm -f "$BUILDS_DIR/$1/wake.lock"
}
# ───────────────────────────────────────────────────────────────────────────

# ══ A WAKE THAT CANNOT GO NOW IS HELD, NEVER DROPPED ══════════════════════════
# The per-build in-flight check runs in the HOOK, before fm_wake_michael, so a
# wake it suppressed never reached the pending-wakes/ FIFO — it was simply gone,
# and finished builds sat until the dark detector called them dark.
#
# THE SLOT: one file per build, $BUILDS_DIR/<id>/wake.pending, owned by
# fm_wake_state.py. Holding a wake writes or MERGES it there (N held wakes for a
# build are one), and it is delivered by the existing */2 cron through
# fm_drain_pending_wakes as soon as no Michael turn is running. Delivery runs
# the build's own hook script in --deliver mode, through the SAME call site an
# immediate wake uses, so the message is rendered when it is sent and carries
# the latest state. A slot lives in its own build's directory, so one build's
# wake can never absorb another's. No new fm_wake_michael call site exists
# (the briefing census test counts them).
#
# KILL SWITCH: FM_WAKE_DEFER_DISABLE=1, or the file $FOREMAN_ROOT/WAKE-DEFER-OFF
# (no edit, no restart — the next hook reads it), restores the simple hook
# behaviour: in flight ⇒ dropped, no waiting ladder, the old dark check. Wakes
# ALREADY held are still delivered by the drain; the switch never strands one.
if [ -e "${FOREMAN_ROOT:-/nonexistent}/WAKE-DEFER-OFF" ]; then FM_WAKE_DEFER_DISABLE=1; fi
FM_BIN_DIR="${FM_BIN_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)}"
FM_WAKE_STATE="${FM_WAKE_STATE:-$FM_BIN_DIR/fm_wake_state.py}"

# Why THIS build's wake must be held right now, or nothing (send it).
fm_wake_defer_reason() { # build_id
  if [ "$(fm_wake_lock_check "$1")" = "locked" ]; then
    echo "an earlier wake for this build was still in flight"
    return 0
  fi
  FM_WAKE_GUARD_PEEK=1 fm_foreman_wake_guard || echo "a Michael turn was already running"
  return 0
}

# Hold a wake in the build's slot (merging with any already held).
fm_build_wake_defer() { # build_id kind origin reason [transcript] [note] [rewake K/N]
  local id="$1" kind="$2" origin="$3" reason="$4" n
  n="$(python3 -B "$FM_WAKE_STATE" slot-put --build "$id" --kind "$kind" --origin "$origin" \
         --reason "$reason" --transcript "${5:-}" --note "${6:-}" --rewake "${7:-}" 2>/dev/null)" || n=""
  if [ -n "$n" ]; then
    fm_event "$id" "wake-deferred" "kind=$kind origin=$origin held=$n — $reason"
  else
    # The slot could not be written. Say so loudly; the waiting sweep still
    # re-wakes Michael for a build that sits done and unanswered.
    fm_event "$id" "wake-defer-failed" "kind=$kind origin=$origin — $reason; slot write failed"
  fi
  return 0
}

# The hooks' one question: rc 0 = this wake is HELD (caller stops), 1 = send now.
fm_wake_hold() { # build_id kind origin [transcript] [note]
  local id="$1" kind="$2" origin="$3" why
  if [ -n "${FM_WAKE_DEFER_DISABLE:-}" ]; then
    [ "$(fm_wake_lock_check "$id")" = "locked" ] || return 1
    fm_event "$id" "wake-suppressed-inflight" "$origin: another wake in flight"
    return 0
  fi
  why="$(fm_wake_defer_reason "$id")"
  [ -n "$why" ] || return 1
  fm_build_wake_defer "$id" "$kind" "$origin" "$why" "${4:-}" "${5:-}"
  return 0
}

# Remember the session's transcript path (the hooks are the only ones told it).
fm_build_transcript_note() { # build_id path
  [ -n "${2:-}" ] && [ -d "$BUILDS_DIR/$1" ] || return 0
  printf '%s\n' "$2" > "$BUILDS_DIR/$1/transcript.path.$$" 2>/dev/null \
    && mv -f "$BUILDS_DIR/$1/transcript.path.$$" "$BUILDS_DIR/$1/transcript.path" 2>/dev/null
  return 0
}

# working | waiting | held | inactive — from fm_wake_state.py. Fail-open to
# "working", which keeps the heartbeat's dark check exactly as it was.
fm_build_state() { # build_id
  local s
  s="$(python3 -B "$FM_WAKE_STATE" state --build "$1" --field state 2>/dev/null)" || s=""
  echo "${s:-working}"
}

# Deliver at most ONE held per-build wake. rc 0 = one was attempted (the tick is
# spent), 1 = nothing deliverable. $2 = the FIFO's oldest epoch: a slot younger
# than it waits, so the oldest held item goes first across both stores.
fm_drain_build_slots() { # [build_id] [fifo_first_ts]
  # NOT gated by FM_WAKE_DEFER_DISABLE, deliberately: flipping the switch stops
  # new holds, and must never strand a wake that is already held.
  [ -r "$FM_WAKE_STATE" ] || return 1
  local rows ft id claim verdict why kind script rc
  if [ -n "${1:-}" ]; then
    [ -f "$BUILDS_DIR/$1/wake.pending" ] || return 1
    rows="0 $1"
  else
    rows="$(python3 -B "$FM_WAKE_STATE" slots 2>/dev/null)" || return 1
  fi
  [ -n "$rows" ] || return 1
  # A Michael turn is running: nothing can go this tick, and every slot stays.
  FM_WAKE_GUARD_PEEK=1 fm_foreman_wake_guard || return 1
  while read -r ft id; do
    [ -n "$id" ] || continue
    case "$ft" in ''|*[!0-9]*) ft=0;; esac
    if [ -z "${1:-}" ] && [ -n "${2:-}" ] && [ "$ft" -gt "$2" ]; then return 1; fi
    claim="$(python3 -B "$FM_WAKE_STATE" slot-claim --build "$id" 2>/dev/null)" || claim=""
    [ -n "$claim" ] || continue
    read -r verdict why <<< "$(python3 -B "$FM_WAKE_STATE" slot-check --build "$id" --claim "$claim" 2>/dev/null)"
    case "$verdict" in
      covered|stale|inactive)
        fm_event "$id" "wake-pending-$verdict" "${why:-} — held wake not sent: nothing new to say"
        rm -f "$claim"
        continue ;;
    esac
    # deliver — or a check that could not answer, where noise beats silence.
    kind="$(python3 -B "$FM_WAKE_STATE" slot-field --claim "$claim" --key kind 2>/dev/null)"
    case "$kind" in permission) script=foreman_notify.sh ;; *) script=foreman_wake.sh ;; esac
    rc=0
    bash "$FM_BIN_DIR/$script" --deliver "$id" "$claim" </dev/null >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
      rm -f "$claim"
    else
      python3 -B "$FM_WAKE_STATE" slot-restore --build "$id" --claim "$claim" >/dev/null 2>&1 || true
      [ "$rc" -eq 75 ] || fm_event "$id" "wake-deliver-failed" "rc=$rc; the held wake is back in its slot"
    fi
    return 0
  done <<< "$rows"
  return 1
}

# The waiting-on-Michael ladder. A build that is DONE-WAITING (turn ended, or
# blocked on input) with no foreman act since the last wake is re-woken every
# FM_WAITING_REWAKE_AFTER (600s), at most FM_WAITING_MAX_REWAKES (2) times, and
# then the owner hears ONCE that it is waiting on Michael — never that it went
# dark. A build waiting on the OWNER (Michael ran build_ask, or the executor's
# latest record is needs_owner) is not nagged: the owner already has the question.
fm_waiting_sweep() {
  [ -n "${FM_WAKE_DEFER_DISABLE:-}" ] && return 0
  [ -r "$FM_WAKE_STATE" ] || return 0
  mkdir -p "$FM_LOCKS_DIR" 2>/dev/null || return 0
  (
    flock -n 7 || exit 0
    # One python per tick for the whole registry; it skips closed and held builds.
    python3 -B "$FM_WAKE_STATE" sweep-all 2>/dev/null | while read -r id act a1 a2; do
      [ -n "$id" ] || continue
      case "$act" in
        rewake)
          fm_event "$id" "waiting-rewake" "re-wake $a1 of $a2: done and waiting, no foreman act since the last wake"
          fm_build_wake_defer "$id" waiting waiting-sweep "re-wake $a1 of $a2" "" "" "$a1/$a2" </dev/null ;;
        tell-owner)
          # </dev/null: nothing in the loop body may read the decision pipe.
          fm_status_foreman_event "$id" waiting "$(fm_meta "$id" workdir 2>/dev/null </dev/null || true)" </dev/null
          fm_event "$id" "waiting-on-michael" "owner told after $a1 re-wakes: this build is waiting on Michael" ;;
      esac
    done
  ) 7>>"$FM_LOCKS_DIR/waiting-sweep.lock"
  return 0
}
# ═══════════════════════════════════════════════════════════════════════════

# Send a message to a build session and VERIFY it submitted (the Enter race):
# long text triggers paste-mode and the trailing Enter becomes a newline
# instead of submit. Send text and Enter separately, then confirm submission. A second Enter is permitted at most once,
# and only after a genuine negative described below.
# Composer state for the bottom-most prompt line: empty | full | none.
# Claude Code renders "❯ " (U+276F), codex renders "› " (U+203A); an empty
# composer is the marker followed by nothing but whitespace (the TUI pads with
# U+00A0, which is NOT ascii whitespace — strip it explicitly or every empty
# composer reads as full). The LAST such line is the composer; earlier ones are
# menu rows like "❯ 1. Yes" that the composer is drawn below.
fm_composer_state() { # tmux_target, runtime(optional; inferred for build sessions)
  local target="$1" runtime="${2:-}" build_id
  if [ -z "$runtime" ]; then
    build_id="${target#fm-}"
    if [ "$build_id" != "$target" ]; then
      runtime="$(fm_meta "$build_id" runtime 2>/dev/null || true)"
    fi
  fi
  tmux capture-pane -t "$1" -p 2>/dev/null | python3 -c '
import sys
marks = ("❯", "›")
runtime = sys.argv[1]
state = "none"
for line in sys.stdin:
    t = line.rstrip("\n").lstrip()
    if t[:1] in marks:
        content = t[1:].replace(" ", " ").strip()
        empty = not content or (runtime == "codex" and content == "Ask Codex to do anything")
        state = "empty" if empty else "full"
print(state)
' "$runtime"
}

# Snapshot every rollout size, then accept growth only when the file's session
# metadata names this exact workdir. The model-existence probe and other Codex
# sessions are therefore excluded; neither a newest-file guess nor pane text is
# used as the positive signal.
fm_rollout_snapshot() { # codex_home, absolute_workdir, output_json
  python3 - "$1" "$2" "$3" <<'PY'
import json, os, sys
from pathlib import Path

root, output = Path(sys.argv[1]), Path(sys.argv[3])
rows = {}
for path in (root / "sessions").glob("**/rollout-*.jsonl"):
    try:
        rows[str(path)] = path.stat().st_size
    except OSError:
        continue
output.write_text(json.dumps(rows, sort_keys=True) + "\n")
PY
}

fm_rollout_grew() { # codex_home, absolute_workdir, before_json
  python3 - "$1" "$2" "$3" <<'PY'
import json, os, sys
from pathlib import Path

root, workdir, before_name = Path(sys.argv[1]), os.path.realpath(sys.argv[2]), Path(sys.argv[3])
try:
    before = json.loads(before_name.read_text())
except (OSError, ValueError, TypeError):
    raise SystemExit(2)
for path in (root / "sessions").glob("**/rollout-*.jsonl"):
    try:
        size = path.stat().st_size
        if size <= before.get(str(path), 0):
            continue
        with path.open(errors="replace") as stream:
            first = json.loads(stream.readline())
        payload = first.get("payload") if isinstance(first, dict) else None
        cwd = payload.get("cwd") if isinstance(payload, dict) else None
        if cwd and os.path.realpath(cwd) == workdir:
            raise SystemExit(0)
    except (OSError, ValueError, TypeError):
        continue
raise SystemExit(1)
PY
}

# Poll budgets grow with message bytes. These are counts rather than fixed
# sleeps so large (60-80KB+) briefs receive materially longer windows.
fm_submit_poll_counts() { # bytes -> "landing_polls verify_polls"
  local bytes="$1" chunks
  chunks=$(( (bytes + 7999) / 8000 ))
  printf '%s %s\n' "$((8 + chunks))" "$((12 + (2 * chunks)))"
}

# ── THE 16KB WALL ──────────────────────────────────────────────────────────
# `tmux send-keys` takes the message as a COMMAND ARGUMENT, and tmux caps a
# whole command at 16KB (16,000 bytes accepted, 16,384 refused with "command
# too long"). The cap covers the command line, so the real threshold MOVES with
# the length of the target session name — hence chunking well under it rather
# than trimming to a number. A brief carrying the gate block easily exceeds it,
# and an over-cap single send leaves a live session with an empty composer
# while every earlier check reports green: the builder receives NOTHING.
# Content verified at composition is not length verified at delivery.
#
# CHUNK IN BYTES, SPLIT ON CHARACTER BOUNDARIES — both halves matter:
#   · splitting by byte alone can cut a multibyte UTF-8 sequence, silently
#     corrupting one glyph per seam;
#   · chunking by CHARACTER overflows again, because tmux counts BYTES and
#     box-drawing text (─ │ ═ ❯) is three bytes per character.
# So: measure the chunk in bytes, then walk the end back to a character boundary.
#
# `--` is load-bearing. Without it, a chunk that happens to START with "-" is
# parsed by tmux as a flag and the send dies with "unknown flag" — a hazard
# chunking INTRODUCES, and one a steer beginning with "-" would hit too.
fm_send_chunked() { # tmux_target, message
  printf '%s' "$2" | python3 -c '
import subprocess, sys, time
target = sys.argv[1]
raw = sys.stdin.buffer.read()
CHUNK = 8000          # BYTES. Half the measured cap, leaving room for the command.
i = 0
while i < len(raw):
    end = min(i + CHUNK, len(raw))
    # Back off to a UTF-8 character boundary: continuation bytes are 10xxxxxx.
    # Never split a multibyte sequence — half a character in each of two sends
    # corrupts one glyph in 19KB, and nothing downstream would notice.
    while end < len(raw) and (raw[end] & 0xC0) == 0x80:
        end -= 1
    r = subprocess.run(["tmux", "send-keys", "-t", target, "--",
                        raw[i:end].decode("utf-8", "surrogateescape")])
    if r.returncode != 0:
        sys.stderr.write("tmux send-keys refused chunk at byte offset %d\n" % i)
        sys.exit(1)
    i = end
    time.sleep(0.2)
' "$1"
}

# ── ENTER ONLY INTO A SETTLED COMPOSER ─────────────────────────────────────
# With a large message the codex TUI is still DRAINING the typed burst when
# Enter arrives (~10-15s at 16KB); the key is consumed as composer input, not
# submit, and a fixed-delay retry can miss the same way. Enter after the pane
# has settled submits reliably.
# So: before any Enter, wait until the PANE STOPS CHANGING — two consecutive
# identical captures 1s apart. FAIL-OPEN: if it never settles inside the budget,
# proceed to Enter anyway — the rollout/composer verification downstream still
# owns the verdict, this only stops us knocking during the drain.
fm_composer_settle() { # tmux_target, seconds_budget
  local target="$1" budget="${2:-15}" n=0 prev="" cur=""
  while [ "$n" -lt "$budget" ]; do
    cur="$(tmux capture-pane -t "$target" -p 2>/dev/null | md5sum)"
    [ -n "$prev" ] && [ "$cur" = "$prev" ] && return 0
    prev="$cur"; sleep 1; n=$((n + 1))
  done
  return 0
}

fm_send_submit() { # tmux_target, message, runtime(optional), workdir(optional)
  local target="$1" msg="$2" runtime="${3:-}" workdir="${4:-}" build_id
  local pane state landed=0 n msg_bytes landing_polls verify_polls
  local rollout_before="" codex_home="${CODEX_HOME:-$HOME/.codex}"
  local settle_interval="${FM_SUBMIT_SETTLE_INTERVAL:-0.5}"
  local verify_interval="${FM_SUBMIT_VERIFY_INTERVAL:-0.5}"
  if [ -z "$runtime" ] || [ -z "$workdir" ]; then
    build_id="${target#fm-}"
    if [ "$build_id" != "$target" ]; then
      [ -n "$runtime" ] || runtime="$(fm_meta "$build_id" runtime 2>/dev/null || true)"
      [ -n "$workdir" ] || workdir="$(fm_meta "$build_id" workdir 2>/dev/null || true)"
    fi
  fi
  [ -n "$runtime" ] || runtime="claude"
  if [ "$runtime" = "codex" ] && [ -z "$workdir" ]; then
    echo "SUBMIT BLOCKED: codex rollout proof requires an exact workdir for $target" >&2
    return 1
  fi
  # ── THE CHOKEPOINT FOR PROSE ENTERING A BUILD SESSION ────────────────────
  # Every path that puts text in front of a builder arrives here: build_start.sh
  # for both runtime lanes, build_say.sh for every steer. Gate handling belongs
  # at this line rather than at the call sites, because a call-site list cannot
  # be proven complete. No-op unless fm_gates.sh is loaded AND the gate set has
  # moved since the session launched.
  if declare -F fm_gates_stamp >/dev/null 2>&1; then
    msg="$(fm_gates_stamp "$target" "$msg")"
  fi
  msg_bytes="$(printf '%s' "$msg" | wc -c)"
  read -r landing_polls verify_polls <<EOF
$(fm_submit_poll_counts "$msg_bytes")
EOF
  if [ "$runtime" = "codex" ]; then
    rollout_before="$(mktemp /tmp/fm-rollout-before.XXXXXX.json)"
    if ! fm_rollout_snapshot "$codex_home" "$workdir" "$rollout_before"; then
      rm -f "$rollout_before"
      echo "SUBMIT BLOCKED: could not snapshot the codex rollout signal" >&2
      return 1
    fi
  fi
  # Make sure the composer is actually visible before we type into it. A detached
  # session is 80x24; a long brief overflows and its tail never reaches the pane,
  # which silently defeats the verification below.
  tmux resize-window -t "$target" -x 200 -y 50 2>/dev/null || true
  tmux send-keys -t "$target" C-u   # clear any stuck composer/paste state first
  sleep 0.5
  # ── LARGE PAYLOADS GO BY NATIVE PASTE ────────────────────────────────────
  # send-keys TYPES the text as a keystroke burst. At ~100KB+ (a brief with a
  # long gate list) the composer drains the burst for minutes, collapses
  # stragglers into "[Pasted Content]" chips, and Enter never submits.
  # load-buffer + paste-buffer -p lands it as ONE paste and Enter submits;
  # bracketed paste (-p) is what makes the TUI treat it as a paste instead of
  # typing. Small messages keep the send-keys path — steers must not change shape.
  if [ "$msg_bytes" -gt 8000 ]; then
    FM_PASTE_TMP="$(mktemp /tmp/fm-submit-paste.XXXXXX)"
    printf '%s' "$msg" > "$FM_PASTE_TMP"
    FM_PASTE_RC=0
    tmux load-buffer -b fm-submit "$FM_PASTE_TMP" \
      && tmux paste-buffer -p -b fm-submit -t "$target" || FM_PASTE_RC=$?
    rm -f "$FM_PASTE_TMP"
    tmux delete-buffer -b fm-submit 2>/dev/null || true
    if [ "$FM_PASTE_RC" -ne 0 ]; then
      [ -z "$rollout_before" ] || rm -f "$rollout_before"
      echo "SEND FAILED: tmux paste-buffer refused the message ($msg_bytes bytes) for $target" >&2
      return 1
    fi
  else
    fm_send_chunked "$target" "$msg" || {
      [ -z "$rollout_before" ] || rm -f "$rollout_before"
      echo "SEND FAILED: tmux refused the message ($msg_bytes bytes) for $target" >&2
      return 1
    }
  fi
  sleep 1
  # CHECKPOINT A — did the text actually land in the composer?
  # This exists to make CHECKPOINT B sound. "Composer is empty" only proves
  # submission if we first saw it non-empty; without that, empty is equally
  # consistent with nothing ever having been typed. Poll rather than read once:
  # a long brief is still redrawing at t+1s, and misreading that as "nothing
  # landed" would recreate the very false-negative this build is fixing.
  n=0
  while [ "$n" -lt "$landing_polls" ]; do
    state="$(fm_composer_state "$target" "$runtime")"
    [ "$state" = full ] && { landed=1; break; }
    # `none` is explicitly UNKNOWN. It is recorded but never satisfies A.
    sleep "$settle_interval"
    n=$((n + 1))
  done
  # Close any dangling bracketed-paste bracket (ESC [ 2 0 1 ~) BEFORE Enter.
  # A truncated paste can leave the TUI in paste mode, so every later key —
  # Enter and C-u included — is appended to the composer as literal text. The
  # session looks alive but is wedged until the bracket is closed.
  # Then wait for the drain (see fm_composer_settle above): budget scales with
  # size — a second per landing poll, floor 15s, so an 80KB brief gets ~18s+.
  tmux send-keys -t "$target" -H 1b 5b 32 30 31 7e
  sleep 0.5
  fm_composer_settle "$target" "$(( landing_polls > 15 ? landing_polls : 15 ))"
  tmux send-keys -t "$target" Enter
  # Codex success is rollout growth scoped to this exact workdir. Pane state is
  # corroboration only: placeholder/full/none can never manufacture success.
  n=0
  while [ "$n" -lt "$verify_polls" ]; do
    sleep "$verify_interval"
    if [ "$runtime" = "codex" ]; then
      if fm_rollout_grew "$codex_home" "$workdir" "$rollout_before"; then
        rm -f "$rollout_before"
        return 0
      fi
    else
      pane="$(tmux capture-pane -t "$target" -p | tail -12)"
      case "$pane" in
        *"esc to interrupt"*) return 0 ;;
      esac
      if [ "$landed" = 1 ] && [ "$(fm_composer_state "$target" "$runtime")" = empty ]; then
        return 0
      fi
    fi
    n=$((n + 1))
  done

  # One re-send is permitted only with a real negative: A observed text and it
  # is still visibly full after the sized verification window. Empty means the
  # text never landed; none means the marker is outside the viewport. Neither
  # authorises a blind Enter.
  state="$(fm_composer_state "$target" "$runtime")"
  if [ "$landed" != 1 ] || [ "$state" != full ]; then
    [ -z "$rollout_before" ] || rm -f "$rollout_before"
    echo "SUBMIT BLOCKED: no safe Enter retry (checkpoint-a=$landed composer=$state bytes=$msg_bytes)" >&2
    return 1
  fi

  tmux send-keys -t "$target" -H 1b 5b 32 30 31 7e
  sleep 0.5
  fm_composer_settle "$target" "$(( landing_polls > 15 ? landing_polls : 15 ))"
  tmux send-keys -t "$target" Enter
  n=0
  while [ "$n" -lt "$verify_polls" ]; do
    sleep "$verify_interval"
    if [ "$runtime" = "codex" ]; then
      if fm_rollout_grew "$codex_home" "$workdir" "$rollout_before"; then
        rm -f "$rollout_before"
        return 0
      fi
    else
      pane="$(tmux capture-pane -t "$target" -p | tail -12)"
      case "$pane" in *"esc to interrupt"*) return 0 ;; esac
      if [ "$(fm_composer_state "$target" "$runtime")" = empty ]; then return 0; fi
    fi
    n=$((n + 1))
  done
  [ -z "$rollout_before" ] || rm -f "$rollout_before"
  echo "SUBMIT BLOCKED: submission signal stayed negative after one guarded retry" >&2
  return 1
}

# ── FOREMAN MESSAGES: STRUCTURED STATUS RECORDS (OPTIONAL INTEGRATION) ──────
# These helpers also run under build_done.sh's `set -euo pipefail`, so every
# fallible step is guarded: a status failure must never cost the close wake.
# The executor writes records to <worktree>/.foreman/status.jsonl with
# fm_status.py emit (a file — it holds no credential). The foreman forwards them
# here and parks a copy for Michael's next wake. A gateway that implements
# $FM_STATUS_ENDPOINT (default /foreman/status) renders the owner's message in
# code and keeps every record on the build's timeline; a gateway without it
# answers 404/405 (rc 3) and the records live on in the ledger and the wakes.
# FM_STATUS_ENDPOINT=off skips the POST entirely. Contract: fm_status.py's docstring.
FM_STATUS="${FM_STATUS:-$FOREMAN_ROOT/bin/fm_status.py}"
FM_STATUS_ENDPOINT="${FM_STATUS_ENDPOINT:-/foreman/status}"

# POST one record (JSON on stdin) to the gateway. FAIL-SOFT: never blocks a
# wake. 0 = accepted (or deliberately suppressed), 1 = refused/failed, 3 = the
# gateway has no status endpoint (or FM_STATUS_ENDPOINT=off). Harness
# registries never reach the owner's chat.
fm_status_post() {
  local rec; rec="$(cat)"
  if ! fm_is_live; then
    printf '[%s] STATUS SUPPRESSED (harness registry)\n%s\n---\n' "$(date -Is)" "$rec" \
      >> "${FM_WAKE_LOG:-${FOREMAN_ROOT:-/tmp}/suppressed-wakes.log}"
    return 0
  fi
  if [ "$FM_STATUS_ENDPOINT" = off ]; then
    echo "STATUS-POST skipped: FM_STATUS_ENDPOINT=off (record kept in the build ledger)" >&2
    return 3
  fi
  local token; token="$(fm_token)"
  if [ -z "$token" ]; then
    echo "STATUS-POST-FAILED: no gateway token (set FM_GATEWAY_TOKEN)" >&2
    return 1
  fi
  # Token by environment, never argv, so it cannot show up in `ps`.
  FM_STATUS_REC="$rec" FM_STATUS_TOKEN="$token" python3 - "$GATEWAY_URL" "$FM_STATUS_ENDPOINT" <<'PY'
import os, sys, urllib.error, urllib.request
base, path = sys.argv[1], sys.argv[2]
token = os.environ.get("FM_STATUS_TOKEN", "")
req = urllib.request.Request(
    base + path,
    data=os.environ["FM_STATUS_REC"].encode(),
    headers={"Authorization": "Bearer " + token, "X-AHI-Token": token,
             "X-AHI-Foreman": "1", "Content-Type": "application/json"},
)
try:
    print(urllib.request.urlopen(req, timeout=15).read().decode()[:300])
except urllib.error.HTTPError as e:
    print(f"STATUS-POST {e.code}: {e.read().decode(errors='replace')[:300]}", file=sys.stderr)
    sys.exit(3 if e.code in (404, 405) else 1)
except Exception as e:
    print(f"STATUS-POST-FAILED: {e}", file=sys.stderr)
    sys.exit(1)
PY
}

# Forward a build's new executor records: post each to the gateway and park a
# copy in <build>/status.unwoken.jsonl for the next wake that actually reaches
# Michael (fm_status_take_unwoken) — so a throttled or deferred wake loses nothing.
fm_status_forward() { # build_id, workdir
  local id="$1" wd="$2" name rec rc err
  [ -r "$FM_STATUS" ] || return 0
  name="$(fm_meta "$id" name 2>/dev/null || true)"
  err="$BUILDS_DIR/$id/status.post.err"
  while IFS= read -r rec; do
    [ -n "$rec" ] || continue
    printf '%s\n' "$rec" >> "$BUILDS_DIR/$id/status.unwoken.jsonl"
    case "$rec" in
      '{"malformed"'*) fm_event "$id" "status-malformed" "executor wrote an unparseable status line"; continue ;;
    esac
    rc=0; printf '%s' "$rec" | fm_status_post >/dev/null 2>"$err" || rc=$?
    fm_event "$id" "status-forward" "rc=$rc $(head -c 300 "$err" 2>/dev/null)"
  done < <(timeout 5 python3 -B "$FM_STATUS" forward --build "$id" --workdir "$wd" \
             --state "$BUILDS_DIR/$id" ${name:+--title "$name"} 2>/dev/null)
  return 0
}

# One foreman-originated record (done | failed | abandoned | dark | died): made
# by fm_status.py in fixed words, parked for Michael, posted for the owner. Fail-soft.
fm_status_foreman_event() { # build_id, event, workdir(optional)
  local id="$1" ev="$2" wd="${3:-}" name rec rc=0
  [ -r "$FM_STATUS" ] || return 0
  name="$(fm_meta "$id" name 2>/dev/null || true)"
  rec="$(timeout 5 python3 -B "$FM_STATUS" foreman --build "$id" --event "$ev" \
           ${wd:+--workdir "$wd"} ${name:+--title "$name"} 2>/dev/null)" || return 0
  [ -n "$rec" ] || return 0
  printf '%s\n' "$rec" >> "$BUILDS_DIR/$id/status.unwoken.jsonl"
  printf '%s' "$rec" | fm_status_post >/dev/null 2>&1 || rc=$?
  fm_event "$id" "status-$ev" "rc=$rc"
  return 0
}

# Print and clear the records parked for Michael. When one is a needs_owner, the
# executor's own ask is transcribed as an #FMASK1 block, so fm_brief.py gives
# Michael a DECISION envelope: a needs_owner never reaches him as "no reply needed".
fm_status_take_unwoken() { # build_id
  local taken
  taken="$(fm_status_claim_unwoken "$1")"
  [ -n "$taken" ] || return 0
  fm_status_format_unwoken "$taken"
  rm -f "$taken"
  return 0
}

# take/format/settle split, so a wake whose POST fails can put
# its records back instead of losing them with the message that carried them.
fm_status_claim_unwoken() { # build_id → claim path, or nothing
  local f="$BUILDS_DIR/$1/status.unwoken.jsonl" taken
  [ -s "$f" ] || return 0
  taken="$f.taking.$$"
  mv "$f" "$taken" 2>/dev/null || return 0
  printf '%s\n' "$taken"
}

fm_status_format_unwoken() { # claim path
  local taken="$1" ask
  echo "Status records, as written (the owner's chat shows only needs_owner, closed and failed, rendered in code):"
  cat "$taken"
  ask="$(grep '"kind": *"needs_owner"' "$taken" | tail -1 || true)"
  if [ -n "$ask" ]; then printf '%s' "$ask" | python3 -B "$FM_STATUS" ask-block 2>/dev/null || true; fi
  return 0
}

# Settle a claim after the send: delivered (rc 0) ⇒ gone; not delivered ⇒ back.
# Put back by rename when nothing new arrived, else appended after the newer
# records (fm_status_forward only appends, so nothing is overwritten).
fm_status_settle_unwoken() { # build_id claim_path rc
  [ -n "${2:-}" ] && [ -f "$2" ] || return 0
  if [ "${3:-1}" = 0 ]; then rm -f "$2"; return 0; fi
  local f="$BUILDS_DIR/$1/status.unwoken.jsonl"
  mv -n "$2" "$f" 2>/dev/null || true          # -n: never over a record that just arrived
  if [ -f "$2" ]; then cat "$2" >> "$f" && rm -f "$2"; fi
  return 0
}

# ── THE TMUX SERVER LIVES OUTSIDE THE GATEWAY CGROUP ───────────────────────
# If the tmux server is first forked by a `tmux new-session` run from a
# gateway-launched turn, it stays in the gateway unit's cgroup
# (KillMode=control-group): restart the gateway and the server — and every
# build pane on it — dies. Panes are NOT the problem: a systemd-built tmux moves
# each pane into its own tmux-spawn-<uuid>.scope. Only the SERVER has to be
# placed, and it can be placed after the fact — a transient scope adopts a live
# pid without killing it.
# FM_TMUX_SOCKET (-L name) and FM_PROC_ROOT exist for the test harness only.
# FM_GATEWAY_DIRS: EXTRA colon-separated trees a build must never use as its
# workdir; $FM_GATEWAY_DIR is always checked (see fm_workdir_gateway_hit).
FM_GATEWAY_UNIT="${FM_GATEWAY_UNIT:-ahi-gateway.service}"
FM_GATEWAY_DIRS="${FM_GATEWAY_DIRS:-}"

fm_tmux() { # tmux on the foreman socket (default socket unless FM_TMUX_SOCKET)
  if [ -n "${FM_TMUX_SOCKET:-}" ]; then tmux -L "$FM_TMUX_SOCKET" "$@"; else tmux "$@"; fi
}

fm_tmux_server_pid() { # → server pid, or empty when no server is running
  { fm_tmux list-sessions -F '#{pid}' 2>/dev/null || true; } | head -1
}

fm_pid_in_gateway_cgroup() { # pid → 0 if its cgroup is under the gateway unit; 2 if unreadable
  local cg
  cg="$(cat "${FM_PROC_ROOT:-/proc}/$1/cgroup" 2>/dev/null)" || return 2
  [ -n "$cg" ] || return 2
  printf '%s\n' "$cg" | grep -q "/${FM_GATEWAY_UNIT//./\\.}\(/\|\$\)"
}

# 0 = a server is up and NOT in the gateway cgroup; 1 = refused (reason on stderr).
# No server → start one inside its own transient scope, holding a `fm-keepalive`
# session so the server outlives the gap between builds. Two racing launches are
# harmless: the loser's new-session fails on the duplicate name, its scope empties
# and is collected, and both fall through to the same cgroup check.
fm_tmux_ensure_server() {
  local pid unit n=0 rc=0
  pid="$(fm_tmux_server_pid)"
  if [ -z "$pid" ]; then
    unit="ahi-foreman-tmux-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
    local -a sock=()
    [ -z "${FM_TMUX_SOCKET:-}" ] || sock=(-L "$FM_TMUX_SOCKET")
    env -u TMUX systemd-run --user --scope --quiet --collect --unit="$unit" -- \
      tmux "${sock[@]}" new-session -d -s fm-keepalive "exec sleep infinity" >/dev/null 2>&1 || true
    while [ -z "$pid" ] && [ "$n" -lt 20 ]; do
      pid="$(fm_tmux_server_pid)"; [ -n "$pid" ] || { sleep 0.1; n=$((n + 1)); }
    done
    if [ -z "$pid" ]; then
      echo "REFUSED: no tmux server, and starting one in scope $unit failed." >&2
      echo "         Check the user manager is reachable (XDG_RUNTIME_DIR, DBUS) and retry:" >&2
      echo "           systemd-run --user --scope --unit=$unit -- tmux new-session -d -s fm-keepalive 'exec sleep infinity'" >&2
      return 1
    fi
  fi
  fm_pid_in_gateway_cgroup "$pid" || rc=$?
  case "$rc" in
    1) return 0 ;;
    2) echo "REFUSED: cannot read the cgroup of tmux server pid $pid — placement unverified." >&2
       return 1 ;;
  esac
  local fix="ahi-foreman-tmux-adopt-$(date -u +%Y%m%dT%H%M%SZ).scope"
  {
    echo "REFUSED: the tmux server (pid $pid) is inside $FM_GATEWAY_UNIT's cgroup."
    echo "         A gateway restart would kill it and every build on it, so no build starts here."
    echo "         FIX — move the live server into its own scope; sessions are NOT interrupted:"
    echo "           busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 \\"
    echo "             org.freedesktop.systemd1.Manager StartTransientUnit 'ssa(sv)a(sa(sv))' \\"
    echo "             $fix fail 1 PIDs au 1 $pid 0"
    echo "         then confirm with: cat /proc/$pid/cgroup   (must name $fix), and re-run this start."
  } >&2
  return 1
}

fm_workdir_gateway_hit() { # path → prints the live gateway dir it is (or is inside); 1 if none
  local wd g gr IFS=:
  wd="$(fm_resolve_workdir "$1")"
  for g in $FM_GATEWAY_DIR:$FM_GATEWAY_DIRS; do
    [ -n "$g" ] || continue
    gr="$(fm_resolve_workdir "$g")"
    case "$wd/" in "$gr/"*) printf '%s\n' "$gr"; return 0 ;; esac
  done
  return 1
}

# Merge the foreman's hooks/permissions INTO a workdir's .claude/settings.json.
# Existing keys are kept (a scalar the workdir already set wins); lists gain only
# the foreman entries they lack; nested objects merge recursively. Deterministic
# and idempotent: a second run with the same overlay leaves the file untouched.
# The original is copied once to settings.json.pre-foreman. An unparseable file,
# or a key whose type disagrees with the overlay, is REFUSED, never overwritten.
fm_settings_merge() { # target_settings_json, overlay_json_file
  python3 - "$1" "$2" <<'PY'
import json, os, shutil, sys, tempfile
target, overlay_path = sys.argv[1:3]
overlay = json.load(open(overlay_path))

def key(v):
    return json.dumps(v, sort_keys=True)

def merge(dst, src, where):
    for k, v in src.items():
        if k not in dst:
            dst[k] = v
        elif isinstance(dst[k], dict) and isinstance(v, dict):
            merge(dst[k], v, f"{where}.{k}")
        elif isinstance(dst[k], list) and isinstance(v, list):
            have = {key(x) for x in dst[k]}
            for x in v:
                if key(x) not in have:
                    dst[k].append(x); have.add(key(x))
        elif type(dst[k]) is not type(v):
            sys.exit(f"REFUSED: {target}: {where}.{k} is {type(dst[k]).__name__}, "
                     f"foreman needs {type(v).__name__} — fix the file by hand")
        # same-type scalar: the workdir's value stands

base, existed = {}, os.path.exists(target)
if existed:
    raw = open(target).read()
    try:
        base = json.loads(raw) if raw.strip() else {}
    except ValueError as e:
        sys.exit(f"REFUSED: {target} is not valid JSON ({e}) — not overwriting it")
    if not isinstance(base, dict):
        sys.exit(f"REFUSED: {target} is not a JSON object — not overwriting it")
    bak = target + ".pre-foreman"
    if not os.path.exists(bak):
        shutil.copy2(target, bak)
before = key(base)
merge(base, overlay, "$")
if existed and key(base) == before:
    sys.exit(0)  # nothing to add — leave the bytes alone
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target) or ".", prefix=".settings.")
umask = os.umask(0); os.umask(umask)
os.chmod(tmp, (os.stat(target).st_mode & 0o777) if existed else (0o666 & ~umask))
with os.fdopen(fd, "w") as f:
    json.dump(base, f, indent=2)
    f.write("\n")
os.replace(tmp, target)
PY
}
