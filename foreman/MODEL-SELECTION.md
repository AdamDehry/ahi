# Model Selection — the three decisions

> Read this at the top of every build. It is deliberately short.
> Live record: `bin/build_ledger.sh`. Enforced by: `bin/fm_model_gate.py` (PreToolUse hook) and by `bin/build_start.sh` itself.
> The model tables below are **current examples**. Vendors ship and retire models often — the operator updates these tables (and `bin/fm_effort.py`) when they do.

Every build makes **three** decisions, never one:

1. **Runtime** — Claude Code or Codex
2. **Model** — which slug inside that runtime
3. **Effort** — how hard it thinks per turn

Two things are *not* decisions, they're routing: **build work goes to Zali, design work goes to Avi**, in whichever runtime the three decisions land on. Identity is sovereign across runtimes — Zali on Codex is the same Zali.

There is a fallback model in `build_start.sh` for a hand-run command outside the live registry, and it is not an answer. The gate refuses any `build_start.sh` against the live registry without explicit `-r -m -e -w`, so the fallback can never fire silently. `-w` is the one-line reason; it lands in `meta.json` and becomes the record the *next* decision reads.

**Decide runtime by fit, and record why.** Not by habit, not by which one you used last. The `-w` line is where the fit is written down.

---

## Claude Code

| Model (example) | What it's for | Notes |
| --- | --- | --- |
| `claude-opus-5-5[1m]` | **The working horse.** Complex agentic coding, long build orders, anything touching security or money. | `[1m]` = 1M context; without the suffix the CLI gives you 200k. New models can need a newer CLI than the one first on `PATH` — the launcher runs `$AHI_FM_CLAUDE_BIN` / `~/.local/bin/claude` for that reason. |
| `claude-fable-5` | The capability ceiling. Held in reserve. | Slower per turn and pricier. |
| `claude-sonnet-*` | Cheap and fast. | Say so in `-w` the first time you try it. |

**Why the ceiling model is not the default:**

- **Price.** Check whether the two models share a tokenizer before stacking a tokenizer penalty on top of the list-price difference — comparing against the wrong baseline overstates the cost.
- **Long turns.** Many minutes inside a single request on hard work. Fine overnight, a nuisance while someone is watching.
- **Safety classifiers can lean hard on security work.** Benign security tasks may draw false-positive refusals.
- **A heavy prompt stack works against it.** Soul files, style cards and step-by-step scaffolding written for older models can be *too* prescriptive for a stronger one. Strip scaffolding and state goals before expecting an upside.
- **Check data-retention requirements** for the model against your org settings before relying on it.

**When the ceiling earns the call:** one hard, long-horizon run — a big migration, an overnight build — where the full spec goes in up front, the scaffolding comes out, and nobody is watching the clock.

---

## Codex

Every slug in this table should have been **probed live** (a one-line `codex exec -m <slug>` turn on the same binary the launcher runs) before it is listed. `build_start.sh` probes codex slugs itself and refuses only when the provider says the slug does not exist.

| Model (example) | Tier | What it's for |
| --- | --- | --- |
| `gpt-6.1-sol` | **default** — near-flagship | The workhorse for codex builds: near-flagship agentic coding at a fraction of the flagship price. |
| `gpt-6-astra` | flagship | Most capable and most expensive. Only when the work is the hardest AND highest-stakes and the default has already fallen short, or when a second opinion must be the strongest available. |
| `gpt-6-luna` | small | Fast and cheap: mechanical fixes, high-volume passes, extraction, classification. |
| older generations | fallback | Only if the current generation misbehaves. Nothing new should pick them. |
| a retired slug | **DO NOT USE** | Remove retired slugs from this table the day the provider retires them (see "Read the error" below). |

Vendor rules worth obeying:

- **A family name like `gpt-6` is an alias.** Use the explicit slug — an alias and a slug don't necessarily behave or bill identically.
- **Don't collapse the family into one tier.** Moving a workload that was intentionally cheap or latency-sensitive onto the bigger model is the classic migration hazard.
- **Very large inputs can reprice the entire request.** Watch this on 1M-context builds.
- **Effort ladders differ per model.** Some models reject `none`, older ones reject `ultra`/`max`. A rejected value is a 400 at launch and the build dies — one more way to score a model on a launcher failure. `fm_effort.py` holds the ladder.

**A model that has never run a build here has no local evidence.** That's not a reason to avoid it; it's a reason to say so in `-w` when you first try one.

---

## Effort

**Two vocabularies, and that is the whole problem.** People read the words off the desktop CLI's
*picker*. Our scripts write a *flag*. They are not the same words, and a doc "corrected" toward one
surface stales the other half. So: both columns, side by side, once. The live table is
`bin/fm_effort.py`; `build_start.sh` applies it, so a picker word is translated rather than passed through.

