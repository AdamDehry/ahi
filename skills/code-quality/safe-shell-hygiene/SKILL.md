---
name: safe-shell-hygiene
description: Small shell disciplines that prevent the worst agent accidents on a shared box — stop processes by exact pid never by pattern, write wait loops that cannot match themselves, verify a scripted edit by reading the lines back, and search runtime-built paths correctly. Use whenever you stop or wait on a process, or edit files with sed/python/heredocs. Not a general bash tutorial.
version: 1.0.0
category: code-quality
private: false
last_verified: 2026-11-06
verified_by: skills-audit
---

# safe-shell-hygiene

Kill exactly what you started; believe an edit only after you read it back.

## When to use

- Stopping a server, test run, preview or tunnel you started.
- Waiting for a background job to finish.
- After any scripted edit (sed, python, heredoc, codemod).

## Steps

1. **Stop by exact pid, never by pattern.** `pkill -f "node dist/index.js"` also kills the production
   process with the same command line. Instead:
   ```bash
   pgrep -c -f '<pattern>'                       # count first
   readlink /proc/<pid>/cwd                      # confirm it is yours (cwd, or a port in its environ)
   kill <pid>
   ```
   Record the pid when you start something (`echo $! > <workdir>/<name>.pid`) and stop that pid.
2. **Wait loops must not match themselves.** `pgrep -f run-all.sh` matches the shell running the loop.
   Use a bracket trick (`'run-all[.]sh'`), a pid file, or a done-marker file the job writes at the end.
3. **Hung pane with "N shells still running":** `ps --ppid <pane pid>`, then `kill -TERM -- -<pgid>` of the
   exact process group — never a pattern.
4. **Verify edits by reading them back.** A grep for an identifier proves nothing about whether the edit
   landed in the right place. After a scripted edit, `sed -n '<a>,<b>p' <file>` the target lines, and
   inside edit scripts assert the anchor exists exactly once before replacing:
   ```python
   assert s.count(old) == 1, "anchor not unique"
   s = s.replace(old, new)
   ```
5. **Runtime-built paths:** code that builds paths from `$HOME` or a root variable at runtime will not
   match a grep for the literal absolute path — grep for the bare word.
6. **Evidence searches inside subshells:** some agent shells define `find`/`grep` as shell functions that
   misbehave inside pipelines and `$( )`. Use `command find` / `command grep` (or an absolute path) when the
   output is evidence, and plant a known positive control before claiming absence.

## Gotchas

- `pgrep -a`/`-f` to stdout prints other processes' full command lines — which can include secrets. Count
  (`-c`) instead of printing.
- A clean exit status from a search pipeline is not proof of absence.
- A leftover redirect in an edited command can write somewhere you did not intend; reread commands you edit.

## Rulings this depends on

- The disclosure rails on process and environment listings — your gate list.

## Related skills

- `cron-job-pattern` — locks and kill files for scheduled jobs.
- `oom-safe-test-runs` — detached units with logs for long runs.
