# Code Audit Methodology

> **Origin:** generalized from Yacov Derhi's All Point Garage workflow (2026-05-19),
> which synthesized Robin Ebers' methodology with the ELIEZER_PROTOCOL §"Use Codex for
> External Review" + a 4-bucket Phase B audit. Project-specific references and the
> Capacitor native-bridge audit have been stripped or replaced; the methodology below
> is stack-agnostic for any web codebase with a GitHub remote.

---

## The 3-layer review model

Three reviewers, three different blind spots. **You want all three.** They catch different things:

| Layer | When it runs | Strength | Blind spot | Cost |
|---|---|---|---|---|
| **In-session AI (Claude / agent)** | During writing, conversational | Logic bugs, scope creep, design trade-offs, spec adherence, asking the right clarifying question | Doesn't exhaustively scan for known security patterns unless asked | Per-token in the active session |
| **Codex CLI** | On-demand during a session | Different base model (GPT-5 family) → independent blind spots; catches what the in-session model misses; "could this be simpler?" challenges | Same as in-session model + lacks conversation context | Per-token when invoked (uses Codex Plus / OpenAI auth) |
| **BugBot + Cubic (GitHub Apps)** | Automatically on every PR | Pattern detection at scale — hundreds of known vulnerability patterns (SQL injection, auth bypass, exposed secrets, weak crypto). Trained on millions of code reviews. EXHAUSTIVE per diff. | Won't catch design issues or business-logic bugs — only known patterns | Subscription (free tier covers light usage; ~$20-40/month each for heavy use) |

**Analogy:**
- In-session AI = senior engineer who knows the spec + codebase, catches design + logic
- Codex = different senior engineer reviewing the work — independent eyes catch what the first missed
- BugBot + Cubic = automated security scanners on every diff — catch the patterns humans forget to check

---

## When each layer fires

```
                       ┌──────────────────────────────────┐
WRITE                  │  In-session AI                    │
                       │  - Read spec / direction          │
                       │  - Make design + scope decisions  │
                       │  - Write the code                 │
                       └──────────────┬───────────────────┘
                                      │
                                      │  (mid-task spot-check)
                                      ▼
SECOND-OPINION         ┌──────────────────────────────────┐
                       │  Codex CLI (on-demand)            │
                       │  via codex-consult skill          │
                       │  → independent eyes on the diff   │
                       └──────────────┬───────────────────┘
                                      │
                                      │  (commit + push to branch)
                                      ▼
SCALE-PATTERN-CHECK    ┌──────────────────────────────────┐
                       │  Cursor BugBot + Cubic (PR-time)  │
                       │  - GitHub Apps on the repo        │
                       │  - Run on every PR automatically  │
                       │  - Post comments inline on diff   │
                       └──────────────┬───────────────────┘
                                      │
                                      │  (in-session AI reads findings)
                                      ▼
RECONCILE              ┌──────────────────────────────────┐
                       │  In-session AI addresses bot      │
                       │  findings                          │
                       │  - Fix what's real                 │
                       │  - Push back on noise / explain    │
                       │  - Commit to same branch           │
                       └──────────────┬───────────────────┘
                                      │
                                      │  (final approval)
                                      ▼
MERGE                  ┌──────────────────────────────────┐
                       │  Human reviews + merges to main   │
                       │  CI auto-deploys                  │
                       └──────────────────────────────────┘
```

---

## The PR workflow

Once BugBot + Cubic are installed on the target repo, all non-trivial changes flow through PRs:

```bash
# 1. Create a feature branch off main
git checkout -b feature/<scope>

# 2. Make changes + commit
git add ...
git commit -m "..."

# 3. Push the branch (NOT main)
git push origin feature/<scope>

# 4. Open a Pull Request
gh pr create --title "..." --body "..."

# 5. Wait ~30-60 sec for bots
#    - BugBot posts inline comments on the diff
#    - Cubic posts a summary review

# 6. Read findings, address them via additional commits
#    on the SAME branch. Each new commit triggers re-review.

# 7. Once findings are addressed → human clicks Merge in GitHub UI
#    - Squash-merge to keep main linear
#    - Or merge-commit if branch history matters

# 8. CI auto-deploys on push-to-main (which is what merging the PR does)
```

**Key principle:** `main` is sacred. Nothing lands there without bot review.

For sprint-mode work or hot patches where direct-to-main commits are unavoidable, the Phase B one-time audits below remain the safety net.

---

## Phase B — the one-time deep-dive audit

A targeted 4-category audit that runs once before launch (and re-runs after major migrations). Designed to catch what PR-time bots can't see in pre-existing code.

| Phase | What | Tool | Output |
|---|---|---|---|
| **B/1** Secret leak | `git log -p` pickaxe across history + `.env` shape check | Bash + grep | `docs/audits/YYYY-MM-DD-secret-leak-audit.md` — should be empty if clean |
| **B/2** Database security | Row-level-security / role grants / advisor warnings | Stack-conditional (Supabase CLI / Postgres direct / Firebase rules / etc.) | `docs/audits/YYYY-MM-DD-database-security-audit.md` |
| **B/3** API route auth | Inventory of every API handler + auth pattern audit | Manual walk + sub-agent | `docs/audits/YYYY-MM-DD-api-route-auth-audit.md` |
| **B/4** Web security posture | CSP headers, CORS, cookie security, session hygiene, XSS surface, dependency CVE check | Manual + `npm audit` / equivalent | `docs/audits/YYYY-MM-DD-web-security-posture-audit.md` |

