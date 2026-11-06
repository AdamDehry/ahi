#!/usr/bin/env bash
# fm_setup.sh — prepare a foreman install under $AHI_HOME/foreman. Idempotent; safe on every upgrade.
#
#   fm_setup.sh            create runtime dirs, seed QUEUE.md / ACTIVE-GATES.md from templates if absent,
#                          check the gates, report missing tools
#   fm_setup.sh --print-cron   print the heartbeat crontab line (never installs it)
#
# Never overwrites an existing QUEUE.md or ACTIVE-GATES.md: those are the owner's rulings.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export FOREMAN_ROOT="${FOREMAN_ROOT:-$(dirname "$HERE")}"
export AHI_HOME="${FM_AHI_HOME:-${AHI_HOME:-$(dirname "$FOREMAN_ROOT")}}"
# Cron starts with an empty environment: carry the home and the path overrides this setup was given
# (read before lib.sh fills in its defaults).
ENV="AHI_HOME=$(printf %q "$AHI_HOME") FOREMAN_ROOT=$(printf %q "$FOREMAN_ROOT")"
for v in FM_GATEWAY_DIR FM_USERS_JSON GATEWAY_URL; do
  [ -n "${!v:-}" ] && ENV="$ENV $v=$(printf %q "${!v}")"
done
source "$HERE/lib.sh"
source "$HERE/fm_gates.sh"

LOGS="$FM_LOG_DIR"
R="$(printf %q "$FOREMAN_ROOT")" L="$(printf %q "$LOGS")"
cron_lines="*/10 * * * * $ENV $R/bin/foreman_heartbeat.sh >> $L/foreman-heartbeat.log 2>&1
*/3 * * * * $ENV $R/bin/foreman_heartbeat.sh --if-open >> $L/foreman-heartbeat.log 2>&1
*/2 * * * * $ENV $R/bin/fm_stop_watch.sh >> $L/foreman-stop-watch.log 2>&1"
if [ "${1:-}" = "--print-cron" ]; then echo "$cron_lines"; exit 0; fi

mkdir -p "$BUILDS_DIR" "$FM_LOCKS_DIR" "$FM_LOG_DIR" "$FM_STATE_DIR" "$FM_WORKTREES_DIR"
chmod 700 "$BUILDS_DIR" "$FM_LOCKS_DIR"
chmod +x "$FOREMAN_ROOT"/bin/*.sh "$FOREMAN_ROOT"/bin/*.py "$FOREMAN_ROOT"/desks/*.sh 2>/dev/null || true

for f in QUEUE.md ACTIVE-GATES.md; do
  if [ ! -e "$FOREMAN_ROOT/$f" ]; then
    cp "$FOREMAN_ROOT/templates/$f" "$FOREMAN_ROOT/$f"
    echo "  seeded $f from templates/"
  fi
done

if fm_gates_check >/dev/null; then
  echo "  gates: check passed"
else
  echo "  gates: check FAILED — run: $FOREMAN_ROOT/bin/fm_gates.py check" >&2
  echo "         (build_start refuses to launch until the gates reconcile)" >&2
fi

missing=""
for t in tmux git python3 flock; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
command -v "$(fm_claude_bin)" >/dev/null 2>&1 || missing="$missing claude"
[ -z "$missing" ] && echo "  tools: ok" || echo "  tools missing:$missing (needed to launch builds)"
command -v codex >/dev/null 2>&1 || echo "  note: codex not found — Codex lane unavailable until it is installed"

echo "  foreman ready at $FOREMAN_ROOT"
echo "  heartbeat + Codex idle poller (UTC crontab; pause with: touch $FOREMAN_ROOT/heartbeat.KILL) —"
echo "  add when you start supervising builds:"
echo "$cron_lines" | sed 's/^/    /'
