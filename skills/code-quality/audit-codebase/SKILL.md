---
name: audit-codebase
description: Run a structured code/perf/security audit on a web codebase using a 3-layer review model (in-session reasoning → Codex CLI second opinion → automated GitHub App pattern detection via BugBot + Cubic). Produces a markdown audit report in the production-grade structure (Summary → Inventory → Detailed Findings with file:line citations → Recommendations → Out of Scope). Use when an agent or user asks to audit a repo, identify perf bottlenecks, run a security review, harden a codebase for production, or generate a pre-launch checklist. Skip for single-file reviews (use codex-consult directly) and for documentation-only repos.
version: 1.1.1
category: code-quality
private: false
last_verified: 2026-11-06
verified_by: skills-audit
---

# audit-codebase

Generalized code-audit methodology adapted from a production workflow using in-session review, Codex second opinion, and automated GitHub-app pattern scanning. Stack-agnostic — covers web apps (Next.js / Node / Python / etc.). Native-mobile bridge audits live in a separate skill (deferred).

## When to invoke

- Pre-launch hardening of a production web app
- Post-incident audit when a perf or security issue surfaces
- Quarterly health check on a maintained codebase
- After a major migration (framework upgrade, lender swap, auth refactor)
- When a user explicitly asks: "audit the CRM", "run a code review on X", "what's slow about this app", "is this production-ready"

## When NOT to invoke

- Single-file reviews — use `codex-consult` directly
- Documentation-only repos — there's nothing to audit
- Active feature work — finish the feature first, then audit
- Repos without a remote on GitHub — the bot layer can't fire

## The methodology

See [`methodology.md`](./methodology.md) for the full doc. Summary:

```
WRITE             (in-session reasoning — design + spec + logic)
  ↓
SECOND OPINION    (Codex CLI on-demand — independent eyes, simpler approaches)
  ↓
PATTERN SCAN      (BugBot + Cubic on PR — exhaustive security pattern detection)
  ↓
RECONCILE         (read findings, fix what's real, push back on noise)
  ↓
SIMPLIFY          (one simplify pass over the fix diff, then rerun the tests)
  ↓
MERGE             (human-gated)
```

**Simplify layer.** After fixes land and before the merge, run ONE simplify pass over the audit's own diff
(skill `simplify-pass`): cut bloat, duplication, needless layers and comments with no behaviour change,
and never cut security or trust-boundary checks, input validation, data-loss or error handling, or
accessibility. Rerun the tests and list what the pass removed in the audit report's Recommendations.

Plus a **Phase B one-time deep audit** with 4 categories:
- B/1 Secret leak — git history grep + .env hygiene
- B/2 Database security — RLS / row-policy / role grants (stack-conditional)
- B/3 API route auth — inventory + auth pattern audit
- B/4 Web security posture — CSP / CORS / cookies / session / XSS surface

## Status

**Methodology doc:** ✅ ready ([`methodology.md`](./methodology.md))
**Harness scripts:** ✅ ready ([`scripts/run-audit.sh`](./scripts/run-audit.sh))
**GitHub Apps (BugBot + Cubic):** Cubic trial usable; BugBot currently unavailable until upgrade

The harness is triggerable end-to-end. BugBot/Cubic findings are merged when PR comments/checks are available; reports include a graceful "BugBot not active" note when BugBot is unavailable.

## Usage

```bash
# Full audit
~/.claude/skills/audit-codebase/scripts/run-audit.sh --repo <path-to-your-repo> --phase all

# Specific phase
~/.claude/skills/audit-codebase/scripts/run-audit.sh --repo <path-to-your-repo> --phase B3
```

## Tools used

| Layer | Tool | Status |
|---|---|---|
| In-session review | Claude (any AHI agent) | ✅ ready |
| Second opinion | Codex CLI via `codex-consult` skill | ✅ ready |
| Pattern scan | Cursor BugBot (GitHub App) | unavailable until upgrade |
| Pattern scan | Cubic (GitHub App) | trial usable |
| DB security (conditional) | Supabase CLI | conditional on stack |
| PR workflow | `gh` CLI | ✅ ready |

## Output

Audit reports follow the convention `docs/audits/YYYY-MM-DD-<category>-audit.md` in the target repo and are mirrored to `${AHI_AI_ROOT:-$HOME/ai}/builds/<project>/audits/` for cross-project visibility.

Each report:
- **Summary** — counts by risk + top findings
- **Inventory** — every file/route/config touched
- **Detailed Findings** — each HIGH + MEDIUM with `[SOURCE: file at line N]` citation
- **Recommendations** — ranked by value/effort
- **Out of Scope** — what was deliberately not checked
