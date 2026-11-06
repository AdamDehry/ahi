# FOREMAN → SUPERVISOR BRIEFING CONTRACT

**Implementation:** `bin/fm_brief.py`, called from `fm_wake_michael()` in `bin/lib.sh`.
**Scope:** communication layer only. This document grants no authority, removes no
protection, and contains no security control. It governs how the foreman *labels* what it
sends to the supervisor (Michael) and how that renders for the owner.

---

## 1. WHAT IT DOES, IN ONE PARAGRAPH

Every foreman message to the gateway passes through `fm_wake_michael()`. One additive block in
that single chokepoint pipes the payload through `fm_brief.py classify`, which classifies it,
appends the whole thing verbatim to `$FOREMAN_ROOT/briefings/<build-id>.jsonl`, and emits a
short instruction envelope plus a **concise body** — not the raw transcript. If the classifier
is missing or broken in any way, the wake goes out exactly as it would without it.

---

## 2. THE CLASSES

| Class | User-facing output | How it is assigned |
|---|---|---|
| `INTERNAL` | **none** | a fixed-plumbing transport, declared by the call site |
| `CHECKIN` | `FOREMAN CHECK-IN` | an executor-bearing transport (idle report, stall), declared |
| `PROGRESS` | `BUILD PROGRESS` | the terminal-close transport, declared by `build_done.sh` |
| `DECISION` | `DECISION REQUIRED` | **only** an ask the executor declared in its own report |
| `ORDINARY` | none, and no envelope | fallback: unlabeled, malformed, or safety-vetoed — raw bytes |

### 2.1 Prose never selects the class
Inferring the event type from mutable prose — the executor's report or the human-chosen build
name — fails in the direction that costs the owner something: an unrelated "No" can demote a
real authority ask, and a build *named* "retry review" can trip a plumbing word list. So the
class comes from **declarations**, never from payload text:

1. **Transport kind — declared by the call site**, which always knows it. Resolved as an atomic
   pair: `--producer/--transport` argv first, then the `FM_BRIEF_PRODUCER` /
   `FM_BRIEF_TRANSPORT` environment pair, then a closed one-entry caller map
   (`build_done.sh` + `FM_BRIEF_CLASS=PROGRESS`). A partial declaration is never completed from
   another source.
2. **Executor ask — declared by the author of the report.** Only the executor knows whether its
   report asks for a ruling; a shell script that merely forwards the report cannot. So no shell
   may declare DECISION.

### 2.2 The producer matrix
Every live call site is a row; a producer using a transport outside its row is a **contract
failure** (the formatter raises, the hook fails open). A transport with no producer is rejected
too — a class you can claim without saying who you are is not a declaration.

| producer (call-site id) | transport | base class |
|---|---|---|
| `build_done.sh:terminal-close` | `terminal-close` | PROGRESS |
| `foreman_wake.sh:idle-report` | `idle-report` | CHECKIN |
| `foreman_wake.sh:stall` | `stall` | CHECKIN |
| `foreman_wake.sh:retry`, `foreman_notify.sh:permission-retry` | `retry` | INTERNAL |
| `foreman_notify.sh:permission-dialog` | `permission` | INTERNAL |
| `foreman_heartbeat.sh:died` / `:parked` / `:dark` | `heartbeat` | INTERNAL |
| `fm_stop_watch.sh:idle-stop` | `stop-watch` | INTERNAL |
| `foreman_codex_notify.sh:unknown` | `codex-notify` | INTERNAL |
| `lib.sh:deferred-replay` | `replay` | the *original* wake's class |

`replay` is a carrier: a deferred wake is re-sent with its original producer/transport, and if
that origin is absent or fails the matrix it falls to ORDINARY raw.

Adding a producer means adding a row to `PRODUCERS` in `fm_brief.py` and declaring the pair at
the call site. An undeclared call site is **UNLABELED** and goes out as ORDINARY raw — visible,
never silent.

### 2.3 The executor ask block
An executor that needs a ruling ends its report with:

```
#FMASK1
kind: authority
what: <one line saying what is being asked>
#FMASK-END
```

- `kind` is one of `authority | scope | tradeoff | blocked`, or `none` for an explicit *no ask*.
- Only `kind` and `what` are allowed. Duplicate or unknown fields, an unknown kind, a real kind
  without `what`, or `none` with a `what` ⇒ **malformed ⇒ ORDINARY raw**: the executor tried to
  say something the formatter could not read, so it is shown, not interpreted.
