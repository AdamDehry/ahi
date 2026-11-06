---
name: cron-job-pattern
description: The house pattern for any scheduled job on a Linux box — a UTC-only crontab line, a frequent tick that decides local time in code, a lock, a KILL switch file, a health file, a trimmed log and an exit status that never alarms cron. Includes the safe way to edit a crontab without printing it. Use when adding, changing, pausing or debugging a cron job. Not for one-off delayed runs (use `at` or a harness wake) and not for long-running services (use a systemd unit).
version: 1.0.0
category: ops-infra
private: false
last_verified: 2026-11-05
verified_by: skills-audit
---

# cron-job-pattern

A cron job that is quiet when healthy, loud when broken, stoppable with one `touch`, and never leaks.

## When to use

- "Make X happen every night / every hour."
- Pausing, changing or diagnosing an existing scheduled job.

## Steps

1. **Write the script first**, beside the other jobs, with these parts at the top:
   - `KILL=<dir>/<NAME>-OFF`; `[ -e "$KILL" ] && exit 0` — one `touch` stops it, `rm` resumes it.
   - A dry-run switch: `<NAME>_DRY=1` does everything except the side effects.
   - A lock so two ticks never overlap: `exec 9>"<state dir>/<name>.lock"; flock -n 9 || exit 0`.
   - A log at `<log dir>/<name>.log`, trimmed every run (`tail -n 2000` into a temp, then `mv`).
   - A health file `<state dir>/<name>.json` with `last_run`, `ok`, `detail`.
2. **Schedule in UTC only.** Debian cron ignores `CRON_TZ`, so never write local hours in the crontab. If the
   job must run at a local time, tick often (e.g. every 10 or 60 minutes) and let the program check the local
   hour itself. Daylight-saving shifts then need no crontab edit.
3. **Exit 0 always.** Report failure through the health file and one loud line where a human or agent
   actually reads it (an activity feed, a report file named in memory). A non-zero exit only mails a
   mailbox nobody reads.
4. **Install without printing the crontab** — it can hold secrets:
   ```bash
   umask 077
   t=$(mktemp "$PWD/.crontab.XXXXXX")       # mode 600, in your own workdir
   crontab -l > "$t" 2>/dev/null || true
   printf '%s\n' '15 9 * * * <command> # <marker>' >> "$t"
   crontab "$t" && rm -f "$t"
   crontab -l | grep -c '<marker>'           # verify by COUNT, never by content
   ```
   To change or remove a line, edit the temp file with `sed -i '/<marker>/d' "$t"` the same way.
5. **Prove it ran**: after the first scheduled time, read the health file and the log tail, not the crontab.
6. **Prove the signal has a reader**: name where findings land (a report path, a feed) in the place the
   reading agent loads every session. A report nobody opens is not a signal.

## Gotchas

- `crontab -l`, `ps auxww`, `pgrep -af`, `env`, `systemctl cat`, `journalctl` all render live secrets to
  stdout. Count or grep them for a marker; never print them.
- `claude -p` (or any reader of stdin) inside `while read` eats the loop's input — add `</dev/null`.
- Pass messages to notifiers from a file, never as argv (argv is visible to every process listing).
- cron's PATH is minimal: use absolute binary paths, or set `PATH=` at the top of the script.
- `sleep`-and-poll watchers die silently on small boxes; cron or a harness wake is the dependable tick.
- A job that launches heavy work must check free memory first (see `oom-safe-test-runs`).

## Rulings this depends on

- The credential-disclosure rails (never render scheduler/process/env listings) — your gate list.
- "A signal is not delivered until a reader is proven" — your gate list.

## Related skills

- `oom-safe-test-runs` — memory guard for anything heavy a job launches.
- `safe-shell-hygiene` — stopping processes by exact pid, verifying edits.
