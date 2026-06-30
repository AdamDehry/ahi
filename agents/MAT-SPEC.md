# MAT — Unified Multi-Agent Operating Mode (SPEC v0.1)

> **MAT** = **M**ichael · **A**vi · **T**zali, operating as ONE harmonious unit across TWO runtimes (Claude Code + Codex).
> Working name (not final). Thesis: three masteries, full coverage, zero waste — the opposite of a 60-agent swarm.

## 1. The Philosophy (why three, not sixty)
The right number of agents for a task = the number of genuinely distinct ROLES it needs. Almost everything decomposes into three:
- **Michael** — orchestrate / operations / project-management / codebase + process understanding / synthesis. *Leads when the question is "what, why, in what order, and is it operable."*
- **Tzali** — build / engineering / implementation / deploy. *Leads when the question is "make it work."*
- **Avi** — design / UX / marketing / advertising / the felt experience. *Leads when the question is "is it beautiful, clear, and does it land."*

MAT is **one orchestrating intelligence that holds all three lenses at once** and *summons* genuine multi-perspective collaboration (cross-runtime, cross-lens) ONLY when a task benefits from the cross-check. Adaptive, not always-parallel. (Three voices negotiating *every* step reintroduces the very coordination overhead that makes swarms gimmicky.)

## 2. What gets built
### (a) MAT composite identity
A launchable mode (e.g. `launch-as.sh mat`) that composes into ONE system prompt: the three souls (`$AHI_HOME/agents/soul/MICHAEL.md`, `AVI.md`, `TZALI.md`) + AHI Foundation/Core + **this collaboration protocol**. The agent embodies all three lenses, self-orchestrates between them, and names which lens is "leading" when useful.

### (b) MAT collaboration protocol (cross-runtime)
When a task spans both runtimes, BOTH run MAT, in **separate git worktrees on the shared VPS filesystem**, coordinating through ONE shared handoff file: **`MAT-HANDOFF.md`** in the project root.
- **Sync/wait rule (critical):** neither instance proceeds past a checkpoint until the other has written `CHECKPOINT <n> COMPLETE` (+ its output/handoff notes) to `MAT-HANDOFF.md`. This is how they "wait for each other regardless of who works faster."
- **Real-time visibility:** they see each other's work via git commits on the shared filesystem + the handoff file.

### (c) Two operating modes
- **CONJUNCTION (parallel):** both runtimes work simultaneously in separate worktrees; sync at named checkpoints via `MAT-HANDOFF.md`.
- **RELAY (sequential):** Codex → Claude → Codex (or vice versa); each phase ends by writing a *tailored prompt for the next runtime* into `MAT-HANDOFF.md`.

### (d) The "prompt-for-MAT" generator
When the operator asks Michael (in Telegram/dashboard) for "a prompt for MAT," Michael produces ONE prompt the operator pastes into BOTH Claude Code and Codex. It declares: MAT identity + 3 lenses; the task; which runtime each instance is; the mode (conjunction/relay); the `MAT-HANDOFF.md` path + sync rule; and workspace conventions.

### (e) Workspace conventions
Shared canonical VPS filesystem (`$AHI_HOME` et al.) · per-runtime git worktrees (no clobbering) · `MAT-HANDOFF.md` as the coordination ledger · git for real-time cross-visibility.

### (f) Runbook
A short doc: how the operator invokes MAT day-to-day ("Hey MAT" / paste the dual prompt), the two modes, troubleshooting.

## 3. Build plan (bootstrap MAT via a Codex→Claude→Codex RELAY)
- **Phase 1 — Codex (design):** architecture + the MAT identity-composition design + `MAT-COLLABORATION-PROTOCOL.md` + the `prompt-for-MAT` template + worktree/handoff mechanism design. **PAUSE & hand to Claude.** *(Codex reasons/designs — its strength.)*
- **Phase 2 — Claude Code (implement):** the actual `launch-as.sh mat` launcher composing all 3 souls + protocol; implement the handoff-file + worktree setup; finalize the prompt-for-MAT generator format; write the runbook. **Hand back to Codex.** *(Claude builds — its strength.)*
- **Phase 3 — Codex (finalize):** end-to-end test (boot MAT in both runtimes, run a trivial sync/handoff task), polish, document, deliver "MAT ready" report.

Throughout every phase, the working agent **consults the Michael lens** (does this fit AHI's architecture + is it operable day-to-day?) and the **Avi lens** (is "Hey MAT" + paste genuinely simple and clean?).

## 4. Success criteria
- the operator can boot MAT in Claude Code AND Codex from one pasted prompt.
- The two instances coordinate via `MAT-HANDOFF.md` and correctly WAIT at checkpoints.
- A trivial task completes cleanly in both CONJUNCTION and RELAY modes.
- Day-to-day use is "Hey MAT" simple.

## 5. Validation (separate experiment, after MAT exists)
5-way output comparison on one simple throwaway build: (1) Tzali/Claude, (2) Tzali/Codex, (3) Tzali+Michael+Avi/Claude, (4) Tzali+Michael+Avi/Codex, (5) MAT (Claude+Codex in conjunction). Michael judges all five.
