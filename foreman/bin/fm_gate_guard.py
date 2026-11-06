#!/usr/bin/env python3
"""THE GATE GUARD — PreToolUse hook. Where a carried gate stops being a
sentence and becomes a refusal.

Why this file exists rather than another paragraph of prompt text: prompt
rails are advisory. A spawn prompt once forbade printing credential VALUES, and
the subagent's very first command printed one. A rail that matters must be a
refusal, not a sentence.

Two jobs, one hook:

  Bash  — a command matching an active gate's `forbid:` rail is BLOCKED, and the
          refusal quotes the governing ruling VERBATIM. The agent is told which
          gate, who ruled it, and when.
  Agent — a subagent spawn whose prompt does not CARRY the active gates is
          BLOCKED (GATES-TRAVEL). The parent is handed the exact block to paste.
          "A subagent that was never told is not disobedient; it is uninformed,
           and that is the parent's defect."

Exit 0 = allow. Exit 2 = block, stderr goes to the model. Any other exit, or a
crash, is treated by the harness as non-blocking — so this file is written to
never raise on bad input: it reports instead.

Python, not bash-with-a-heredoc: a heredoc IS stdin, so a bash wrapper eats the
hook payload and then silently allows everything. That has happened before
(see fm_model_gate.py's header). Do not repeat it.

────────────────────────────────────────────────────────────────────────────
WHERE THE CONFIG COMES FROM, AND WHY IT IS NOT $FOREMAN_ROOT/ACTIVE-GATES.md
────────────────────────────────────────────────────────────────────────────
The guard reads the WORKSPACE COPY at <workdir>/.foreman/ACTIVE-GATES.md, which
build_start.sh writes at launch, not the foreman-wide file.

That is the travel lesson applied to itself: a control that lives somewhere
else and is fetched at the moment of acting can be absent at exactly the wrong
moment. The workspace copy is written once, atomically, by the launch
that also refused to start without it — so by construction, a gated build HAS
its gates on disk beside it, and an ungated build provably never had any.

That construction is what makes the failure mode below safe.

────────────────────────────────────────────────────────────────────────────
THE FAILURE-MODE DECISION — refuse or proceed when the gate source is missing?
BOTH. Placed by BLAST RADIUS OF BEING WRONG, and each half deserves a test.
────────────────────────────────────────────────────────────────────────────
A single global answer is wrong in both directions, so the answer is placed:

  LAUNCH (build_start.sh) — REFUSE. Blast radius of refusing: one build that
    never started, with the operator watching, the reconcile report printed and
    the fix named. Nothing is mid-flight to strand. Blast radius of proceeding:
    a fan-out of subagents, most of them unisolated, one executing work that
    two gates had stopped. Refuse, with a logged opt-out that must carry a
    reason.

  BASH ACTIONS (this hook, workspace copy absent) — ALLOW. A PreToolUse hook
    that fails closed on a missing config blocks EVERY command in EVERY session
    at once, including the session that would repair it, and the recovery path
    runs through Bash. That is a refusal that bricks the chain — a real cost —
    and here it buys almost nothing: the copy is absent only when launch never
    gated this build, in which case there is nothing to enforce. Not silent,
    though — it prints a one-line notice to stderr, which the model sees.

  BASH ACTIONS (workspace copy PRESENT but corrupt) — REFUSE. This is the
    genuinely dangerous state and it is NOT the same as absent: something wrote
    gates here, and now they cannot be read. Failing open would mean a build
    that WAS gated silently stops being gated — the hole, in another costume.
    Blast radius is one build, and it is a build that is already known to be
    governed. Paired case: the absent-source case immediately above.

  AGENT SPAWNS (workspace copy present, prompt does not carry) — REFUSE. Blast
    radius is one tool call; the parent is handed the text and can retry in the
    same turn. Strictness is cheap exactly here, which is why GATES-TRAVEL's
    enforcement belongs here and not in the Bash path.

The through-line: refuse where retry is cheap and local, fail open ONLY where
the config's own absence proves the build was never gated in the first place.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fm_gates  # noqa: E402

WORKSPACE_REL = os.path.join(".foreman", "ACTIVE-GATES.md")

# Reading a script is not running it for execution hazards. Disclosure hazards
# invert that rule: reading and rendering are the dangerous operation. The
# exemption is therefore applied per gate in check_bash(), not globally here.
READ_ONLY = ("cat ", "less ", "head ", "tail ", "grep ", "ls ", "wc ", "sed -n", "bat ", "rg ")
HAZARD_WARNING_MARKER = "gate-hazard: UNKNOWN-VALUE — disclosure enforcement applied"


def gate_hazard(gate):
    """Return absent | disclosure | unknown after key/value normalisation.

    Header keys and values are stripped and case-folded here even though the
    parser also emits normalised keys. Keeping the decision at the guard's
    enforcement boundary protects direct/import callers that construct a gate
    dictionary themselves. No fuzzy matching: a misspelled key is absent here
    and belongs to the reconciler's unknown-key report.
    """
    for raw_key, raw_value in gate.items():
        if isinstance(raw_key, str) and raw_key.strip().casefold() == "hazard":
            value = str(raw_value).strip().casefold()
            return "disclosure" if value == "disclosure" else "unknown"
    return "absent"

# ── THE SPAWN SURFACE, ENUMERATED FROM EVIDENCE ────────────────────────────
# Enumerate spawn tools from what the runtime actually emits, not from memory: a
# count of tool_use names across real transcripts showed `Agent` in use, `Task`
# never, and `Workflow` (which hands a script to agents it spawns) missing from
# a matcher written by recall. Guessing names instead of enumerating the
# capability is how a rail misses its target.
#
# `Task` stays because other builds of this CLI family use it and a matcher that
# fires on a tool that does not exist costs nothing.
#
# The value is the ORDERED list of tool_input fields to read as "the prompt".
# First non-empty wins.
#   Agent/Task — `prompt` is the spawn text; `description` is a fallback.
#   Workflow — `script` IS the prompt-composing surface: every agent() call in
#     it gets its text from that script, so the script is where the gates must
#     travel. Verifying the script (not a per-agent prompt the guard never sees)
#     is the only check available at this boundary, and it is the right one:
#     a script that does not carry the gates cannot hand them to its fan-out.
#
# `TaskCreate` is deliberately NOT here. Its schema is {subject, description,
# activeForm, metadata}: no prompt, no agent, no spawn — it writes a local todo
# item. Listing it made the matcher fall through to `description` and demand
# the whole gate block inside a todo line, so task tools became unusable in
# every gated workdir. The lesson: assert on the PROPERTY (a subagent is about
# to receive instructions without the gates) not the ARTEFACT (a tool of a given
# name). Being loud where nothing is at stake is the visible half; the dangerous
# half is a spawn arriving under a name not in this table passing in silence —
# see residual_spawn_prompt() for that side. Verify against the live tool
# schema before changing this table, not from memory.
SPAWN_TOOLS = {
    "Agent":      ("prompt", "description"),
    "Task":       ("prompt", "description"),
    "Workflow":   ("script", "args", "description"),
}

# The property, checked structurally for tools this table does not name: a field
# that carries INSTRUCTIONS destined for an agent. `description` is deliberately
# NOT here — it is a fallback for tools already known to spawn, and treating it
# as a trigger on unknown tools reintroduces the TaskCreate false positive for
# every tool that happens to describe itself.
RESIDUAL_PROMPT_FIELDS = ("prompt", "script", "instructions", "systemPrompt")
RESIDUAL_MIN_CHARS = 200


def residual_spawn_prompt(tool, tin):
    """Spawn-shaped payload arriving under a name SPAWN_TOOLS does not carry.

    A name table can only ever be as complete as the last time someone counted,
    and the failure mode of an incomplete one is silence. This reads the shape
    instead: substantial instruction text under a known instruction field.
    Returns the text, or None.
    """
    if tool in SPAWN_TOOLS or tool == "Bash":
        return None
    for field in RESIDUAL_PROMPT_FIELDS:
        v = tin.get(field)
        if isinstance(v, str) and len(v.strip()) >= RESIDUAL_MIN_CHARS:
            return v
    return None


def workspace_gates(cwd):
    """Find the gates that govern this cwd. Workspace copy first, foreman-wide
    file second, None only if neither exists.

    Walking UP from cwd rather than checking cwd alone is deliberate: an agent
    that cd's into a subdirectory is still inside the same gated build, and a
    guard that forgets its gates when you change directory is a guard with a
    `cd` bypass. That is ISOLATION-IS-A-CWD-DEFAULT — "worktree isolation is a
    cwd default, not a filesystem boundary" — read as a warning about this file
    rather than about worktrees.

    ── THE FALLBACK, AND WHY IT EXISTS ───────────────────────────────────────
    Stopping at the workspace copy alone lets `npm run build` with cwd set to
    the live gateway tree sail through: the gateway is not under any build
    workspace, so no copy is found, so the guard declares the session ungated
    and allows a forbidden action. The rail was scoped to a directory tree —
    the very mistake the isolation gate names, made by the thing built to
    prevent it.

    So the foreman-wide file is consulted second. This does NOT weaken the
    failure-mode decision: allow-on-absent still applies, it just now requires
    BOTH sources to be absent, which is a far stronger precondition for the
    claim "this session was never gated".
    """
    try:
        d = os.path.abspath(cwd or os.getcwd())
    except Exception:
        d = None
    # Walk no higher than the user's home (or its parent): a .foreman/ dir
    # above $HOME is not a build workspace.
    home = os.path.expanduser("~")
    stop_at = {home, os.path.dirname(home)}
    while d:
        p = os.path.join(d, WORKSPACE_REL)
        if os.path.exists(p):
            return p
        parent = os.path.dirname(d)
        if parent == d or d in stop_at:
            break
        d = parent
    wide = os.path.join(fm_gates.FOREMAN_ROOT, "ACTIVE-GATES.md")
    return wide if os.path.exists(wide) else None


# ── forbid rule grammar ────────────────────────────────────────────────────
# One rail per `forbid:` line. Clauses joined by `&&`, every clause must hold:
#     cmd=~<regex>   the command text matches
#     cmd!~<regex>   the command text does NOT match
#     ctx=~<regex>   "cwd + ' ' + command" matches   (this is how a rail can be
#     ctx!~<regex>   scoped to one repo without banning a verb everywhere)
# Regexes are case-insensitive. A malformed clause makes the RULE fail closed
# for that rule only — it is reported, never silently dropped, because a rail
# that silently stops applying is the whole disease this machinery treats.
# The negation operator is `!~` (`cmd!~x`), NOT `!=~`. A clause regex that
# demanded `!=~` once made every negated clause MALFORMED, so a rule that
# should have refused a gateway compile could not be evaluated. It surfaced as a
# printed "malformed clause" warning rather than a silent pass — the only
# reason it was a five-minute fix instead of a live rail that had never worked.
CLAUSE_RE = re.compile(r"^(cmd|ctx)(?:(!)~|=~)(.*)$", re.S)


def rule_matches(rule, cmd, ctx):
    for clause in rule.split("&&"):
        m = CLAUSE_RE.match(clause.strip())
        if not m:
            return False, "malformed clause %r" % clause.strip()
        field, negated, pattern = m.group(1), m.group(2) == "!", m.group(3).strip()
        hay = cmd if field == "cmd" else ctx
        try:
            hit = re.search(pattern, hay, re.I) is not None
        except re.error as e:
            return False, "bad regex %r (%s)" % (pattern, e)
        if hit == negated:
            return False, None
    return True, None


def check_bash(cmd, cwd, gates, read_only=False):
    """Return (blocked, gate, rule, errors, hazard_warnings)."""
    ctx = (cwd or "") + " " + cmd
    errors = []
    classified = [(g, gate_hazard(g)) for g in gates]
    hazard_warnings = [
        "%s: gate=%s" % (HAZARD_WARNING_MARKER, g.get("key") or "(unnamed)")
        for g, hazard in classified if hazard == "unknown"
    ]
    for g, hazard in classified:
        # ABSENT is the historical byte-identical path: read-only commands skip
        # this gate. Exact disclosure and every unrecognised declared value
        # evaluate the rail; the latter is fail-closed-and-loud above.
        if read_only and hazard == "absent":
            continue
        for rule in g.get("forbid", []):
            hit, err = rule_matches(rule, cmd, ctx)
            if err:
                errors.append("%s: %s" % (g.get("key"), err))
            elif hit:
                return True, g, rule, errors, hazard_warnings
    return False, None, None, errors, hazard_warnings


def refuse_bash(g, rule, cmd):
    print("GATE REFUSED — the command was NOT run.\n", file=sys.stderr)
    print("  gate    : %s (ruling %s, %s, %s)" % (g.get("key"), g.get("ruling"),
                                                  g.get("authority"), g.get("dated")),
          file=sys.stderr)
    print("  rail    : %s" % rule, file=sys.stderr)
    print("  command : %s\n" % cmd.strip()[:300], file=sys.stderr)
    print("THE RULING, VERBATIM (GATES-TRAVEL: not a paraphrase):\n", file=sys.stderr)
    for line in (g.get("verbatim") or "").strip().split("\n"):
        print("  │ " + line, file=sys.stderr)
    print("\n  Source: ACTIVE-GATES.md, carried from QUEUE.md. This gate is ACTIVE.", file=sys.stderr)
    print("  If you believe it does not apply, that is a decision for the ruling's", file=sys.stderr)
    print("  author — say so and stop. Do not route around it.", file=sys.stderr)
    if (g.get("forbid_why") or ""):
        print("\n  %s" % g["forbid_why"], file=sys.stderr)


def refuse_spawn(missing, gates_path, cwd):
    print("GATE REFUSED — the subagent was NOT spawned.\n", file=sys.stderr)
    print("GATES-TRAVEL:\n", file=sys.stderr)
    print("  │ A gate written in QUEUE.md reaches the turn that reads the queue and", file=sys.stderr)
    print("  │ stops there. Every spawn prompt therefore carries the active gate", file=sys.stderr)
    print("  │ list VERBATIM — not a paraphrase, not \"respect the gates\".", file=sys.stderr)
    print("  │ A subagent that was never told is not disobedient; it is uninformed,", file=sys.stderr)
    print("  │ and that is the parent's defect.\n", file=sys.stderr)
    print("  This spawn prompt does not carry: %s" % ", ".join(str(m) for m in missing),
          file=sys.stderr)
    print("\n  Paste this block into the prompt verbatim, then retry:\n", file=sys.stderr)
    print("      FM_GATES_FILE=%s \\" % gates_path, file=sys.stderr)
    print("      %s render --for subagent"
          % os.path.join(os.path.dirname(os.path.abspath(__file__)), "fm_gates.py"),
          file=sys.stderr)
    print("\n  Containment is checked on whitespace-normalised text, so you may", file=sys.stderr)
    print("  re-wrap or re-indent the block freely. You may not summarise it.", file=sys.stderr)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0  # never break a tool call on a parse error

    tool = payload.get("tool_name") or ""
    tin = payload.get("tool_input") or {}
    cwd = payload.get("cwd") or os.getcwd()

    residual = residual_spawn_prompt(tool, tin)
    if tool not in SPAWN_TOOLS and tool != "Bash" and residual is None:
        return 0

    gates_path = workspace_gates(cwd)
    if gates_path is None:
        # ABSENT → allow, but say so. See the failure-mode note in the docstring:
        # absent proves this build was never gated, and failing closed here
        # blocks the recovery path itself.
        if tool == "Bash" and os.environ.get("FM_GATE_QUIET") != "1":
            print("note: no .foreman/ACTIVE-GATES.md above %s — gate rails are NOT active "
                  "for this session." % cwd, file=sys.stderr)
        return 0

    gs, errors = fm_gates.active_gates(gates_path)
    if gs is None or errors:
        # PRESENT BUT CORRUPT → refuse. Something gated this build and the gates
        # can no longer be read; proceeding would silently ungate a build that
        # was governed.
        print("GATE REFUSED — the gate source beside this build is unreadable.\n", file=sys.stderr)
        print("  file: %s" % gates_path, file=sys.stderr)
        for e in (errors or ["unparseable"]):
            print("  ✗ %s" % e, file=sys.stderr)
        print("\n  This build WAS launched with gates, so they cannot be skipped now.", file=sys.stderr)
        print("  Repair the file (or close the build); nothing was run.", file=sys.stderr)
        return 2

    if tool == "Bash":
        cmd = tin.get("command", "") or ""
        read_only = any(cmd.lstrip().startswith(p) for p in READ_ONLY)
        blocked, g, rule, rule_errors, hazard_warnings = check_bash(
            cmd, cwd, gs, read_only
        )
        for warning in hazard_warnings:
            print(warning, file=sys.stderr)
        for e in rule_errors:
            print("gate-rail warning: %s" % e, file=sys.stderr)
        if blocked:
            refuse_bash(g, rule, cmd)
            return 2
        return 0

    # Every spawn surface — GATES-TRAVEL enforcement. See SPAWN_TOOLS.
    prompt = ""
    if tool in SPAWN_TOOLS:
        for field in SPAWN_TOOLS[tool]:
            v = tin.get(field)
            if isinstance(v, str) and v.strip():
                prompt = v
                break
    else:
        # Structural catch: an unnamed tool carrying instruction text. Say which
        # side of the check fired, because a refusal a reader cannot attribute to
        # a rule is a refusal they will work around rather than fix.
        prompt = residual
        print("gate-rail: %s is not in SPAWN_TOOLS but carries instruction text; "
              "checking it as a spawn. If this tool cannot reach a subagent, the "
              "fix is to say so here — not to strip the gates from the call."
              % tool, file=sys.stderr)
    ok, missing = fm_gates.verify_prompt(prompt, gates_path)
    if not ok:
        refuse_spawn(missing, gates_path, cwd)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # never take out the chain on an unexpected error
        print("fm_gate_guard: internal error (%s) — allowing." % e, file=sys.stderr)
        sys.exit(0)