**Claude Code** — `--effort <level>`

| Picker shows | Pass | Notes |
| --- | --- | --- |
| low / medium / high | same | `high` is the default |
| **extra** | **`xhigh`** | `--effort extra` is *not* an error — it warns and runs at default |
| max | `max` | the top rung |
| **ultracode** | **nothing** | not an effort level at all — see below |

**Codex** — `-c model_reasoning_effort="…"` (validated server-side; a bad value is a 400
`unsupported_value`, so the API is the authority here, not the CLI)

| Picker shows | Pass | Notes |
| --- | --- | --- |
| **light** | **`low`** | |
| medium / high | same | |
| **extra high** | **`xhigh`** | |
| ultra | `ultra` | newer models only; older ones 400 |
| *(not in the picker)* | `none` | some models reject it |
| *(not in the picker)* | `max` | newer models only |

**`ultracode` is not effort.** It sits in the same picker, which is exactly why it reads like a
sixth rung — but it is a *session mode* (multi-agent workflow orchestration), on a different axis
from how hard the model thinks per turn. There is no `--effort` value for it. Order the effort you
want and turn ultracode on inside the session, or by putting the word in the brief.

**The picker and the API can disagree.** A picker may hide a value (say `ultra` on a small model)
that the API accepts. Both facts are true; they are different surfaces. Probe the API before
"fixing" the table from the picker.

**Effort is set per session with `-e`, never with interactive `/effort`** inside a build session —
`/effort` saves as the GLOBAL default and silently changes every later session.

- **`high` is the honest default on both.**
- **`max` mostly buys overthinking.** Both vendors say the same thing in different words: don't globally recommend max. Before raising effort, check whether the real failure is a *missing success criterion, an unclear dependency rule, a tool-routing rule, or a validation loop*. Those are prompt bugs and effort doesn't fix them.
- **`xhigh`** for hard reasoning on Codex; it is what the picker calls "extra high".
- **`low` / `none`** for mechanical work: renames, formatting, extraction, a dry-run you've already specified exactly.

---

## Our record — read the ledger, don't remember it

Run `bin/build_ledger.sh` (or read the record the gate prints when it refuses). It tallies every
build on this machine by model @ effort with clean / bad counts and the `-w` reasons.

**Read the ledger before claiming anything was "never measured".** The record usually has more than
memory does — and a claim of "no evidence" that the ledger contradicts is a wrong answer, not a
cautious one.

Read it honestly:

- **Don't retire a model on a launcher failure — *when the launcher is what failed*.** A build that
  died in two minutes died at launch, not at the work.
- **Read the error, not the runtime.** A **400 `unsupported_value`** (e.g. an effort the model does
  not take) is a launcher-side mistake and says nothing about the model → fix the launcher. A
  **404 `does not exist`** is the provider telling you the slug is gone → retire the model the same
  day. Both present identically at the pane (dead session, short runtime, "launcher failure"), so
  read the two events as one fact or a retired model will keep being re-picked.
- A combination with no rows has no evidence either way. The first cheap build on it should say so in `-w`.
- Rows recorded at "default" effort are a record of *not choosing*. Every new row carries an explicit effort and a reason.

---

## Choosing, in practice

| The build looks like… | Take (example slugs) |
| --- | --- |
| Long multi-file build order, worktree, gates and a record to write | `claude` / `claude-opus-5-5[1m]` / `high` |
| Same, but security, money, customer data, or anything irreversible | `claude` / `claude-opus-5-5[1m]` / `xhigh` |
| Hard reasoning, a review, a diagnosis, a second opinion on Claude's work | `codex` / `gpt-6.1-sol` / `xhigh` |
| The hardest, highest-stakes call where the default already fell short | `codex` / `gpt-6-astra` / `xhigh` — far pricier, earn it |
| Mechanical: rename, format, one-file fix you've already fully specified | `codex` / `gpt-6-luna` / `medium` — cheapest thing that can't get it wrong |
| High volume, many small identical passes | `codex` / `gpt-6-luna` / `none`–`low` |
| One hard overnight run, full spec up front, scaffolding stripped | `claude` / `claude-fable-5` / `high` |
| Two lanes on the same tip, one builds and one grades | Different runtimes on purpose — a grader that shares the builder's blind spots isn't grading |

**Never use a bare alias** (`opus`, `fable`, `sonnet`, `gpt-6`, …). Aliases resolve silently to
whatever the CLI maps them to — and that has been a generation behind. **Pin the full slug.** The
gate blocks the known aliases.

---

## Freshness

Prices, context limits and model lists go stale fast. **Re-verify against the vendor docs before
quoting money or capability to anyone** — a stale copy of this file is exactly how a wrong answer
gets given with confidence. Where a CLI's bundled docs and the vendor's live docs disagree, the live
docs win.
