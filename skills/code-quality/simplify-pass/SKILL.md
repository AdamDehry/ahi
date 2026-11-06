---
name: simplify-pass
description: The one simplify pass every build runs over its own diff before it reports ready for review — cut bloat, duplication, needless layers and comments with no behaviour change, never cut security, validation, data-loss or error handling, or accessibility, then rerun the tests and record what was removed. Use as the last step of any code build (Claude via the built-in simplify skill, Codex or any other runtime by hand). Not a bug hunt (use a code review) and not a refactor of code outside the diff.
version: 1.0.0
category: code-quality
private: false
last_verified: 2026-11-06
verified_by: skills-audit
---

# simplify-pass

Leave the diff smaller and clearer than you wrote it, and prove nothing broke.

## When to use

- Last step before "ready for review" on any build that changed code.
- After an audit's fixes land (see `audit-codebase`).

## Steps

1. **Scope = your own diff**: `git diff <base>...HEAD` (plus uncommitted work). Do not wander into
   untouched code.
2. **Run ONE pass.**
   - Claude Code: invoke the `simplify` skill on the changed code.
   - Codex / any other runtime: do the same review by hand, file by file, against the lists below.
3. **Cut:**
   - bloat — dead code, unused exports/params, speculative options nobody calls;
   - duplication — two copies of the same logic, constants restated in several places;
   - needless layers — wrappers that only forward, single-use abstractions, config for one value;
   - comments that restate the code or narrate history (keep the ones that explain *why*).
4. **NEVER cut** (even if it looks redundant):
   - security and trust-boundary checks (auth, ownership, path containment, signature checks);
   - input validation;
   - data-loss protection and error handling (backups, atomic writes, rollbacks, retries);
   - accessibility (labels, roles, focus handling, live regions).
5. **No behaviour changes.** If a cut would change output, an API shape or a log line someone greps, leave it.
6. **Rerun the tests** (same commands as before the pass; on a shared box wrap them per
   `oom-safe-test-runs`). Typecheck too.
7. **Record it** in the build's REPORT: one short list of what the pass removed (file — what — why), and
   the test result after it. "Nothing to cut" is a valid result; say so.

## Gotchas

- A pass that only reformats is not a pass; a pass that rewrites working code is too much.
- Removing an "unused" export can break a caller in another package — search the whole repo first.
- Keep commits separate: the simplify pass is its own commit, so review can see it.

## Rulings this depends on

- The build brief's simplify order (one pass, never-cut list, test rerun, REPORT note).

## Related skills

- `audit-codebase` — the simplify layer after audit fixes.
- `codex-consult` — the peer review that follows.
- `oom-safe-test-runs` — rerunning the suite safely.
