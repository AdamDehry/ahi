#!/usr/bin/env python3
"""ACTIVE GATES — one machine-readable source, and the machinery that makes a
gate TRAVEL to the place it is acted on.

WHY THIS EXISTS (the GATES-TRAVEL starter gate):

    A gate written in QUEUE.md reaches the turn that reads the queue and stops
    there. Every spawn prompt therefore carries the active gate list VERBATIM —
    not a paraphrase, not "respect the gates".

This is that source. The underlying hole has many costumes but one shape: a
control written in one place does not travel to the place it is acted on, and
every time the result READS AS SAFE.

────────────────────────────────────────────────────────────────────────────
THE ANTI-GREP RULE — read this before changing anything below.
────────────────────────────────────────────────────────────────────────────
A line-based `grep -lE` once reported a gate as MISSING from a document that
carried it: the phrase wrapped across a newline, and a line-based matcher cannot
match across one. The count it produced was wrong and looked authoritative.

This file decides whether a gate is PRESENT. It is the same job, so it must not
inherit the same defect. EVERY comparison in this module runs through
`normalize()`, which collapses every whitespace run — newlines included — to a
single space. After normalisation a line wrap is INVISIBLE, so a wrapped gate
and a reflowed gate and a hard-wrapped-at-72 gate all compare equal, and a
CHANGED WORD still compares different. There is no `grep -l` anywhere in the
gate path. Any test of this module should carry paired cases that must come out
the opposite way (reflow → still equal; one changed word → different).

────────────────────────────────────────────────────────────────────────────
HOW THE TWO SOURCES ARE KEPT FROM SILENTLY DISAGREEING
────────────────────────────────────────────────────────────────────────────
QUEUE.md stays the authored home of a gate — the supervisor writes prose there
and that must not change. ACTIVE-GATES.md is the machine-readable carry-copy.
Two copies can drift, so drift is POLICED rather than hoped away. `check` proves
four things per gate and one thing globally:

  1 ANCHOR      the gate's head line appears in QUEUE.md exactly once
                (0 → MISSING-IN-QUEUE, >1 → AMBIGUOUS-ANCHOR; both are loud)
  2 DIGEST      sha256 of the normalised QUEUE.md block == the digest recorded
                in ACTIVE-GATES.md            (else QUEUE-DRIFTED)
  3 VERBATIM    the normalised text carried in ACTIVE-GATES.md == the
                normalised QUEUE.md block     (else TRANSCRIPTION-DIVERGED)
  4 SHAPE       the entry declares key/ruling/authority/dated/status/anchor
  * COVERAGE    every gate-shaped block head inside the declared scan region of
                QUEUE.md is accounted for by some entry (else UNCARRIED — this
                is the one that stops the hole reopening one level up, when a
                NEW ruling is written to QUEUE.md and nobody carries it)

DECLARED LIMIT OF THE COVERAGE SCAN, stated because an undeclared limit is how
controls quietly fail: coverage recognises a block head by SHAPE (`# F-9 …`,
`# R-4 …`, `# G2 …`, `# D-1 …`) or by an imperative KEYWORD on the head line
(RULED / GATED / DO NOT / PAUSE FOR OWNER / NON-NEGOTIABLE / BLOCKS ALL / HARD
RULE). A future gate written in a form matching neither would not be flagged.
That is a real gap, and it is why `check` prints the scan region and the head
count it considered rather than a bare "OK".

Id letters, by convention: R = an owner ruling, F = a supervisor ruling or
finding, G = a standing gate/status, D = a decision record.
"""

import hashlib
import os
import re
import sys

AHI_HOME = os.environ.get("FM_AHI_HOME") or os.environ.get("AHI_HOME") or os.path.expanduser("~/ahi")
FOREMAN_ROOT = os.environ.get("FOREMAN_ROOT") or os.path.join(AHI_HOME, "foreman")
GATES_PATH = os.environ.get("FM_GATES_FILE", os.path.join(FOREMAN_ROOT, "ACTIVE-GATES.md"))
QUEUE_PATH = os.environ.get("FM_QUEUE_FILE", os.path.join(FOREMAN_ROOT, "QUEUE.md"))

# A head line is `#` + exactly one space + non-space. A continuation is `#`
# followed by two or more spaces (or a bare `#`). This distinction is load
# bearing: without it, an indented body line that happens to start with an id
# (`#   F-3 — and that a grep …`) reads as a new gate head. On a real queue the
# naive form found roughly a third more heads than existed, all of them false.
HEAD_RE = re.compile(r"^#\x20(?=\S)")
CONT_RE = re.compile(r"^#(?:$|\x20{2,})")

