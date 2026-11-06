# ACTIVE GATES — the machine-readable carry-copy

**This file is read by machines. QUEUE.md stays the authored home of every
ruling; this is the copy that TRAVELS.** The rule it serves (GATES-TRAVEL):

> A gate written in QUEUE.md reaches the turn that reads the queue and stops
> there. Every spawn prompt carries the active gate list VERBATIM — not a
> paraphrase, not "respect the gates".

`bin/fm_gates.py render` turns the active entries below into the gate block
prepended to every build prompt; `render --for subagent` is the block a parent
pastes into a spawn prompt; `bin/fm_gate_guard.py` (a PreToolUse hook) refuses
a subagent spawn whose prompt does not carry it and enforces every `forbid:`
rail. On a fresh install, copy `templates/QUEUE.md` to `$FOREMAN_ROOT/QUEUE.md`:
it holds the authored rulings these starter gates are anchored to.

## How to change a gate

1. Write it in QUEUE.md as always — that is where rulings are made.
2. Carry it here. Mechanically: `bin/fm_recarry.py --add '<head prefix>' --key KEY`
   (dry run, then `--write`) for a new ruling, or `bin/fm_recarry.py KEY`
   (diff, then `--write`) after editing an existing one. By hand: copy the
   ruling text into the `<<<VERBATIM` block **exactly**.
3. Refresh its `digest:` — `bin/fm_gates.py check` prints the actual digest when
   it disagrees, so the by-hand workflow is: edit → check → paste the digest it
   names → check again.
4. `bin/fm_gates.py check` must PASS before the gate is trusted, and every build
   launch refuses while it does not. It fails loudly on MISSING-IN-QUEUE,
   AMBIGUOUS-ANCHOR, QUEUE-DRIFTED, TRANSCRIPTION-DIVERGED and UNCARRIED. **A new
   ruling written to QUEUE.md and not carried here is an UNCARRIED failure** —
   that is the check that stops the travel hole reopening one level up.
5. Set `blocks:` and `forbid:` by hand; no tool guesses them. They are judgements
   about what a ruling STOPS.

Comparison is whitespace-normalised full text plus a sha256 per block. It is not
a line-based grep, deliberately: a `grep -lE` once reported a gate ABSENT
because the phrase wrapped across a newline.

## Entry grammar

Every line outside a `<<<VERBATIM` block that looks like `key: value` is read as
a field, so prose in this header never starts a line that way. `scan_from:`
(once, above the first entry) is the QUEUE.md line where the coverage scan
starts. Each entry is a `## GATE <KEY>` heading followed by:

- `ruling:` the ruling id (`R-` owner, `F-` supervisor, `G` gate/status, `D-` decision).
- `authority:` who ruled — `Owner` or `Michael`.
- `dated:` required. The date of the ruling; the starter gates use the neutral
  value `starter`.
- `status:` `active` gates are rendered into every prompt. Anything else
  (`superseded`, `historic`, `cleared` …) is carried for coverage, so it cannot
  read as UNCARRIED, but is not rendered; say why in `note:`.
- `deliver:` `prompt` (informational today).
- `blocks:` optional, repeatable, one target per line — a phase/item id the chain
  must not name as next while this gate is active (`fm_gates.py gates-blocking`).
  The id must label a checkbox line in QUEUE.md (`Phase 3A …` or a leading
  `W-1 —`), or check reports UNKNOWN-BLOCK-TARGET. `fm_gates.py
  undeclared-blocks` flags a ruling whose text blocks a phase it never declared.
- `anchor:` the exact QUEUE.md head line, comment marker included.
- `digest:` `sha256:` of the normalised QUEUE.md block (`check` names it).
- `hazard:` optional. `disclosure` means the rails also apply to read-only
  commands (`cat`, `grep`, `head` …), because for a secret, reading IS the
  dangerous act. Any other value is treated as disclosure and warned about.
- `forbid:` optional, repeatable — one MECHANICAL rail per line, enforced by
  `fm_gate_guard.py`. Clauses joined with `&&`, all must hold: `cmd=~<re>` /
  `cmd!~<re>` on the command text, `ctx=~<re>` / `ctx!~<re>` on "cwd + space +
  command". Case-insensitive. A malformed clause is reported, never silently
  dropped. Most gates carry no rail, and that is honest: they are knowledge
  rails, not pattern-matchable actions. Saying so beats a regex that pretends.
  Scope a rail with `ctx` rather than banning a verb everywhere — a rail nobody
  can work with gets routed around.
