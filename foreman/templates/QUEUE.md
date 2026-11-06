# QUEUE.md — the authored home of rulings, and the foreman's work queue

Copy this file to `$FOREMAN_ROOT/QUEUE.md` (default `~/ahi/foreman/QUEUE.md`). It has two jobs:

1. **Rulings.** Every gate is written here first, in prose, as a `#` comment block. The supervisor
   (Michael) or the owner rules here. `ACTIVE-GATES.md` is the machine-readable carry-copy that
   travels into every build prompt and subagent prompt; `bin/fm_gates.py check` proves the two agree
   (anchor, digest, verbatim text, shape, coverage) and every build launch refuses while they do not.
2. **The work queue.** The chain (`build_done.sh`, the heartbeat) reads the first unchecked task line
   as the next order.

## How to write a ruling

A ruling is a comment block: one HEAD line (`#`, exactly one space, then text) followed by
continuation lines (`#` and two or more spaces, or a bare `#`). Coverage recognises a head by its
id shape (`# F-12 …`, `# R-3 …`, `# G2 …`, `# D-1 …`) or by an imperative keyword on the head line
(RULED, GATED, DO NOT, PAUSE FOR OWNER, NON-NEGOTIABLE, BLOCKS ALL, HARD RULE). Every such head below
the RULINGS marker must be carried in `ACTIVE-GATES.md`, or `check` reports it UNCARRIED.

Id letters, by convention: R = an owner ruling, F = a supervisor ruling or finding, G = a standing
gate or status, D = a decision record. To carry a new ruling:

    bin/fm_recarry.py --add '<first words of the head line>' --key MY-GATE-KEY          # dry run
    bin/fm_recarry.py --add '<first words of the head line>' --key MY-GATE-KEY --write
    bin/fm_gates.py check

To change a ruling, edit it here, then `bin/fm_recarry.py <KEY>` (shows the diff) and `--write`.

## How to write a work order

One order per unchecked task line: a dash, a space, an empty checkbox, a space, then the order —
ideally led by an item key such as `W-1` so two launches cannot claim the same item. Mark it done by
checking the box. A line without the checkbox is NOT an order and will not fire the chain; that is
deliberate (a stray `---` or line of prose must never start a build). A gate stops the chain from
naming an item only if the gate declares `blocks: <ITEM>` in ACTIVE-GATES.md and the item labels
itself with that id (`Phase 3A …` or a leading `W-1 —`).

# ── RULINGS — every gate-shaped block below this line must be carried in ACTIVE-GATES.md ──

# PAUSE FOR OWNER — non-negotiable, regardless of what the chain says next:
#   live credential rotation · production deploy relink or cutover · deletion of possibly-unique
#   data · permanent worktree retirement · destructive history change · live-tree migration.
#   Work that reaches one of these STOPS, states exactly what it would do and why, and waits for
#   the owner's explicit yes. A yes for one instance is not a standing yes for the class.

# F-1 GATES DO NOT INHERIT, SO THEY MUST BE CARRIED. A gate written in QUEUE.md reaches the turn
#   that reads the queue and stops there. Every build prompt and every subagent spawn prompt
#   carries the active gate block VERBATIM — not a paraphrase, not "respect the gates". The
#   foreman renders it (`fm_gates.py render --for subagent`) and the PreToolUse guard refuses a
#   spawn whose prompt does not carry it. A subagent that was never told is not disobedient; it is
#   uninformed, and that is the parent's defect.

# F-2 CREDENTIAL WORK IS NEVER DELEGATED, AND A SECRET NEVER REACHES A TRANSCRIPT. Prompt rails
#   are advisory: a prompt that forbids printing a credential does not stop the command that
#   prints it. No subagent receives, resolves, echoes or transmits a live credential; the parent
#   turn performs any authenticated call itself and hands the subagent the RESULT. A subagent that
#   needs a secret is a decomposition error — re-cut the task. Nothing that would print a secret
#   (an env file, a crontab, a full environment dump) goes to stdout from a session: move the
#   value between processes by file, and verify by COUNT (`grep -c`), never by content.

# F-3 "WORKTREE ISOLATION" IS A CWD DEFAULT, NOT A FILESYSTEM BOUNDARY. An agent started in a
#   worktree can still read and write any path its user can reach, including the live tree.
#   Never describe isolation as containment in a brief, a spawn prompt or a report. Say "cwd
#   default"; when a real boundary is required, name the deny rail that provides it (a forbid:
#   rail, a sandbox, a permission deny rule) and prove it with a canary the rail refuses.

# R-1 DO NOT RESTART THE LIVE GATEWAY from a build session. The running service is production:
#   a build never restarts, stops or reloads it, and never rebuilds the live tree's compiled
#   output in place (that creates pressure for a restart). Build and test in a worktree or an
#   isolated instance. Work that genuinely requires a restart STOPS and comes back to the owner.

# F-4 A WAKE IS A CLAIM, NOT A FACT. A wake, a chain message or a status line that says a build
#   is done, idle, dead or blocked was true when it was written — at best. Before acting on one,
#   re-read the live source it summarises (the session pane, the ledger, `fm_gates.py check`, the
#   queue line) and act on what that says now. A wake that turns out false is recorded, not obeyed.

## Work queue

(empty — add unchecked task lines here)