RULING_SHAPE_RE = re.compile(r"^#\x20((?:F|R|G|D)-?\d+[A-Za-z]?(?:\([a-z]\))?)\x20+\S")
KEYWORD_RE = re.compile(
    r"\b(RULED|GATED|DO NOT|PAUSE FOR OWNER|NON-NEGOTIABLE|BLOCKS ALL|HARD RULE)\b"
)


# ── the one comparison primitive ───────────────────────────────────────────
def normalize(text):
    """Collapse every whitespace run — newlines included — to one space.

    This is the whole anti-grep defence. After this, line wrapping cannot
    change the answer and a changed word still can.
    """
    return re.sub(r"\s+", " ", text).strip()


def strip_comment(block_lines):
    """Drop the leading `#` and one following space from each line of a block."""
    out = []
    for ln in block_lines:
        if ln.startswith("# "):
            out.append(ln[2:])
        elif ln == "#":
            out.append("")
        else:
            out.append(ln.lstrip("#"))
    return "\n".join(out)


def digest(text):
    return "sha256:" + hashlib.sha256(normalize(text).encode("utf-8")).hexdigest()[:32]


# ── QUEUE.md side ──────────────────────────────────────────────────────────
def queue_lines(path=None):
    with open(path or QUEUE_PATH, errors="replace") as f:
        return f.read().split("\n")


def blocks(lines):
    """Split QUEUE.md into comment blocks: one head line plus its continuations.

    Returns [(line_no, text)] with comment markers stripped.
    """
    out = []
    i = 0
    while i < len(lines):
        if HEAD_RE.match(lines[i]):
            block = [lines[i]]
            j = i + 1
            while j < len(lines) and CONT_RE.match(lines[j]):
                block.append(lines[j])
                j += 1
            out.append((i + 1, strip_comment(block)))
            i = j
        else:
            i += 1
    return out


def find_block(lines, anchor):
    """Return (status, text, line_no). status: ok | missing | ambiguous.

    WHY BY BLOCK PREFIX, NOT BY LINE: matching the anchor against a single
    line (`normalize(head_line) == normalize(anchor)`) breaks the moment a
    ruling is reflowed to a different column with the same words — the gate
    reads MISSING-IN-QUEUE while sitting right there. Normalising WITHIN a line
    does nothing when the words move ACROSS lines.

    So the anchor is resolved against the normalised text of the whole BLOCK,
    by prefix: a gate's head line is the opening words of its block no matter
    where the lines break. Reflow-invariant, and still exact — a changed word is
    still a different prefix. Regression case: reflow one ruling; this must
    still find it while a line-based grep on the same file does not.
    """
    # The anchor is recorded as the QUEUE.md line, comment marker and all;
    # block text has the markers stripped. Strip the anchor the same way or
    # nothing ever matches (the whole set reads MISSING-IN-QUEUE at once —
    # at least the honest direction to fail in: a matcher that silently
    # matched too much would have read as safe).
    want = normalize(strip_comment([anchor]))
    if not want:
        return "missing", "", 0
    hits = [(n, t) for n, t in blocks(lines) if normalize(t).startswith(want)]
    if not hits:
        return "missing", "", 0
    if len(hits) > 1:
        return "ambiguous", "", hits[0][0]
    return "ok", hits[0][1], hits[0][0]


def scan_heads(lines, scan_from):
    """Every gate-shaped or gate-worded block head at or after the scan anchor.

    Returns (heads, start_line) or (None, 0) if the scan anchor is not found —
    which is a LOUD failure, never a silent empty scan.
    """
    want = normalize(scan_from)
    start = next((i for i, ln in enumerate(lines) if normalize(ln) == want), None)
    if start is None:
        return None, 0
    heads = []
    for i in range(start, len(lines)):
        ln = lines[i]
        if not HEAD_RE.match(ln):
            continue
        if RULING_SHAPE_RE.match(ln) or KEYWORD_RE.search(ln):
            heads.append((i + 1, ln))
    return heads, start + 1


# ── ACTIVE-GATES.md side ───────────────────────────────────────────────────
FIELD_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$")

# The complete set of header keys the grammar knows. `hazard` is optional and
# interpreted only by fm_gate_guard.py. Unknown keys are retained as
# non-blocking reconcile findings; they are never parse errors, because a header
# typo must not refuse launches or silence wakes.
GATE_HEADER_KEYS = frozenset({
    "anchor", "authority", "blocks", "dated", "deliver", "digest", "forbid",
    "forbid_why", "hazard", "note", "ruling", "status",
})