- `forbid_why:` optional, once — printed with every refusal.
- then the ruling text between a `<<<VERBATIM` line and a `VERBATIM` line.

Compact delivery (the default, `FM_GATES_MODE=compact`): gates whose key starts
with `PAUSE`, plus the keys in `FM_GATES_INLINE_KEYS` (default
`GATES-TRAVEL,CREDENTIALS-NEVER-DELEGATED`), travel verbatim; every other active
gate travels as its first line, with the full text installed beside the build at
`.foreman/ACTIVE-GATES.md`. `FM_GATES_MODE=verbatim` carries everything in full.

## Starter gates

Six general-purpose gates distilled from running supervised builds. Keep them,
edit them (in QUEUE.md first), or retire them with `status: historic`.

The `R-1` rails below are a worked example scoped to a systemd unit named like
`ahi-gateway` and a live tree at `…/ahi/gateway`. If your service or install
path differs, edit the regexes — and prove each rail with a canary command it
refuses and a neighbouring command it allows.


scan_from: # ── RULINGS — every gate-shaped block below this line must be carried in ACTIVE-GATES.md ──


## GATE PAUSE-FOR-OWNER
ruling: R-0
authority: Owner
dated: starter
status: active
deliver: prompt
anchor: # PAUSE FOR OWNER — non-negotiable, regardless of what the chain says next:
digest: sha256:6195d8bb18bb60b6a56b0c51caf4d1df
<<<VERBATIM
PAUSE FOR OWNER — non-negotiable, regardless of what the chain says next:
  live credential rotation · production deploy relink or cutover · deletion of possibly-unique
  data · permanent worktree retirement · destructive history change · live-tree migration.
  Work that reaches one of these STOPS, states exactly what it would do and why, and waits for
  the owner's explicit yes. A yes for one instance is not a standing yes for the class.
VERBATIM

## GATE GATES-TRAVEL
ruling: F-1
authority: Michael
dated: starter
status: active
deliver: prompt
anchor: # F-1 GATES DO NOT INHERIT, SO THEY MUST BE CARRIED. A gate written in QUEUE.md reaches the turn
digest: sha256:172bb58a8ca0eb588b590e9b04f81ae3
<<<VERBATIM
F-1 GATES DO NOT INHERIT, SO THEY MUST BE CARRIED. A gate written in QUEUE.md reaches the turn
  that reads the queue and stops there. Every build prompt and every subagent spawn prompt
  carries the active gate block VERBATIM — not a paraphrase, not "respect the gates". The
  foreman renders it (`fm_gates.py render --for subagent`) and the PreToolUse guard refuses a
  spawn whose prompt does not carry it. A subagent that was never told is not disobedient; it is
  uninformed, and that is the parent's defect.
VERBATIM

## GATE CREDENTIALS-NEVER-DELEGATED
ruling: F-2
authority: Michael
dated: starter
status: active
deliver: prompt
hazard: disclosure
forbid: cmd=~\bcrontab\s+-l\b && cmd!~(grep\s+-c|wc\s+-l|>\s*\S)
forbid: cmd=~\b(cat|less|more|head|tail|bat|nl|strings|xxd|od|grep|rg|sed|awk)\b[^|;&]*(\.env\b(?![.-]?(example|sample|template))|/\.secrets/|\.credentials\.json) && cmd!~(grep\s+-[a-z]*[cq]|wc\s+-l)
forbid: cmd=~(^|[;&|(]\s*)(printenv|env|export\s+-p|set)\s*($|[;&|)])
forbid_why: Rails cover the commands that put a secret on stdout: reading an env/secrets/credentials file, `crontab -l`, and a full environment dump. hazard: disclosure applies them to read-only commands too, because for a secret, reading IS the act. Counting is allowed (`grep -c`, `grep -q`, `wc -l`) and so is redirecting `crontab -l` to a file — verify by count, never by content. A refusal here never means "find another way to print it".
anchor: # F-2 CREDENTIAL WORK IS NEVER DELEGATED, AND A SECRET NEVER REACHES A TRANSCRIPT. Prompt rails
digest: sha256:e885fbb50362036a221454129ba62898
<<<VERBATIM
F-2 CREDENTIAL WORK IS NEVER DELEGATED, AND A SECRET NEVER REACHES A TRANSCRIPT. Prompt rails
  are advisory: a prompt that forbids printing a credential does not stop the command that
  prints it. No subagent receives, resolves, echoes or transmits a live credential; the parent
  turn performs any authenticated call itself and hands the subagent the RESULT. A subagent that
  needs a secret is a decomposition error — re-cut the task. Nothing that would print a secret
  (an env file, a crontab, a full environment dump) goes to stdout from a session: move the
  value between processes by file, and verify by COUNT (`grep -c`), never by content.
