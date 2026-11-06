#!/usr/bin/env bash
# Hold a build's workdir claim lock for the LIFE OF THE RUNTIME PROCESS, then
# become that process. Runs as the tmux pane command:
#
#   tmux new-session ... "fm_hold_lock.sh <lockfile> <build-id> claude --model ..."
#
# WHY THIS EXISTS RATHER THAN INHERITING build_start's DESCRIPTOR. Passing the
# still-open fd to the tmux child cannot work: `tmux new-session` is a CLIENT
# that hands a command to the tmux SERVER over a socket, and the server forks the
# pane from itself. Our descriptors never reach it — there is no fd to inherit.
# So the pane opens the same lock file and takes the lock itself. The property
# that matters is preserved: from here on the lock is held by the session's own
# process, and the kernel releases it on exit, crash, SIGKILL, `tmux kill-session`
# and reboot alike. No reaper, no staleness check, no on-disk claim to reclaim.
#
# flock(2) is held against the OPEN FILE DESCRIPTION, not the process, and fd 9 is
# opened by an explicit numeric redirection (no close-on-exec). So the lock
# survives `exec` into the runtime and dies only when that runtime dies.
#
# The wait is BOUNDED, not non-blocking, and that is deliberate: the only other
# process that can hold this lock at this moment is another build_start.sh inside
# its sub-second check-and-register section (see lib.sh "handoff gap"). Failing
# non-blocking against a transient holder would kill a legitimate build. 30s is
# far past that window; anything longer is a real claim and we refuse loudly.
set -uo pipefail

LOCK="${1:?lock file}"; BUILD_ID="${2:?build id}"; shift 2
[ "$#" -gt 0 ] || { echo "FOREMAN: fm_hold_lock.sh needs a command to exec" >&2; exit 2; }

if ! exec 9>>"$LOCK"; then
  echo "FOREMAN: cannot open workdir lock $LOCK — refusing to start $BUILD_ID unguarded" >&2
  exit 1
fi

# FM_HOLD_LOCK_WAIT: the heartbeat's tick lock uses this file too, and its tests
# need a short wait; the default is the build-launch value and is unchanged.
if ! flock -w "${FM_HOLD_LOCK_WAIT:-30}" 9; then
  # Do NOT linger. build_start checks `tmux has-session` a few seconds from now;
  # dying immediately turns this into a clean "launch-failed", which frees the
  # registry entry. Sleeping here would let the brief be typed into a dead pane.
  echo "FOREMAN: workdir lock $LOCK held by another build after ${FM_HOLD_LOCK_WAIT:-30}s." >&2
  echo "         Refusing to run $BUILD_ID in a claimed workdir. Holder: $(head -1 "$LOCK.owner" 2>/dev/null || echo unknown)" >&2
  exit 1
fi

# Re-stamp the owner file, atomically and beside the lock — never into the lock
# itself, whose inode must stay put for flock to keep meaning anything (lib.sh).
printf '%s\n' "$BUILD_ID" > "$LOCK.owner.$$" && mv -f "$LOCK.owner.$$" "$LOCK.owner"
exec "$@"