def parse_gates(path=None):
    """Parse ACTIVE-GATES.md.

    Grammar, deliberately tiny (no yaml in the stdlib, and a dependency in the
    supervision path is a liability):

        scan_from: <anchor line for the coverage scan>

        ## GATE <key>
        ruling: F-1
        authority: Michael | Owner
        dated: YYYY-MM-DD   (required; starter gates use the value `starter`)
        status: active | superseded | historic
        deliver: prompt | file
        blocks: <phase/item id>  (repeatable; one target per line)
        note: <free text, only for status != active>
        anchor: <the exact QUEUE.md head line>
        digest: sha256:...
        hazard: disclosure        (optional; interpreted by fm_gate_guard.py)
        forbid: <regex>        (repeatable, optional)
        forbid_why: <text>     (optional, one per gate)
        <<<VERBATIM
        ...
        VERBATIM

    Returns (meta, gates, errors).
    """
    errors = []
    meta = {}
    gates = []
    cur = None
    verbatim = None
    try:
        raw = open(path or GATES_PATH, errors="replace").read()
    except FileNotFoundError:
        return {}, [], ["GATE-SOURCE-MISSING: %s" % (path or GATES_PATH)]
    if not raw.strip():
        return {}, [], ["GATE-SOURCE-EMPTY: %s" % (path or GATES_PATH)]

    for n, ln in enumerate(raw.split("\n"), 1):
        if verbatim is not None:
            if ln.strip() == "VERBATIM":
                cur["verbatim"] = "\n".join(verbatim)
                verbatim = None
            else:
                verbatim.append(ln)
            continue
        if ln.startswith("## GATE "):
            cur = {"key": ln[8:].strip(), "forbid": [], "blocks": [], "_line": n}
            gates.append(cur)
            continue
        if ln.strip() == "<<<VERBATIM":
            if cur is None:
                errors.append("MALFORMED: verbatim block outside a gate at line %d" % n)
                return meta, gates, errors
            verbatim = []
            continue
        m = FIELD_RE.match(ln)
        if not m:
            continue
        raw_key, v = m.group(1), m.group(2).strip()
        k = raw_key.strip().casefold()
        if cur is None:
            meta[k] = v
        elif k not in GATE_HEADER_KEYS:
            cur.setdefault("_unknown_header_keys", []).append({
                "raw": raw_key,
                "normalized": k,
                "line": n,
            })
        elif k == "forbid":
            cur["forbid"].append(v)
        elif k == "blocks":
            # One target per line remains the documented form. Commas and
            # whitespace are tolerated so a formatting slip cannot silently
            # create one impossible combined target; empty pieces are dropped.
            cur["blocks"].extend(t for t in re.split(r"[\s,]+", v) if t)
        else:
            cur[k] = v

    if verbatim is not None:
        errors.append("MALFORMED: unterminated <<<VERBATIM block (missing closing VERBATIM)")
    if "scan_from" not in meta:
        errors.append("MALFORMED: no scan_from: anchor — the coverage scan has no region")
    if not gates:
        errors.append("MALFORMED: no '## GATE <key>' entries found")
    return meta, gates, errors


REQUIRED = ("ruling", "authority", "dated", "status", "anchor")