VERBATIM

## GATE ISOLATION-IS-A-CWD-DEFAULT
ruling: F-3
authority: Michael
dated: starter
status: active
deliver: prompt
anchor: # F-3 "WORKTREE ISOLATION" IS A CWD DEFAULT, NOT A FILESYSTEM BOUNDARY. An agent started in a
digest: sha256:c9fe1af830c2c7dd49352acacae83fcd
<<<VERBATIM
F-3 "WORKTREE ISOLATION" IS A CWD DEFAULT, NOT A FILESYSTEM BOUNDARY. An agent started in a
  worktree can still read and write any path its user can reach, including the live tree.
  Never describe isolation as containment in a brief, a spawn prompt or a report. Say "cwd
  default"; when a real boundary is required, name the deny rail that provides it (a forbid:
  rail, a sandbox, a permission deny rule) and prove it with a canary the rail refuses.
VERBATIM

## GATE DO-NOT-RESTART-THE-LIVE-SERVICE
ruling: R-1
authority: Owner
dated: starter
status: active
deliver: prompt
forbid: cmd=~\bsystemctl\s+(--?[\w-]+\s+)*(restart|start|stop|reload|daemon-reload|kill)\b && ctx=~ahi[-_]?gateway
forbid: cmd=~\bnpm\s+run\s+build\b && ctx=~/ahi/gateway(/|\s|$)
forbid: cmd=~\bnpx?\s+tsc\b && cmd!~--noEmit && ctx=~/ahi/gateway(/|\s|$)
forbid_why: Worked example — edit the unit name and path to match your install. The systemctl rail allows flag tokens before the verb because `systemctl --user restart <unit>` slips past a pattern that needs the verb right after `systemctl`; read-only verbs (status, show, cat) stay allowed. The build rails are scoped by ctx to the LIVE tree, so the same command one directory over (a worktree under builds/) is allowed — a rail that bans a verb everywhere gets routed around. No rail reaches intent, and a unit with Restart=on-failure can be restarted by the machine with no command typed; the ruling is wider than its rails.
anchor: # R-1 DO NOT RESTART THE LIVE GATEWAY from a build session. The running service is production:
digest: sha256:896f46e3436d40672b56ebb83778efd1
<<<VERBATIM
R-1 DO NOT RESTART THE LIVE GATEWAY from a build session. The running service is production:
  a build never restarts, stops or reloads it, and never rebuilds the live tree's compiled
  output in place (that creates pressure for a restart). Build and test in a worktree or an
  isolated instance. Work that genuinely requires a restart STOPS and comes back to the owner.
VERBATIM

## GATE A-WAKE-IS-A-CLAIM
ruling: F-4
authority: Michael
dated: starter
status: active
deliver: prompt
anchor: # F-4 A WAKE IS A CLAIM, NOT A FACT. A wake, a chain message or a status line that says a build
digest: sha256:021b00fa7b5aea6ec7f99757338b28e2
<<<VERBATIM
F-4 A WAKE IS A CLAIM, NOT A FACT. A wake, a chain message or a status line that says a build
  is done, idle, dead or blocked was true when it was written — at best. Before acting on one,
  re-read the live source it summarises (the session pane, the ledger, `fm_gates.py check`, the
  queue line) and act on what that says now. A wake that turns out false is recorded, not obeyed.
VERBATIM