**Note on B/2:** the specific tooling depends on the stack.
- **Supabase:** `supabase db advisors --linked` surfaces security warnings
- **Postgres direct:** manually inventory `GRANT`s, `REVOKE`s, row-policies
- **Firebase:** review Security Rules + Firestore indexes
- **No backend DB:** skip B/2 entirely

**Note on B/4:** this replaces what was the Capacitor-bridge audit in the original All Point Garage workflow. For native-mobile-bridged apps (Capacitor / React Native / etc.), see the separate `audit-native-bridge` skill (not yet built).

---

## Audit report structure

Every audit doc follows this skeleton:

```markdown
# <Audit Category> Audit — <Project Name>
Date: YYYY-MM-DD
Author: <agent or human>
Scope: <what was audited>
Method: <how it was audited>

## Summary

- HIGH: N
- MEDIUM: N
- LOW: N

Top 3 findings:
1. ...
2. ...
3. ...

## Inventory

| Item | Path | Status | Notes |
|---|---|---|---|
| ... | ... | ... | ... |

## Detailed Findings

### HIGH-1: <short title>

[SOURCE: `path/to/file.ts` at line 47]

<description of the finding, why it matters, what an attacker / user could do>

**Recommendation:** <specific fix>

---

(repeat for each HIGH + MEDIUM)

## Recommendations (ranked by value / effort)

1. **<title>** — value: high · effort: low — <one-liner>
2. ...

## Out of Scope

- <thing that was deliberately not checked>
- <thing that's a separate audit's job>
```

**Source citation rule:** every HIGH or MEDIUM finding must include a `[SOURCE: file at line N]` label. No findings without citations. (Borrowed from ELIEZER_PROTOCOL Rule 14d.)

**Naming convention:** `docs/audits/YYYY-MM-DD-<category>-audit.md` in the target repo, plus a mirror to `~/ai/builds/<project>/audits/` for cross-project visibility.

---

## Day-to-day audit cadence

```
Day-to-day feature work:
  1. Write code (in-session AI)
  2. Optional: codex-consult for substantial changes
  3. Branch + PR
  4. BugBot + Cubic auto-review (every PR)
  5. Address findings
  6. Human merges

One-time deep audits (quarterly or after big migrations):
  - Phase B/1 secret leak (5 min)
  - Phase B/2 DB security (5 min)
  - Phase B/3 API route inventory (re-run if route count grows >30%)
  - Phase B/4 web security posture (re-run if dependencies changed materially)

After incidents:
  - Read the post-mortem
  - Add the relevant detector to the audit pipeline so we never hit it twice
```

---

## Quick-reference card

```
WORKFLOW
  Code → Codex check → Branch+PR → BugBot+Cubic → Address → Merge → Deploy

TOOLS
  In-session AI = whoever is in the active session
  Codex         = CLI, on-demand, via codex-consult skill
  BugBot        = GitHub App, PR-time, https://cursor.com/bugbot
  Cubic         = GitHub App, PR-time, https://www.cubic.dev (via itsbyrob.in/cubic)

ONE-TIME AUDITS (Phase B/1-4)
  /1 Secret leak     — git log -p | grep <patterns>
  /2 DB security     — stack-specific (Supabase advisors / Postgres grants / Firebase rules)
  /3 API auth model  — inventory all API route handlers + check auth on each
  /4 Web posture     — CSP, CORS, cookies, session, XSS, dependency CVEs

EVERY-PR AUDIT (bots)
  BugBot — pattern detection at scale (security + quality)
  Cubic  — complementary pattern detection (different ML model)

WHAT EACH CATCHES
  In-session AI → design + spec + logic
  Codex         → simpler approaches + first model's blind spots
  BugBot        → SQL injection, auth bypass, exposed secrets, weak crypto
  Cubic         → similar surface, different specific detectors
```

---

## Implementation status

| Component | Status |
|---|---|
| Methodology doc (this file) | ✅ ready |
| Harness scripts (Phase B/1, B/2, B/3, B/4 automation) | ✅ live — `scripts/run-audit.sh` |
| Codex integration (B/3 + B/4 second-opinion) | ✅ live via `~/ai/skills/codex-consult/codex_consult.sh` |
| Bot findings reader (`gh pr view --comments` parser) | ✅ live — `scripts/read-pr-bot-comments.sh` |
| BugBot install on the user's business CRM repo | unavailable until upgrade; reports note "BugBot not active" |
| Cubic install on the user's business CRM repo | trial usable; PR comments/checks are pulled when present |

`Skill(audit-codebase)` is now an end-to-end triggerable workflow. First real audit target: the user's business CRM, output mirrored to `~/ai/builds/business-crm/audits/`.