# ── reconcile (exit criterion 1) ───────────────────────────────────────────
def check(gates_path=None, queue_path=None):
    """Return (ok, report_lines). Never raises on bad input — it reports."""
    rep = []
    meta, gates, errors = parse_gates(gates_path)
    if errors:
        return False, ["GATE RECONCILE — FAILED"] + ["  ✗ " + e for e in errors]

    try:
        lines = queue_lines(queue_path)
    except FileNotFoundError:
        # Still a refusal — a carry-copy with no authored source proves nothing.
        # But name the repair: on a fresh install this is the first thing hit.
        starter = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "templates", "QUEUE.md")
        rep = ["GATE RECONCILE — FAILED",
               "  ✗ QUEUE-MISSING: %s" % (queue_path or QUEUE_PATH)]
        if os.path.exists(starter):
            rep += ["", "  REPAIR:",
                    "    cp %s %s   # the starter queue that anchors the starter gates"
                    % (starter, queue_path or QUEUE_PATH)]
        return False, rep

    problems = []
    warnings = []
    accounted = set()
    active = 0
    known_targets = known_block_targets(lines)

    for g in gates:
        key = g.get("key") or "(unnamed)"
        for unknown in g.get("_unknown_header_keys", []):
            warnings.append(
                "%s: UNKNOWN-HEADER-KEY %r at ACTIVE-GATES.md:%d — ignored by "
                "enforcement; caller continues"
                % (key, unknown["raw"] + ":", unknown["line"])
            )
        for f in REQUIRED:
            if not g.get(f):
                problems.append("%s: SHAPE — missing required field '%s:'" % (key, f))
        for target in g.get("blocks", []):
            if target not in known_targets:
                problems.append(
                    "%s: UNKNOWN-BLOCK-TARGET — parsed blocks token %r names no known "
                    "phase/item in QUEUE.md." % (key, target)
                )
        if not g.get("anchor"):
            continue
        status, qtext, lineno = find_block(lines, g["anchor"])
        if status == "missing":
            problems.append("%s: MISSING-IN-QUEUE — anchor resolves to no head line in QUEUE.md.\n"
                            "        anchor: %s" % (key, g["anchor"][:100]))
            continue
        if status == "ambiguous":
            problems.append("%s: AMBIGUOUS-ANCHOR — anchor matches more than one head line "
                            "(first at QUEUE.md:%d)" % (key, lineno))
            continue
        accounted.add(lineno)
        if g.get("status") == "active":
            active += 1
        got = digest(qtext)
        if g.get("digest") and got != g["digest"]:
            problems.append("%s: QUEUE-DRIFTED at QUEUE.md:%d — the ruling changed under the "
                            "carry-copy.\n        recorded %s\n        actual   %s"
                            % (key, lineno, g["digest"], got))
        if "verbatim" in g and normalize(g["verbatim"]) != normalize(qtext):
            problems.append("%s: TRANSCRIPTION-DIVERGED at QUEUE.md:%d — the carried text is not "
                            "the ruling's text." % (key, lineno))

    heads, start = scan_heads(lines, meta.get("scan_from", ""))
    if heads is None:
        problems.append("SCAN-REGION-LOST — scan_from anchor is not in QUEUE.md. Coverage was "
                        "NOT checked; treat every gate as unverified for coverage.\n"
                        "        scan_from: %s" % meta.get("scan_from", "")[:100])
        heads = []
    else:
        for lineno, ln in heads:
            if lineno not in accounted:
                problems.append("UNCARRIED at QUEUE.md:%d — a gate-shaped ruling in the scan "
                                "region that ACTIVE-GATES.md does not carry.\n        %s"
                                % (lineno, ln[:110]))

    if problems:
        outcome = "FAILED"
    elif warnings:
        outcome = "RED-NONBLOCKING"
    else:
        outcome = "PASS"
    rep.append("GATE RECONCILE — %s" % outcome)
    rep.append("  gate source : %s" % (gates_path or GATES_PATH))
    rep.append("  queue       : %s" % (queue_path or QUEUE_PATH))
    rep.append("  entries     : %d carried (%d active)" % (len(gates), active))
    rep.append("  scan region : QUEUE.md:%d → EOF, %d gate-shaped heads considered"
               % (start, len(heads)))
    rep.append("  method      : whitespace-normalised full-text + sha256 digest per block "
               "(BEHAVIOURAL on the file; NOT a line-based grep)")
    for p in problems:
        rep.append("  ✗ " + p)
    for warning in warnings:
        rep.append("  ! " + warning)

    # ── NAME THE REPAIR, NOT JUST THE FAULT ────────────────────────────────
    # A red reconcile refuses every build launch (build_start.sh's gate gate).
    # Appending ONE new gate-shaped ruling to QUEUE.md — the most ordinary
    # event there is — stalls every launch with rc=3. The refusal is correct; a
    # refusal that names no way out is not. `FM_GATES_OPTOUT` is an escape, not
    # a repair: it launches UNGATED.
    #
    # So the report ends by naming the exact command for the fault it found.
    # Per-class, because the two faults have genuinely different repairs: a
    # drifted gate is re-carried mechanically, an uncarried one needs a human to
    # decide what it BLOCKS before it can be carried at all.
    if problems:
        recarry = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fm_recarry.py")
        drifted = sorted({p.split(":")[0] for p in problems
                          if "QUEUE-DRIFTED" in p or "TRANSCRIPTION-DIVERGED" in p})
        rep.append("")
        rep.append("  REPAIR:")
        for k in drifted:
            rep.append("    %s %s          # shows the diff; add --write to accept" % (recarry, k))
        if any(p.startswith("UNCARRIED") for p in problems):
            rep.append("    %s --add '<anchor prefix>' --key <KEY>   # carry a new ruling" % recarry)
            rep.append("      then set blocks: by hand — the chain's gate check reads")
            rep.append("      nothing else, so an uncarried blocks: is an ungated phase.")
        if not drifted and not any(p.startswith("UNCARRIED") for p in problems):
            rep.append("    (no mechanical repair for this fault class — read the ✗ lines above)")
    return (not problems), rep