- The **last** block wins, so the executor's own final block beats a quoted one above it. A
  quoted or forged block can only manufacture a DECISION where none was needed — noise, never
  silence.

`kind: none` and *no block at all* render the same class (CHECK-IN) but different envelope
heads: one states the executor's declaration and attributes it; the other says nobody declared
anything and tells the supervisor to read the report.

### 2.4 The safety veto
The one place prose is read. On an executor-bearing CHECK-IN, an unmistakable authority phrase
(sudo, root access, credential, API key, "pending your/the owner's ruling", "should I", …)
**invalidates the no-reply declaration and forces ORDINARY raw**. It reads the payload minus
the transport-written header line and provenance — position decides authorship, not content —
so a build name cannot trip it. It has no negation model on purpose: a false positive costs
visibility only. It never assigns DECISION, and it never applies to fixed-plumbing transports,
so plumbing cannot talk its way into a visible format.

### 2.5 Event meaning
- A **terminal build outcome** (done / failed / abandoned) is a visible BUILD PROGRESS milestone.
  Every close wakes once; queue/chain continuation rides along as context of that one event.
- A **substantive executor stop** the supervisor can resolve is a visible FOREMAN CHECK-IN.
- **The standard gate banner** (`GATE-RECONCILE GREEN …`, `GATE-SET CARRY …`) is stripped
  before any rule runs: the foreman staples it onto every wake, so letting it vote would let a
  transport decoration override every event it decorates. A **gate alarm**
  (`!!! GATE-RECONCILE RED …`) is not the banner — it stays and is carried into every body.

