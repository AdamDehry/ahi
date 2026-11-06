---
name: oom-safe-test-runs
description: Run tests and builds on a small Linux box without the kernel OOM killer taking down the session, other builds or the live service. Wraps each heavy command in a memory-capped systemd scope, gates on free memory, serialises heavy suites and avoids the dependency and NODE_ENV traps that make suites fail for reasons unrelated to the code. Use before any npm test, build, e2e or render run on a shared server. Not needed on a laptop with ample RAM.
version: 1.1.0
category: code-quality
private: false
last_verified: 2026-11-06
verified_by: skills-audit
---

# oom-safe-test-runs

An overrun kills the command, not the session.

## When to use

- Any test suite, build, e2e, renderer or bundler run on a shared server.
- Several builders active at once, or the box has crashed with OOM before.

## Steps

1. **Check memory first.** Run only when there is headroom:
   ```bash
   awk '/MemAvailable/{print int($2/1024)" MB"}' /proc/meminfo   # want >= 2500 MB
   ```
   Below that, wait or run one file at a time. Limit test workers to 2.
2. **Wrap the command in a capped scope:**
   ```bash
   systemd-run --user --scope -p MemoryMax=1800M -p MemorySwapMax=0 --quiet <cmd>
   ```
   If the command overruns, the cgroup kills it and exits non-zero — your shell and other work survive.
   Raise `MemoryMax` only after measuring.
3. **One heavy suite at a time.** Never two e2e / browser / render suites in parallel; parallel preview
   servers also collide on ports and caches.
4. **Wait in the foreground.** Backgrounding a long suite and ending the turn looks idle to supervisors and
   gets killed with the session. For suites that must outlive the session, use a detached unit with a log:
   `systemd-run --user --unit test-<name> --collect bash -lc '<cmd> > <log> 2>&1'`.
5. **Dependencies:** if `npm config get omit` says `dev`, a plain `npm ci` skips TypeScript/tsx and the
   suite fails to start — use `npm ci --include=dev`. In throwaway build copies prefer a shared, hard-linked
   dependency cache over a fresh `npm ci` per copy (disk, not just RAM).
6. **NODE_ENV:** shells that export `NODE_ENV=production` break React `act`, `next dev` and dev-only
   assertions, and make `npm audit` prod-only. Pin it per command: `env -u NODE_ENV npm audit --include=dev`,
   `NODE_ENV=development node …`.
7. **Know the baseline.** Before calling a failure yours, run the same file on the main branch. A timeout
   under load: rerun that one file alone before judging it.
8. Restore files a suite rewrites (snapshot/screenshot dirs) with `git checkout -- <dir>` before committing.

## Gotchas

- A timeout is not a failure until it reproduces on a quiet box.
- One scope around a WHOLE `node --test` suite accumulates: the runner holds every file's output, so a
  1800M cap can OOM-kill a ~200-file suite partway through even at `--test-concurrency=1`. Loop instead:
  one capped scope PER test file, a pass/fail line per file; rerun the few heavy files (full-migration
  database replays can need ~2.6G alone) at a measured higher cap once MemAvailable allows. A file with
  no `# pass` line was killed, not failed: check `journalctl --user | grep oom-kill`.
- `MemorySwapMax=0` matters: with swap the job thrashes instead of dying cleanly.
- Watch the build's own child processes too (headless browsers, workers) — they share the scope's cap.

## Rulings this depends on

- Your operator's memory gate (minimum free MB, worker count) if one is set — it overrides the defaults here.

## Related skills

- `cron-job-pattern` — jobs that launch heavy work.
- `simplify-pass` — rerun the suite after the simplify pass, under this wrapper.