# ── render (what actually travels) ─────────────────────────────────────────
BANNER = "═══ ACTIVE GATES — carried under GATES-TRAVEL. VERBATIM, not a paraphrase. ═══"


def active_gates(gates_path=None):
    _meta, gates, errors = parse_gates(gates_path)
    if errors:
        return None, errors
    return [g for g in gates if g.get("status") == "active"], []


def set_digest(gates_path=None):
    """One digest over the whole active set — how a consumer says 'which gates'."""
    gs, err = active_gates(gates_path)
    if gs is None:
        return None
    joined = "\n".join(sorted(g.get("key", "") + "|" + normalize(g.get("verbatim", ""))
                              for g in gs))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:12]


# ── COMPACT DELIVERY (the default) ─────────────────────────────────────────
# A gate set grows. At a few dozen gates the full verbatim block is fine; at
# well over a hundred it is hundreds of KB prepended to every launch and
# re-pasted whole on every mid-run gate change, for builds that most of it does
# not touch. Compact mode keeps the actual guarantee — no agent is UNINFORMED —
# without the bulk:
#   · the non-negotiables (keys starting PAUSE, plus COMPACT_INLINE_KEYS) still
#     travel VERBATIM;
#   · every other active gate travels as a one-line headline (its own first
#     line, verbatim, not a paraphrase), so the agent knows each ruling EXISTS
#     and what it is about;
#   · the full verbatim text sits beside the build at .foreman/ACTIVE-GATES.md
#     (fm_gates_install writes it before the brief is composed), and the block
#     tells the agent to read the full text before acting in a headline's area.
# Enforcement is unchanged: `forbid:` rails are the PreToolUse guard's job and
# never depended on the prompt. Subagents get the same compact block (the
# guard's spawn check accepts compact OR full verbatim).
# Rollback: FM_GATES_MODE=verbatim. Inline set: FM_GATES_INLINE_KEYS (comma list).
COMPACT_INLINE_PREFIXES = ("PAUSE",)
COMPACT_INLINE_KEYS = tuple(
    k.strip() for k in (os.environ.get("FM_GATES_INLINE_KEYS")
                        or "GATES-TRAVEL,CREDENTIALS-NEVER-DELEGATED").split(",")
    if k.strip())
HEADLINE_MAX = 200


def gates_mode():
    return os.environ.get("FM_GATES_MODE", "compact").strip().lower() or "compact"


def compact_inline(g):
    k = g.get("key", "")
    return k in COMPACT_INLINE_KEYS or k.startswith(COMPACT_INLINE_PREFIXES)


def headline(g):
    lines = [l.strip() for l in (g.get("verbatim") or "").strip().splitlines() if l.strip()]
    first = lines[0] if lines else "(empty)"
    if len(first) > HEADLINE_MAX:
        first = first[:HEADLINE_MAX - 1].rstrip() + "…"
    return "· %s (%s, %s, %s) — %s" % (g.get("key"), g.get("ruling"),
                                      g.get("authority"), g.get("dated"), first)


def render_compact(gs, sd, where):
    inline = [g for g in gs if compact_inline(g)]
    rest = [g for g in gs if not compact_inline(g)]
    out = ["═══ ACTIVE GATES — carried under GATES-TRAVEL, COMPACT form · gate-set %s · %d active ═══"
           % (sd, len(gs)), "",
           "%d non-negotiable gates follow VERBATIM. The other %d are listed by headline below; "
           "their FULL verbatim text is in .foreman/ACTIVE-GATES.md in your working directory. "
           "Every one of them binds you. BEFORE you act in any area a headline touches "
           "(deploys, credentials, the gateway, live trees, deletion, migration, mission-control "
           "state, a phase it names) read that gate's full text first. If you are unsure whether "
           "a gate applies, read it — it is cheap." % (len(inline), len(rest)), ""]
    for g in inline:
        out.append("── %s (%s, %s, %s) ──" % (g.get("key"), g.get("ruling"),
                                              g.get("authority"), g.get("dated")))
        out.append((g.get("verbatim") or "").strip())
        out.append("")
    out.append("── HEADLINES (full text: .foreman/ACTIVE-GATES.md) ──")
    out.extend(headline(g) for g in rest)
    out.append("")
    spawn = ("Any subagent you spawn must receive this whole block in its spawn prompt "
             "(the guard refuses the spawn otherwise; .foreman/GATES-FOR-SUBAGENTS.txt is a "
             "ready copy). CREDENTIALS-NEVER-DELEGATED: a subagent never receives, resolves, "
             "echoes or transmits a live credential.")
    if where == "codex":
        out.append(spawn + " METHOD NOTE: this runtime has NO PreToolUse guard — every gate is "
                   "advisory here, and only your reading stands between a forbidden command "
                   "and the live system.")
    else:
        out.append(spawn + " Gates carrying `forbid:` rails are ALSO enforced by a PreToolUse "
                   "hook that refuses the tool call regardless of what you read.")
    out.append("═══ END ACTIVE GATES · gate-set %s ═══" % sd)
    return "\n".join(out)