### 2.6 Negative controls — these must NEVER classify DECISION
1. permission dialog for an action inside the brief's scope — the supervisor approves
2. "zero builds active, queue not empty" chain wake — the supervisor starts the next item
3. executor asking its supervisor a question — the supervisor answers *(may render CHECK-IN; the
   executor's question does not survive into the owner-facing output)*
4. a stalled or dark build — the supervisor diagnoses from metadata
5. gate-reconcile notice
6. harness-originated wake (already suppressed upstream)
7. a turn refused or blocked by policy — the supervisor reports; it does not ask
8. wake refused by the concurrency wake guard

DECISION exists only behind a declared executor ask, so none of these can reach it. Those carried
by fixed-plumbing transports are INTERNAL; any that arrive unlabeled are ORDINARY raw.

---

## 3. THE THREE OWNER-FACING FORMATS

The supervisor writes these; the envelope instructs the form. Bold header on its own line, one
blank line, bullets with the colon **inside** the bold span, one plain-English sentence per field
(1–3 for *Why this stopped*), message ends with exactly one newline.

### BUILD PROGRESS
```
**BUILD PROGRESS — no reply needed**

- **Finished:** <past tense, what is actually done>
- **Now:** <present tense, what is running>
- **Michael's steer:** <what was directed, or "None this cycle, because …">
- **Acceptance:** <a plain verified count>
```

### FOREMAN CHECK-IN
```
**FOREMAN CHECK-IN — no reply needed**

- **Executor finished:** <past tense>
- **Executor stopped at:** <where it halted, and why>
- **Michael needs to inspect:** <what the supervisor will look at>
- **Next expected action:** <what happens next, and who does it>
```
**Zero `?` characters** in PROGRESS and CHECK-IN, and **no category** — category belongs to
DECISION alone.

### DECISION REQUIRED
```
**DECISION REQUIRED — <category>**

- **Why this stopped:** <plain English, 1–3 sentences>
- **My recommendation:** <one sentence, and it must pick one>
- **Why you might choose differently:** <one honest counterpoint>

<exactly one direct question, ending in ?>
```
`category` from `authority | scope | tradeoff | blocked`. **Exactly one `?`**, ending the last
line. Before sending, the supervisor restates all three tests or downgrades: (a) it cannot be
resolved within authority the supervisor holds; (b) it needs an authority the supervisor lacks —
sudo, spend, production push, deletion, credential, external communication — or is outside the
brief's scope; (c) there are at least two genuinely available options. **Two out of three is not
a decision. It is a report.** "I have no recommendation" fails; so does an empty counter-case.

The legacy label `Why you might not:` is accepted on inbound parsing only and never emitted.

### Caps and content rails
Per field 200 visible characters (*Why this stopped* 400), question 120, whole message 900.
Field values and the question must not contain: filesystem paths or filenames, dates, clock
times, durations, hashes, internal ids (build ids, gate/item ids, tmux sessions), agent persona
names, screaming-caps markers, diagnostics or byte/token counts, machine-status evidence,
usage/quota lines, model tiers, correction history, process narration, formatter vocabulary, raw
wake text, commands or flags, environment variables, or code literals. Digits are allowed only in
`Acceptance:`, as a plain count.

### Ordinary updates
Anything that is not build traffic gets **no envelope and no headers** — a short paragraph, or
at most five compact bullets. A contract that colonises normal conversation has replaced one
noise problem with another.

### Tools
```sh
printf '%s' "$msg" | python3 -B "$FOREMAN_ROOT/bin/fm_brief.py" validate      # 0 accepted, 1 rejected
echo "$json"       | python3 -B "$FOREMAN_ROOT/bin/fm_brief.py" render        # fields → exact bytes
printf '%s' "$raw" | python3 -B "$FOREMAN_ROOT/bin/fm_brief.py" strip-inbound # plain English only
```
`validate --format progress|checkin|decision|ordinary` forces a format; the default autodetects.
`render` takes `{"format","fields","category","question","build_id"}` and, if its own output
fails a rail, prints one safe fallback line instead and records the full rejection in
`briefings/brief-presentation.jsonl` (second sink: `FM_BRIEF_PRESENTATION_EMERGENCY_LOG`).
Validation is **advisory** — see §6.

---

## 4. WHAT CROSSES THE WIRE, AND WHAT IS KEPT

**The raw payload travels no further than the ledger.**

- **INTERNAL** sends a minimal envelope: the header line, `build · caller · axis`, any gate alarm
  or deferral note, and the ledger pointer. Nothing else.
- **CHECK-IN / PROGRESS / DECISION** send the envelope plus a thinned body: the producer's own
  short structured lines, the last 400 characters of the fenced executor report (CHECK-IN and
  DECISION), gate alarms, the deferral note, one provenance line, and the ledger pointer —
  always last. The instruction menu, the transcript and pane chrome stay behind.
- **Canonical:** if the producer already wrote one of the §3 formats and it passes every rail,
  those bytes go out untouched and **without** an envelope.
- **ORDINARY** is byte-identical passthrough.

**Law A — the delivered bound.** Formatted output (envelope + blank line + body) is at most
**2,499 UTF-8 bytes**; every appended line is capped at 300 bytes; facts are admitted whole or
not at all; the envelope is never clipped; the pointer is never cut. Dropped facts are always
announced by a fixed clipped-body notice. A canonical message over the bound is not clipped — it
fails, and the hook falls open — because a clipped binding format is a well-formed lie.
**Law B — named exemptions.** ORDINARY passthrough and hook fail-open are never clipped: a
ceiling that clips a fail-open is the silencing this contract exists to prevent.

### The ledger
Every classified wake, **whatever its class**, is appended to
`$FOREMAN_ROOT/briefings/<build-id>.jsonl` (`FM_BRIEF_LOG_DIR` overrides the directory), fsync'd,
**before anything is emitted**. Fields include `ts`, `build_id`, `class`, `category`, `raw`
(byte-identical payload), `wire` (exactly what was delivered), `body`, `rendered` (owner-facing
text: canonical bytes, otherwise `""`), `canonical`, `envelope`, `caller`, `producer`,
`transport`, `declaration_source`, `axis` (which rule decided), byte counts, `facts_offered` /
`facts_delivered` / `facts_dropped`, `delivery_mode` and `raw_over_bound`.

A failed append is a hard failure: the formatter exits non-zero and the hook ships the unthinned
wake. A classifier exception is itself recorded (`fail_open: true`) before it propagates, and a
raw delivery over the Law-A bound is flagged as `raw_over_bound` so it can be counted.

Harness-suppressed wakes and wake-guard refusals return from `fm_wake_michael` *before* the hook;
they are preserved verbatim in `suppressed-wakes.log` and `refused-wakes.log` instead.

---

## 5. THE HOOK

One additive block in `fm_wake_michael()`, after the harness check and the concurrency wake
guard, immediately before the POST. Both guards return before reaching it, so it cannot alter
either.

**FAIL-OPEN IS NON-NEGOTIABLE.** `fm_brief.py` absent, unreadable, erroring, timing out (5 s),
emitting garbage, nothing, or a broken frame ⇒ the wake is the original payload, byte for byte.
The frame is: first line `#FMBRIEF1`, last line `#FMBRIEF-END`, non-empty body between.

| variable | effect |
|---|---|
| `FM_BRIEF_DISABLE=1` | operator kill-switch — every wake goes out unformatted |
| `FM_BRIEF` | path to an alternative `fm_brief.py` |
| `FM_BRIEF_LOG_DIR` | ledger directory |

Rollback is the kill-switch, or removing `bin/fm_brief.py`. No gateway change is required: the
gateway sees an ordinary `/ui/send` text.

A formatter that can silence the foreman's only wake source is far worse than the noise it
removes.

---

## 6. WHAT THIS CONTRACT DOES NOT DO

Stated here because a control that oversells itself ends the search.

1. **It is not a security boundary.** Any process running as the same Unix user can call
   `fm_wake_michael` or the formatter directly. What it proves is separation from payload and
   name *data*, plus a code-level producer contract; it does not authenticate processes.
2. **The format validator is advisory.** Nothing forces the supervisor to run it. Enforcement
   would have to live in the gateway.
3. **The safety veto is a phrase list** and cannot catch every authority phrasing. That is why
   the undeclared CHECK-IN envelope tells the supervisor to read the report rather than claiming
   no authority is asked for.
4. **CHECK-IN is a second visible channel** and can be over-used until it becomes the noise it
   was meant to remove.
5. **PROGRESS vs DECISION vs CHECK-IN remains the supervisor's judgement** after the machine
   has classified correctly. "Exactly one `?`" is satisfiable by a question that asks nothing
   real, and nothing stops a memo outside the formats.
6. **The hook checks framing, not containment.** A well-framed rewrite reaches the wire; only a
   broken frame falls open. Detection of a silent rewrite lives in the ledger's `raw`/`wire`
   pair.
7. **The minimal internal envelope costs a read.** A permission-dialog wake carries the pointer,
   not the dialog; the supervisor opens the ledger to see what is asked before approving.
8. **The pane-chrome list is an enumeration.** An unrecognised chrome line costs excerpt space,
   never substance, but the list cannot be proven complete.
9. **Every close wakes.** If build volume rises, this is the line to revisit — measured as wakes
   per day, not by whether any single one felt necessary.

A classifier miss falls to ORDINARY: no envelope and the original bytes. **A miss can never
silence a wake; it can only fail to quieten one.**

---

## 7. VERIFYING AN INSTALL

Read-only, against a scratch ledger:

```sh
export FM_BRIEF_LOG_DIR="$(mktemp -d)"
printf '%s\n---\n%s\n---\n' '(foreman wake — build 20250101-000000-demo / "demo")' \
  'I finished the parser and stopped before the migration.' |
  FM_BRIEF_PRODUCER=foreman_wake.sh:idle-report FM_BRIEF_TRANSPORT=idle-report \
  python3 -B "$FOREMAN_ROOT/bin/fm_brief.py" classify
# expect: #FMBRIEF1 / [BRIEF CHECK-IN …] / thinned body / full payload: … / #FMBRIEF-END
printf 'unlabeled text' | python3 -B "$FOREMAN_ROOT/bin/fm_brief.py" classify   # ORDINARY: raw back
printf 'x' | FM_BRIEF_TRANSPORT=stall python3 -B "$FOREMAN_ROOT/bin/fm_brief.py" classify; echo "rc=$?"  # 2: fail open
```

Each run appends one JSON line under `$FM_BRIEF_LOG_DIR`; its `class` and `axis` say why.

---

## 8. OPTIONAL: A QUIET FOREMAN-WAKE ENDPOINT

The public gateway exposes `/ui/send`, and that is all this contract needs. A gateway may also
implement a quiet foreman-wake endpoint (`/foreman/wake`) that runs the same supervisor turn
without broadcasting the wake into the owner's feed, keeping the supervisor's reply on the
build's timeline. `fm_wake_michael` tries it first and **falls back to `/ui/send` on 404/405**;
`FM_WAKE_ENDPOINT=legacy` skips it.

With such an endpoint, the owner's chat gets only messages the gateway renders from **status
records** (`bin/fm_status.py emit` in the executor's worktree; fixed-wording records from
`build_done.sh`, the heartbeat and `build_ask.sh`):

| record kind | owner's chat |
|---|---|
| `needs_owner` | "I need you — <build>" + the one question (also transcribed as an `#FMASK1` block, so the supervisor's envelope is DECISION) |
| `closed` | "Build closed — <build>" + Finished / Result, once per build |
| `failed` | "Build failed / went dark / stopped — <build>" + one sentence, once per build per family |
| `progress` | nothing — build timeline only |

Same fail-open law: a failed status post is logged and never stops a wake or a close, and harness
registries cannot post status records. Without the endpoint, everything in §1–§7 still holds.