def render(gates_path=None, where="launch"):
    gs, err = active_gates(gates_path)
    if gs is None:
        return None, err
    if gates_mode() == "compact":
        return render_compact(gs, set_digest(gates_path), where), []
    sd = set_digest(gates_path)
    out = [BANNER, "gate-set %s · %d active gates · source ACTIVE-GATES.md" % (sd, len(gs)), ""]
    for g in gs:
        out.append("── %s (%s, %s, %s) ──" % (g.get("key"), g.get("ruling"),
                                              g.get("authority"), g.get("dated")))
        out.append((g.get("verbatim") or "").strip())
        out.append("")
    # The tail says what the block IS and, for a runtime, how much of it is
    # actually enforced. Telling a codex builder "a hook will stop you" when no
    # such hook exists in its runtime would be a comforting sentence that is
    # false — a control asserting a strength it does not have, aimed at the agent.
    if where == "subagent":
        out.append("You are a SUBAGENT. These gates were carried to you mechanically because "
                   "a subagent who was never told is not disobedient, it is uninformed, and "
                   "that is the parent's defect (GATES-TRAVEL). They bind you exactly as they "
                   "bind the parent turn. CREDENTIALS-NEVER-DELEGATED: you must never receive, "
                   "resolve, echo or transmit a live credential — if this task needs one, it is "
                   "a decomposition error; refuse and say so.")
    elif where == "codex":
        out.append("These gates bind this session and every subagent it spawns (GATES-TRAVEL). "
                   "Carry them VERBATIM into any spawn prompt; "
                   "`fm_gates.py render --for subagent` emits the block to paste. "
                   "METHOD NOTE, because you are entitled to know how strong your rails are: "
                   "this runtime has NO PreToolUse guard. Nothing here is mechanically enforced "
                   "for you — every gate above is advisory, and the only thing standing between "
                   "a forbidden command and the live system is you reading this. The claude lane "
                   "gets a hook that refuses; you do not.")
    else:
        out.append("These gates bind this session and every subagent it spawns (GATES-TRAVEL). "
                   "Carry them VERBATIM into any spawn prompt; "
                   "`fm_gates.py render --for subagent` emits the block to paste. "
                   "The gates carrying `forbid:` rails are ALSO enforced by a PreToolUse hook "
                   "that will refuse the tool call — it does not depend on you having read this.")
    out.append("═══ END ACTIVE GATES · gate-set %s ═══" % sd)
    return "\n".join(out), []


# ── DOES A GATE BLOCK THIS QUEUE ITEM? ─────────────────────────────────────
# Why this exists: build_done.sh's chain parser finds the first "- [ ]" line and
# names it as the next action. It is structurally blind to the "# F-" comment
# lines that gate that item — sometimes sitting three lines away in the same
# file. Without this, the chain will happily auto-fire a phase that is blocked
# several independent ways: the ruling is in the file, and the code that reads
# the file cannot see it.
#
# DECLARATIVE, NOT A TEXT SEARCH. A gate declares `blocks: 3A`. The alternative
# — scanning ruling text for "3A DOES NOT START" — would match a gate that
# merely MENTIONS 3A, and miss one that says "the pilot does not begin". A
# declaration cannot be wrong about what it means; it can only be MISSING, and
# that is a failure mode a scan can detect, which is what undeclared_blocks()
# below is for.
PHASE_RE = re.compile(r"\b(\d[A-Z]|[A-Z]-?\d+|G\d+)\b")
BLOCK_LANG_RE = re.compile(
    r"(DOES NOT START|DOES NOT ADVANCE|DOES NOT BEGIN|GATED|DO NOT START|IS GATED)",
    re.I)

# A block target is known only when a checklist item labels itself with it:
# either `Phase 3A` or a leading `G1 —` / `3A PRECONDITION`. This deliberately
# ignores identifiers mentioned later in prose, where they are references to
# gates and dependencies rather than names of the item itself.
BLOCK_TARGET = r"(?:\d+[A-Z]|[A-Z]+-?\d+[A-Za-z]?)"
BLOCK_TARGET_RE = re.compile(r"\b(%s)\b" % BLOCK_TARGET)
QUEUE_PHASE_TARGET_RE = re.compile(r"\bPhase\s+(%s)\b" % BLOCK_TARGET)
QUEUE_LEADING_TARGET_RE = re.compile(
    r"^- \[[ xX]\]\s+(?:\*\*)?(%s)(?=\s+(?:—|PRECONDITION\b))" % BLOCK_TARGET
)


def known_block_targets(lines):
    """Canonical phase/item ids declared by checkbox labels in QUEUE.md."""
    out = set()
    for line in lines:
        if not re.match(r"^- \[[ xX]\]", line):
            continue
        out.update(QUEUE_PHASE_TARGET_RE.findall(line))
        leading = QUEUE_LEADING_TARGET_RE.match(line)
        if leading:
            out.add(leading.group(1))
    return out


def _block_target_tokens(text):
    """Runtime targets; shares its grammar with queue validation above."""
    return {m.group(1).upper().replace("-", "") for m in BLOCK_TARGET_RE.finditer(text or "")}


def _tokens(text):
    """Phase/item tokens named in a line — '3A', 'G1', 'F-8'."""
    return {m.group(1).upper().replace("-", "") for m in PHASE_RE.finditer(text or "")}


def gates_blocking(item_line, gates_path=None):
    """Which active gates block this queue item? Returns a list of gate dicts."""
    gs, err = active_gates(gates_path)
    if gs is None:
        return []
    want = _block_target_tokens(item_line)
    if not want:
        return []
    hits = []
    for g in gs:
        declared = {t.upper().replace("-", "") for t in g.get("blocks", [])}
        if declared & want:
            hits.append(g)
    return hits


def undeclared_blocks(gates_path=None):
    """Gates whose TEXT blocks a phase they never DECLARED with `blocks:`.

    The paired half of gates_blocking. A gate that says "3A DOES NOT START" and
    carries no `blocks: 3A` is invisible to the chain — it reads as governed and
    is not. This reports it rather than letting the declaration quietly
    under-cover the ruling, the same way UNCARRIED reports a QUEUE.md ruling
    nobody transcribed. Deliberately noisy in the safe direction: it would
    rather flag a gate that merely mentions a phase than miss one that blocks it.
    """
    gs, err = active_gates(gates_path)
    out = []
    for g in gs or []:
        vb = g.get("verbatim", "")
        if not BLOCK_LANG_RE.search(vb):
            continue
        declared = {t.upper().replace("-", "") for t in g.get("blocks", [])}
        # tokens named in the ruling, minus the gate's own key/ruling name
        own = _tokens(g.get("key", "")) | _tokens(g.get("ruling", ""))
        named = _tokens(vb) - own
        missing = named - declared
        if missing:
            out.append((g.get("key"), sorted(missing), sorted(declared)))
    return out


def format_parsed_blocks(blocks):
    """Make list shape visible; joining hides one combined token as two."""
    return repr(list(blocks))


# ── verify a prompt actually carries them (the anti-grep check) ────────────
def verify_prompt(text, gates_path=None):
    """Does this prompt carry every active gate? Returns (ok, missing_keys).

    Containment is tested on NORMALISED text, so a prompt that reflowed,
    re-wrapped or re-indented the block still passes, and a prompt that
    SUMMARISED it still fails. That asymmetry is the entire point.
    """
    gs, err = active_gates(gates_path)
    if gs is None:
        return False, ["GATE-SOURCE-UNREADABLE"]
    hay = normalize(text)
    if gates_mode() == "compact":
        # Compact contract: non-negotiables verbatim, every other gate by its
        # exact headline line. Still containment, still fails on a paraphrase
        # or a dropped gate — it just checks the compact shape.
        missing = [g.get("key") for g in gs
                   if normalize(g.get("verbatim", "")) not in hay
                   and (compact_inline(g) or normalize(headline(g)) not in hay)]
        return (not missing), missing
    missing = [g.get("key") for g in gs if normalize(g.get("verbatim", "")) not in hay]
    return (not missing), missing


ACCEPTED_FORMS = (
    "accepted forms:",
    "  fm_gates.py [check [--gates PATH] [--queue PATH]]",
    "  fm_gates.py render [--for launch|claude|codex|subagent]",
    "  fm_gates.py gates-blocking ITEM",
    "  fm_gates.py undeclared-blocks",
    "  fm_gates.py digest",
    "  fm_gates.py verify-prompt [FILE]",
    "  fm_gates.py list",
)


def argv_error(token, detail):
    """Render command-line misuse loudly and consistently; caller returns rc=2."""
    print("ARGUMENT-ERROR: %s: %s" % (token, detail), file=sys.stderr)
    print("\n".join(ACCEPTED_FORMS), file=sys.stderr)


def parse_check_paths(args):
    """Parse check-only path flags. Explicit path > environment > default."""
    selected = {"--gates": None, "--queue": None}
    i = 0
    while i < len(args):
        token = args[i]
        if token not in selected:
            return None, (token, "unknown argument for check")
        if selected[token] is not None:
            return None, (token, "duplicate argument")
        if i + 1 >= len(args) or args[i + 1].startswith("--"):
            return None, (token, "missing PATH value")
        path = args[i + 1]
        if not os.path.exists(path):
            return None, (path, "path does not exist (from %s)" % token)
        selected[token] = path
        i += 2
    return (selected["--gates"] or GATES_PATH,
            selected["--queue"] or QUEUE_PATH), None


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "check"
    args = argv[2:] if len(argv) > 1 else []
    if cmd == "check":
        paths, error = parse_check_paths(args)
        if error:
            argv_error(*error)
            return 2
        gates_path, queue_path = paths
        ok, rep = check(gates_path, queue_path)
        print("\n".join(rep))
        return 0 if ok else 1
    if cmd == "render":
        where = "launch"
        if args:
            if len(args) != 2 or args[0] != "--for":
                argv_error(args[0], "unknown or incomplete argument for render")
                return 2
            where = args[1]
            if where not in ("launch", "claude", "codex", "subagent"):
                argv_error(where, "unknown render audience")
                return 2
        text, err = render(where=where)
        if text is None:
            print("\n".join("ERROR: " + e for e in err), file=sys.stderr)
            return 1
        print(text)
        return 0
    if cmd == "gates-blocking":
        # Prints the blocking rulings verbatim, or nothing. Exit 0 either way:
        # the CALLER decides what to do about a blocked item, and "no gates
        # block this" is a successful answer, not an error.
        if len(args) != 1:
            token = args[1] if len(args) > 1 else "gates-blocking"
            argv_error(token, "gates-blocking requires exactly one ITEM")
            return 2
        item = args[0]
        hits = gates_blocking(item)
        for g in hits:
            print("── %s (%s, %s) blocks: %s ──" % (
                g.get("key"), g.get("authority"), g.get("dated"),
                ", ".join(g.get("blocks", []))))
            print((g.get("verbatim") or "").strip())
            print()
        return 0
    if cmd == "undeclared-blocks":
        if args:
            argv_error(args[0], "undeclared-blocks takes no arguments")
            return 2
        out = undeclared_blocks()
        for key, missing, declared in out:
            print("BLOCK-UNDECLARED: %s uses blocking language about %s but declares blocks: %s"
                  % (key, ", ".join(missing), format_parsed_blocks(declared)))
        return 1 if out else 0
    if cmd == "digest":
        if args:
            argv_error(args[0], "digest takes no arguments")
            return 2
        sd = set_digest()
        if sd is None:
            return 1
        print(sd)
        return 0
    if cmd == "verify-prompt":
        if len(args) > 1:
            argv_error(args[1], "verify-prompt accepts at most one FILE")
            return 2
        if args and not os.path.exists(args[0]):
            argv_error(args[0], "path does not exist")
            return 2
        text = open(args[0], errors="replace").read() if args else sys.stdin.read()
        ok, missing = verify_prompt(text)
        print("CARRIED" if ok else "NOT-CARRIED: " + ", ".join(str(m) for m in missing))
        return 0 if ok else 1
    if cmd == "list":
        if args:
            argv_error(args[0], "list takes no arguments")
            return 2
        gs, err = active_gates()
        if gs is None:
            print("\n".join(err), file=sys.stderr)
            return 1
        for g in gs:
            print("%-16s %-6s %-8s %s" % (g["key"], g["ruling"], g["dated"],
                                          (g.get("verbatim") or "").strip().split("\n")[0][:70]))
        return 0
    argv_error(cmd, "unknown subcommand")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
