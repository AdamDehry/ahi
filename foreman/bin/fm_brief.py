#!/usr/bin/env python3
"""fm_brief — the foreman→supervisor briefing contract.

Classifier + envelope renderer + internal ledger for foreman wakes. Called by
fm_wake_michael() in lib.sh on every wake. Normative contract:
BRIEFING-CONTRACT.md in the foreman root.

FOUR LAWS THIS FILE IS WRITTEN AROUND
-------------------------------------
1. FAIL-OPEN. Every failure path exits non-zero and prints NOTHING usable to
   stdout. The caller (fm_wake_michael) then POSTs the original payload, so the
   wake is byte-identical to what it would be without this file. This file can
   never silence a wake.

2. NOTHING IS THINNED BEFORE IT IS LOGGED. The ledger append happens BEFORE any
   stdout is written, and a failed append is a hard failure (law 1 then applies).
   `raw` in the ledger is byte-identical to the payload received on stdin.

3. PROSE NEVER SELECTS THE CLASS, AND THE MACHINE NEVER INVENTS AN ASK. The base
   class is a lookup on the transport the CALL SITE declared; DECISION comes only
   from an ask the EXECUTOR declared in its own report (`#FMASK1`). Payload text
   and build names are rendered, clipped and logged — never used to pick a class.

4. THE ONLY PROSE THAT IS READ IS A SAFETY VETO, AND IT ONLY ADDS VISIBILITY.
   An unmistakable authority phrase in an executor report declared no-reply
   forces visible raw delivery. It never assigns DECISION, and it never applies
   to fixed-plumbing transports (permission dialogs, heartbeats, retries …), so
   plumbing cannot talk its way into a visible format however it is worded.

EVENT MEANING, NOT TRANSPORT
----------------------------
  A. A TERMINAL BUILD OUTCOME (done / failed / abandoned) is a visible
     `BUILD PROGRESS` milestone, declared by the closing script, which holds
     that fact by construction. Nobody declares a milestone by hand.

  B. A SUBSTANTIVE EXECUTOR STOP the supervisor can resolve is a visible
     `FOREMAN CHECK-IN`. Heartbeat, permission, retry, stop-watch and other
     infrastructure wakes stay INTERNAL.

  C. THE STANDARD GATE-RECONCILE BANNER IS STRIPPED BEFORE ANY RULE RUNS. The
     foreman staples it onto every wake it emits, so letting it vote would let a
     transport decoration override every event it decorates. A gate ALARM
     (`!!! GATE-RECONCILE RED`) is NOT the standard banner: it stays in the
     classification view and is carried into every rendered body.

  D. THE RAW PAYLOAD TRAVELS NO FURTHER THAN THE LEDGER. A classified wake puts
     the CONCISE RENDERED BODY on the wire, not the terminal transcript; an
     INTERNAL wake sends the MINIMAL INTERNAL ENVELOPE only. Every rendered body
     names its ledger path, so nothing is lost — it is moved, not dropped.

  WHAT D COSTS, SAID OUT LOUD: a hook that required the output to END WITH THE
  ORIGINAL PAYLOAD VERBATIM would make a "helpful" rewrite structurally
  impossible, and thinning is incompatible with that check. The wire guarantee
  is sentinel + end-marker + non-empty body, and the defence against silent
  rewriting lives in the ledger: `raw` is the payload byte-identical, `wire` is
  exactly what was sent, and both are fsync'd before one byte is emitted.

SUBCOMMANDS
    classify       payload on stdin -> ledger append + `#FMBRIEF1` + envelope
                                       + CONCISE BODY + `#FMBRIEF-END`
    validate       message on stdin -> exit 0 if it satisfies its format's rails, 1 if not
    render         JSON on stdin    -> one binding format, or the safe fallback line
    strip-inbound  payload on stdin -> the plain-English sentences only

EXIT CODES
    0  success (classify: emitted; validate: message ACCEPTED)
    1  validate: REJECTED · render: fallback used · strip-inbound: nothing left
       (classify never uses 1)
    2  failure of any kind — caller must fail open

ENVIRONMENT
    FM_BRIEF_LOG_DIR      ledger directory (default $FOREMAN_ROOT/briefings,
                          FOREMAN_ROOT defaulting to $AHI_HOME/foreman, AHI_HOME to ~/ahi)
    FM_BRIEF_PRODUCER, FM_BRIEF_TRANSPORT   declared call site + transport pair
    FM_BRIEF_CALLER, FM_BRIEF_CLASS, FM_BRIEF_CATEGORY, FM_BRIEF_BUILD_ID
    FM_BRIEF_PRESENTATION_EMERGENCY_LOG     second sink for presentation rejects
"""

from __future__ import annotations

import argparse
import base64
import collections
import datetime
import json
import os
import re
import sys

SENTINEL = "#FMBRIEF1"
#: The wire frame is sentinel + body + END_MARKER. The end marker is what makes
#: truncation detectable once the body is no longer the payload.
END_MARKER = "#FMBRIEF-END"
VERSION = "fm_brief/1.6"

#: Shaping bound for the executor excerpt. Facts have no separate character
#: budget: a per-fact budget discarded true facts while delivery headroom went
#: unused, so the final delivered-byte limiter is the only fact-admission decision.
MAX_EXCERPT_CHARS = 400

INTERNAL = "INTERNAL"
PROGRESS = "PROGRESS"
CHECKIN = "CHECKIN"
DECISION = "DECISION"
ORDINARY = "ORDINARY"

CLASSES = (INTERNAL, PROGRESS, CHECKIN, DECISION, ORDINARY)

#: §3 closed set. Belongs to DECISION ALONE — a CHECK-IN never carries one.
CATEGORIES = ("authority", "scope", "tradeoff", "blocked")


# ---------------------------------------------------------------------------
# DECLARATION CORE
#
# Inferring the event type from mutable prose — the executor's report text or
# the human-chosen build name — fails in the one direction that costs the owner
# something: an unrelated "No" earlier in a clause demoted a real sudo ask to
# no-reply, and a build NAME containing "retry" let a plumbing word list
# silence that build's substantive wakes. Patching the word list does not close
# that class of defect; removing prose's reach does. So the class comes from
# declarations, and every declaration is checkable against PRODUCERS.
#
# TWO ORTHOGONAL LAYERS, and keeping them orthogonal IS the design:
#
#   1. TRANSPORT KIND — declared by the call site, which always knows it.
#      Resolved as an atomic pair from argv first, then from the explicit
#      FM_BRIEF_PRODUCER/FM_BRIEF_TRANSPORT environment pair, then from a tiny
#      caller map whose only entry needs corroborating legacy-class metadata.
#      It is never inferred from payload prose. Partial declarations are never
#      completed across sources; every non-empty pair is matrix-validated.
#
#   2. EXECUTOR ASK — declared by the author of the report. Only an executor
#      can know whether its own report is asking for a ruling. foreman_wake.sh
#      knows it carries an idle report; it did not write that report and cannot
#      know whether the text inside asks for sudo. So no shell may declare
#      DECISION. A declared ask is the ONLY thing that produces it.
#
# COMPOSITION:
#
#   transport declared + ask declared  -> formatted; class from transport,
#                                         DECISION/category from the ask
#   transport declared + ask absent    -> formatted PER TRANSPORT. Absence of
#                                         an ask MUST NOT erase known transport
#                                         provenance, or every build close dumps
#                                         its whole transcript on the owner.
#   transport absent   + ask absent    -> ORDINARY byte-identical raw, through
#                                         an explicit fallback branch.
#
# Prose is RENDERED, CLIPPED and LOGGED. Prose never selects the base class.
# The single exception is Contract 5, and it is a safety VETO rather than a
# classifier: an unmistakable authority request in a producer-declared no-reply
# SUBSTANTIVE report invalidates that declaration and forces visible raw, so a
# bad declaration cannot suppress a decision the owner has to make. It may only
# increase visibility. It never assigns DECISION or a category — a forged or
# quoted ask block therefore costs noise, never silence — and it never applies
# to a producer contractually fixed as plumbing.
#
# NOT A SECURITY BOUNDARY, stated here rather than implied away: any process
# running as the same Unix user can call fm_wake_michael or this formatter
# directly. What this design proves is separation from payload and name DATA,
# plus a code-level producer contract. It does not authenticate processes.
# ---------------------------------------------------------------------------

#: Transport kinds — CLOSED set (Contract 1). Declared by a validated source.
T_TERMINAL_CLOSE = "terminal-close"
T_IDLE_REPORT = "idle-report"
T_STALL = "stall"
T_RETRY = "retry"
T_PERMISSION = "permission"
T_STOP_WATCH = "stop-watch"
T_HEARTBEAT = "heartbeat"
T_CODEX_NOTIFY = "codex-notify"
T_REPLAY = "replay"

TRANSPORTS = (
    T_TERMINAL_CLOSE, T_IDLE_REPORT, T_STALL, T_RETRY, T_PERMISSION,
    T_STOP_WATCH, T_HEARTBEAT, T_CODEX_NOTIFY, T_REPLAY,
)

#: Transports that are FIXED PLUMBING. Contract 5's safety veto never applies to
#: these: they carry no executor report, so an authority phrase inside one came
#: from transport prose and must not be able to escalate it. This is the narrow,
#: declared home of "prose cannot promote plumbing" — a word list of failure
#: phrases can never close that class; a closed set of transports can.
FIXED_PLUMBING = frozenset({
    T_STOP_WATCH, T_HEARTBEAT, T_CODEX_NOTIFY, T_RETRY, T_PERMISSION,
})

#: Transports that carry an executor-authored report, and are therefore the only
#: ones where a declared ask or the Contract 5 veto can apply.
EXECUTOR_BEARING = frozenset({T_IDLE_REPORT, T_STALL, T_TERMINAL_CLOSE})

#: Base class per transport. This is the whole of class selection for a declared
#: event: a lookup, with no reference to payload text.
TRANSPORT_CLASS = {
    T_TERMINAL_CLOSE: PROGRESS,
    T_IDLE_REPORT: CHECKIN,
    T_STALL: CHECKIN,
    T_RETRY: INTERNAL,
    T_PERMISSION: INTERNAL,
    T_STOP_WATCH: INTERNAL,
    T_HEARTBEAT: INTERNAL,
    T_CODEX_NOTIFY: INTERNAL,
    T_REPLAY: "",          # carrier only; resolved from the replayed original
}

#: PRODUCER MATRIX (Contract 2). call-site id -> allowed transports.
#: A known producer using a transport outside its row is a CONTRACT FAILURE, not
#: a warning. Every live fm_wake_michael call site belongs here, and every row
#: here should have a live call site.
#:
#: The call-site id is also the ledger's stable provenance field: a caller
#: BASENAME cannot prove which line inside a multi-site producer fired, and
#: deriving finer attribution from header prose would reintroduce prose-reading.
PRODUCERS = {
    "build_done.sh:terminal-close":        (T_TERMINAL_CLOSE,),
    "foreman_wake.sh:idle-report":         (T_IDLE_REPORT,),
    "foreman_wake.sh:stall":               (T_STALL,),
    "foreman_wake.sh:retry":               (T_RETRY,),
    "foreman_notify.sh:permission-dialog": (T_PERMISSION,),
    "foreman_notify.sh:permission-retry":  (T_RETRY,),
    "foreman_heartbeat.sh:died":           (T_HEARTBEAT,),
    "foreman_heartbeat.sh:parked":         (T_HEARTBEAT,),
    "foreman_heartbeat.sh:dark":           (T_HEARTBEAT,),
    "fm_stop_watch.sh:idle-stop":          (T_STOP_WATCH,),
    "foreman_codex_notify.sh:unknown":     (T_CODEX_NOTIFY,),
    "lib.sh:deferred-replay":              (T_REPLAY,),
}

#: Declarations the formatter can derive from vocabulary callers already send.
#: Deliberately a CLOSED and tiny map: a caller basename only belongs here when
#: that script has exactly one semantic wake kind. Multi-site producers such as
#: foreman_wake.sh remain unlabeled unless they send the explicit pair.
CALLER_DECLARATIONS = {
    "build_done.sh": (
        "build_done.sh:terminal-close", T_TERMINAL_CLOSE, PROGRESS,
    ),
}


def resolve_declaration(args, caller: str, declared: str = "") -> tuple:
    """Return (producer, transport, source) without mixing trust sources.

    Precedence is atomic rather than per field: any argv declaration selects
    the argv pair, any environment declaration selects the environment pair,
    and caller derivation is considered only when both explicit sources are
    wholly absent. Therefore an incomplete explicit declaration fails loud (or
    remains visibly unlabeled) instead of being silently completed by ambient
    state or by the caller fallback.

    The environment fallback is required because lib.sh's one production
    invocation passes no classify argv. Caller derivation makes today's
    build_done.sh terminal-close path reachable before any producer patch is
    installed; its caller basename is already exported by fm_wake_michael.
    """
    if args.producer or args.transport:
        return args.producer, args.transport, "argv"

    env_producer = os.environ.get("FM_BRIEF_PRODUCER", "")
    env_transport = os.environ.get("FM_BRIEF_TRANSPORT", "")
    if env_producer or env_transport:
        return env_producer, env_transport, "environment"

    inferred = CALLER_DECLARATIONS.get(os.path.basename(caller))
    if inferred is not None and (declared or "").strip().upper() == inferred[2]:
        return inferred[0], inferred[1], "caller-derived"
    if inferred is not None:
        # Fidelity beats labels: a known caller with missing or contradictory
        # corroboration remains visible raw instead of being labelled by guess.
        return "", "", "caller-unconfirmed"
    return "", "", "unlabeled"

#: The executor's ask block. The executor writes this itself, so there is no
#: forgery boundary between "the executor declared an ask" and "the executor's
#: text contains one" — they are the same act. What a hostile or careless report
#: CAN do is quote someone else's block, and by Contract 5 that only ever
#: manufactures a DECISION where none was needed: noise, never silence. It must
#: be the last block of the report, anchored at line start.
ASK_RE = re.compile(
    r"^#FMASK1[ \t]*\n(?P<fields>(?:[ \t]*[a-z]+:[^\n]*\n)+?)[ \t]*#FMASK-END[ \t]*$",
    re.M,
)


def parse_producer(raw: str) -> str:
    """Validate a call-site id against PRODUCERS. Empty means UNLABELED.

    Raises on an unknown id rather than guessing. A declaration that cannot be
    checked is worse than no declaration, because it looks authoritative.
    """
    pid = (raw or "").strip()
    if not pid:
        return ""
    if pid not in PRODUCERS:
        raise ValueError(f"unknown producer call-site id: {pid!r}")
    return pid


def parse_transport(raw: str, producer: str) -> str:
    """Validate a transport kind, and enforce the producer's allowed set."""
    t = (raw or "").strip().lower()
    if not t:
        return ""
    if t not in TRANSPORTS:
        raise ValueError(f"unknown transport kind: {raw!r}")
    # The matrix must bind even when the caller names nobody. Otherwise
    # `--transport idle-report` alone would yield a trusted-looking CHECK-IN,
    # and `--transport terminal-close` alone PROGRESS — the highest-visibility
    # class — from a caller that identified no one. A class you can claim
    # without claiming who you are is not a declaration, it is a wish.
    #
    # So a non-empty transport REQUIRES a valid producer. The converse stays:
    # a producer with no transport is UNLABELED and goes to visible raw,
    # because that direction costs bytes rather than silence.
    if not producer:
        raise ValueError(
            f"transport {t!r} declared with no --producer; a transport without "
            f"a call-site identity cannot be checked against the matrix"
        )
    allowed = PRODUCERS[producer]
    if t not in allowed:
        raise ValueError(
            f"producer {producer} may not declare transport {t!r}; "
            f"allowed: {', '.join(allowed)}"
        )
    return t


#: The only fields an ask block may carry. A parser that read `kind` and ignored
#: the rest would accept `sudo: true` as a clean DECISION, and a duplicate
#: `kind:` would silently let the last one win. An extra field in a block that
#: otherwise parses clean is a declaration nobody validated.
ASK_FIELDS = frozenset({"kind", "what"})

#: `kind: none` is an EXPLICIT NO-ASK — a positive machine claim, not the same
#: fact as an absent block. "This executor has nothing to ask" and "this
#: executor never heard of the protocol" (the day-one default) differ in exactly
#: one way that matters: with an explicit no-ask the CHECK-IN envelope may say
#: the executor declared no ruling is needed; with mere absence that would be an
#: unverified claim the formatter has no business making.
ASK_NONE = "none"

#: Sentinel for a block that exists and cannot be trusted. Distinct from None,
#: which means no block at all. Contract 5: malformed or ambiguous
#: metadata goes to VISIBLE RAW, not to the transport's ordinary rendering —
#: the executor tried to say something and we could not read it, and quietly
#: rendering the default would be the formatter deciding what it failed to
#: parse.
ASK_MALFORMED = object()


def parse_ask(payload: str):
    """Classify the executor's ask declaration. Four outcomes, three of them
    distinguishable states rather than shades of failure:

      None            no `#FMASK1` block at all — UNLABELED ask
      ASK_MALFORMED   a block that exists and cannot be trusted
      (ASK_NONE, "")  an explicit, positive "I have no ask"
      (category, what) a declared ask, category from the closed CATEGORIES set

    Only the report author writes this, so there is deliberately no forgery
    boundary between "declared an ask" and "text contains one" — for the
    producer of a report those are one act. The last block wins, so the author's
    own final block always beats a quoted one above it, and a quoted block alone
    can therefore only ever manufacture noise, never silence.
    """
    m = None
    for m in ASK_RE.finditer(payload):
        pass                      # last block wins; a quoted earlier one cannot
    if m is None:                 # win over the executor's own final block
        return None

    fields, dupes = {}, False
    for line in m.group("fields").splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k = k.strip().lower()
        if k in fields:
            dupes = True          # conflicting claims; do not pick a winner
        fields[k] = v.strip()

    # Every rejection below lands on ASK_MALFORMED, and malformed means VISIBLE
    # RAW. None of these is a judgement call about what the executor "meant".
    if dupes:
        return ASK_MALFORMED
    unknown = set(fields) - ASK_FIELDS
    if unknown:
        return ASK_MALFORMED
    kind = fields.get("kind", "").lower()
    if not kind:
        return ASK_MALFORMED

    if kind == ASK_NONE:
        # An explicit no-ask carries no `what:`; requiring one would be asking
        # an executor to explain a question it just said it does not have.
        if fields.get("what"):
            return ASK_MALFORMED
        return (ASK_NONE, "")

    if kind not in CATEGORIES:
        # An unrecognised kind is a REAL ask we cannot route — `spend`,
        # `credential` and `deploy` are all plausible things to need a ruling
        # on, and the closed set may simply be too narrow. Surfacing it raw is
        # the only answer that neither drops it nor invents a category for it.
        return ASK_MALFORMED
    if not fields.get("what"):
        # An ask with no statement of what is being asked cannot be restated,
        # and restate-or-downgrade is the entire value of the DECISION envelope.
        return ASK_MALFORMED
    return (kind, fields["what"])


def veto_input(payload: str) -> str:
    """The text the Contract 5 safety veto is allowed to read.

    Reading the whole payload let an innocent build NAME (`sudo access review`)
    change an outcome. Narrowing it to `executor_report(payload)` was WORSE:
    that extractor wants a fenced report block, so for an ordinary payload it
    returned nothing and the veto stopped firing on a genuine authority phrase
    altogether — a safety net that silently stops catching, while tests that
    only checked build names stayed green.

    So the rule is STRUCTURAL, not content-matching: drop the lines the
    TRANSPORT wrote — the leading `(foreman …)` header and the appended
    provenance — and let the veto read everything else. No regex hunts for a
    build id or a quoted name inside the text; position and authorship decide.
    """
    # A generated header is one physical line by the producer contract.
    # Position establishes authorship; the text inside the line does not
    # establish its end. Strip exactly that first line only when the whole
    # line has a known generated shape at byte zero. On any mismatch, strip
    # NOTHING and give the veto the original payload: false-positive noise is
    # recoverable, while hiding an authority ask is not.
    end = generated_header_line_end(payload)
    if end is None:
        return payload
    return PROV_LINE_RE.sub("", payload[end:])


Verdict = collections.namedtuple("Verdict", "cls axis category")


# ── provenance, appended by fm_wake_michael ITSELF ────────────────────────────
#: Downstream of every caller: a caller cannot reword its way out of it, because
#: it never sees it. Whole-line form, for stripping.
PROV_LINE_RE = re.compile(r"^\(provenance:[^\n]*\n?", re.M)

# ONE GENERATED PHYSICAL HEADER LINE.
#
# These are the header families emitted by the producer matrix: permission,
# heartbeat/dark, stall, chain, stop-watch, retry, ordinary wake, Codex notify,
# and terminal close. build_start.sh refuses control bytes in a build NAME, so
# every valid header is exactly one physical line. This matcher is applied with
# fullmatch() to payload line zero only: it never hunts through later executor
# content and never parses an interpolated name to find a boundary.
GENERATED_HEADER_LINE_RE = re.compile(
    r"(?:"
    r'\(foreman BUILD CLOSED — build [^\r\n]+ / "[^\r\n]*" — status '
    r"(?:done|failed|abandoned)\)"
    r"|\(foreman heartbeat — build [^\r\n]*\)"
    r"|\(foreman STALL ALERT — build [^\r\n]*\)"
    r"|\(foreman CHAIN\b[^\r\n]*\)"
    r"|\(foreman stop-watch — build [^\r\n]*\)"
    r'|\(foreman wake retry — build [^\r\n]+ / "[^\r\n]*"\)'
    r'|\(foreman wake — build [^\r\n]+ / "[^\r\n]*"\)'
    r"|\(foreman Codex notify\b[^\r\n]* — build [^\r\n]*\)"
    r"|\(foreman — build [^\r\n]* is WAITING on a permission dialog\)"
    r"|\(foreman — build [^\r\n]* STILL WAITING — retry after rate-limit window\)"
    r")"
)


def generated_header_line_end(payload: str):
    """End offset of one generated physical header line at payload position 0.

    `None` is the fail-loud result: the caller must expose the whole payload to
    the Contract-5 veto. The returned offset includes the line feed when one is
    present, so no transport-authored separator leaks into the veto view.
    """
    newline = payload.find("\n")
    end = len(payload) if newline < 0 else newline
    first_line = payload[:end]
    if GENERATED_HEADER_LINE_RE.fullmatch(first_line) is None:
        return None
    return end if newline < 0 else end + 1


BUILD_ID_RE = re.compile(r"\b\d{8}-\d{6}-[A-Za-z0-9][A-Za-z0-9._-]*\b")


def _first_line(payload: str) -> str:
    for ln in payload.splitlines():
        if ln.strip():
            return ln.strip()
    return ""


# ── THE STANDARD GATE BANNER IS TRANSPORT, NOT EVENT ─────────────────────────
# STANDARD = the routine one-liner every wake carries. Removed from the view
# before any rule runs, so it can neither veto nor decide anything.
GATE_STANDARD_RE = re.compile(
    r"^[ \t]*(?:GATE-RECONCILE GREEN|GATE-SET CARRY)\b[^\n]*\n?", re.M
)
# ALARM = a RED / RED-UNKNOWN reconcile and its repair lines. NOT stripped: a
# gate alarm is a real state, it stays in the view, and `carry_gate_alarm` puts
# it back into every rendered body. Ignoring the banner must never become
# ignoring the alarm just because that makes the output quieter.
GATE_ALARM_RE = re.compile(r"^[ \t]*(?:!{1,3}[ \t]*)?GATE[- ]RECONCILE\b[^\n]*", re.M)


def classification_view(payload: str) -> str:
    """The payload as the rules see it: standard gate banner removed.

    Everything else — including a gate ALARM — survives.
    """
    return GATE_STANDARD_RE.sub("", payload)


def carry_gate_alarm(payload: str) -> list:
    """Gate ALARM lines, to be re-attached to any rendered body. Never the
    standard banner: that one is noise by design."""
    return [ln.rstrip() for ln in GATE_ALARM_RE.findall(payload)
            if not ln.lstrip().startswith("GATE-RECONCILE GREEN")]


# ── THE EXECUTOR REPORT BLOCK ─────────────────────────────────────────────────
# The idle/retry wakes fence the executor's own last report between `---` lines.
# That fence is the structural mark of executor-authored content: the foreman
# writes the fence, the executor writes what is inside it.
REPORT_FENCE_RE = re.compile(r"^---[ \t]*$\n(.*?)\n^---[ \t]*$", re.M | re.S)

#: The deferred-replay trailer lib.sh appends: a line opening with "(" that says
#: "this wake was DEFERRED". Matched on that phrase, never on an id prefix.
_DEFERRAL_HEAD = r"\([^\n]*\bwake was DEFERRED\b"
#: The identical instruction menu every idle wake carries. It is the foreman
#: talking to itself; it is not news and it never travels.
BOILERPLATE_RE = re.compile(
    r"^You are the foreman\. Read, decide, act.*?"
    r"(?=^\(provenance:|^" + _DEFERRAL_HEAD + r"|\Z)",
    re.M | re.S,
)
DEFERRAL_RE = re.compile(r"^" + _DEFERRAL_HEAD + r"[^\n]*(?:\n(?!\()[^\n]*)*", re.M)
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
#: Terminal decoration: box-drawing, block/geometric marks, braille spinners,
#: the `⎿` continuation glyph, NBSP. Replaced with a space, never deleted, so
#: word boundaries survive.
DECOR_RE = re.compile(
    "[\u00a0\u2022"          # NBSP, bullet
    "\u2500-\u257f"          # box drawing
    "\u2580-\u259f\u25a0-\u25ff"  # blocks, geometric shapes
    "\u2300-\u23ff"          # misc technical, incl. the ⎿ continuation glyph
    "\u2800-\u28ff]"         # braille spinners
)


def clean_terminal_text(s: str) -> str:
    s = ANSI_RE.sub("", s)
    s = DECOR_RE.sub(" ", s)
    lines = []
    for ln in s.splitlines():
        ln = ln.rstrip()
        if ln.strip():
            lines.append(re.sub(r"[ \t]{2,}", " ", ln).strip())
    return "\n".join(lines)


#: Pane chrome the Codex/Claude lanes paint around the executor's actual words.
#: It is at the BOTTOM of a `tmux capture-pane` tail, which is exactly where an
#: excerpt of the most recent output lands — so without this the excerpt is a
#: screenshot of a prompt line. This is an enumeration and cannot be proven
#: complete. It is safe in the failure direction: an unrecognised chrome line
#: costs excerpt space, never substance.
CHROME_RES = tuple(re.compile(p, re.I) for p in (
    r"^[❯>$#]\s*$",
    r"tmux focus-events",
    r"bypass permissions on",
    r"esc to interrupt",
    r"shift\+tab to cycle",
    r"^\s*\S*(?:ing)…?\s*\(.*\b\d+s\b",          # "Tinkering… (running stop hook · 15s …)"
    r"[↑↓]\s*[\d.,]+\s*k?\s*tokens",
    r"^\s*\?\s+for shortcuts\s*$",
    r"^\s*/rc active\s*$",
))


def strip_pane_chrome(text: str) -> str:
    return "\n".join(
        ln for ln in text.splitlines()
        if not any(rx.search(ln) for rx in CHROME_RES)
    )


def executor_report(payload: str) -> str:
    """The executor's own text, cleaned. Empty string when there is none."""
    m = REPORT_FENCE_RE.search(payload)
    if not m:
        return ""
    return strip_pane_chrome(clean_terminal_text(m.group(1))).strip()


# ── classification ────────────────────────────────────────────────────────────

#: Contract 5's veto detector. It DELIBERATELY has no negation model: deciding
#: whether an authority phrase was negated is how a stray "No" about an
#: unrelated clause once silenced a real ask for sudo. Here a false positive
#: costs VISIBILITY ONLY — raw delivery instead of a formatted CHECK-IN — so
#: "no sudo is required" tripping the veto is harmless noise. Cheap noise beats
#: any chance of silence, and that asymmetry is why the veto is shaped this way.
#: For the same reason the possessive arms accept any `<word>'s` (Michael's, the
#: owner's, a person's name): broadening them can only add visibility.
AUTHORITY_VETO_RE = re.compile(
    r"(?:\bsudo\b"
    r"|\broot\s+access\b"
    r"|\bpermission\s+(?:to|for)\b"
    r"|\bauthori[sz]ation\b"
    r"|\bneed(?:s)?\s+(?:your|the\s+owner['’]s|\w+['’]s)\s+(?:ruling|approval|decision|call)\b"
    r"|\bpending\s+(?:your|the\s+owner['’]s|\w+['’]s)\s+(?:ruling|approval|decision|call)\b"
    r"|\bawait(?:ing)?\s+(?:your|the\s+owner['’]s|\w+['’]s)\s+(?:ruling|approval|decision|call)\b"
    r"|\bshould\s+I\b"
    r"|\bmay\s+I\b"
    r"|\bcredential\b"
    r"|\bAPI\s+key\b"
    r")",
    re.I,
)


def authority_veto(view: str) -> bool:
    """True if a declared no-reply report shows an unmistakable authority ask.

    Monotone toward visibility by construction: the only thing a True can do is
    move the event to byte-identical raw delivery.
    """
    return bool(AUTHORITY_VETO_RE.search(view))


def classify_payload(payload: str, caller: str = "", declared: str = "",
                     *, producer: str = "", transport: str = "",
                     origin_producer: str = "", origin_transport: str = "") -> Verdict:
    """Return a Verdict(cls, axis, category) from DECLARATIONS, not from prose.

    The whole of base-class selection is a lookup in TRANSPORT_CLASS. No branch
    below reads the executor's report or the build name to decide the class.
    Order:

      1. validate the declarations (unknown id or forbidden transport RAISES;
         an unverifiable declaration is worse than none, because it looks
         authoritative)
      2. UNLABELED -> ORDINARY raw, per Contract 4. Never a no-reply class.
      3. replay -> resolve the ORIGINAL declaration, or fall to raw if the
         serialized origin is absent or untrusted. Replay is a carrier, not a
         semantic producer.
      4. declared executor ask -> DECISION + its category. The only route to
         DECISION that exists.
      5. Contract 5 safety veto, executor-bearing non-plumbing transports only.
      6. transport lookup.

    `declared` and `caller` are accepted for signature compatibility with older
    call sites and are recorded, but neither selects the class: `caller` is a
    basename, which cannot prove which line inside a multi-site producer fired,
    and `declared` arrives by environment, which ambient state can pollute.
    Both are superseded by the resolved, matrix-validated `producer`/`transport`
    pair.
    """
    view = classification_view(payload)
    producer = parse_producer(producer)
    transport = parse_transport(transport, producer)

    if not transport:
        # UNLABELED — no validated transport declaration. Low-volume in
        # practice, so paying raw bytes here is affordable. Prose is NOT
        # consulted to rescue concision, because consulting it is the defect.
        return Verdict(ORDINARY, "unlabeled", "")

    if transport == T_REPLAY:
        try:
            op = parse_producer(origin_producer)
            ot = parse_transport(origin_transport, op)
        except ValueError:
            return Verdict(ORDINARY, "replay-untrusted", "")
        if not ot or ot == T_REPLAY:
            return Verdict(ORDINARY, "replay-untrusted", "")
        producer, transport = op, ot

    declared_no_ask = False
    if transport in EXECUTOR_BEARING:
        ask = parse_ask(payload)
        if ask is ASK_MALFORMED:
            # Contract 5. The executor declared SOMETHING and it does not
            # parse. Rendering the transport default here would be the
            # formatter silently choosing an interpretation for metadata it
            # could not read — noise is the correct spend, information is not.
            return Verdict(ORDINARY, f"ask-malformed:{transport}", "")
        if ask is not None:
            cat, _what = ask
            if cat == ASK_NONE:
                declared_no_ask = True
            else:
                return Verdict(DECISION, f"ask:{transport}", cat)

    base = TRANSPORT_CLASS[transport]

    # Contract 5. Fixed-plumbing transports are exempt: they carry no executor
    # report, so an authority phrase inside one is transport prose and must not
    # escalate anything.
    if base == CHECKIN and transport not in FIXED_PLUMBING:
        # The veto reads veto_input(), never the whole payload: the
        # "(foreman wake — build <id> / "<name>")" header is written by the
        # transport, and transport text — including a human-chosen build name —
        # cannot testify about what the executor is asking for.
        if authority_veto(veto_input(payload)):
            return Verdict(ORDINARY, f"safety-veto:{transport}", "")

    # The axis distinguishes an executor that positively claimed no ask from one
    # that never spoke. Only the first makes the CHECK-IN envelope's "the
    # executor declared no ruling is needed" a warranted claim.
    if declared_no_ask:
        return Verdict(base, f"transport:{transport}:no-ask", "")
    return Verdict(base, f"transport:{transport}", "")


def extract_build_id(payload: str) -> str:
    m = BUILD_ID_RE.search(payload)
    return m.group(0) if m else "unattributed"


# ── envelopes ─────────────────────────────────────────────────────────────────
# Kept deliberately short: a gateway may also show the wake in the owner's feed,
# so every envelope byte can be a byte the owner sees. The high-frequency class
# (INTERNAL) therefore gets the smallest envelope: "say nothing" does not need a
# format spelled out.
ENVELOPE_INTERNAL = (
    "[BRIEF INTERNAL — plumbing. Nothing owed to the owner. "
    "If they need a line: BUILD PROGRESS only.]"
)

# Every envelope below instructs the BOLD-BULLET presentation form (see the
# PRESENTATION LAYER). The colon lives INSIDE the bold span, one blank line
# follows the header, and each non-decision field is exactly one plain-English
# sentence under 200 visible characters.
ENVELOPE_PROGRESS = """[BRIEF PROGRESS — the owner wants this; they need not answer it.
Reply to the owner in exactly this form, four fields, this order, ZERO '?' characters.
Bold header on its own line, then ONE blank line, then bullets with the colon
inside the bold span. One plain-English sentence per field, no paths, no
timestamps, no counts except in Acceptance:
**BUILD PROGRESS — no reply needed**

- **Finished:** <one short plain-English sentence, past tense>
- **Now:** <one short plain-English sentence, present tense>
- **Michael's steer:** <one short sentence, or "None this cycle, because …">
- **Acceptance:** <one short sentence using a verified count only>]"""

#: The CHECK-IN envelope must not assert "no authority is asked for" on every
#: check-in. With `#FMASK1 kind: none` the executor made that claim; with no
#: block at all — the day-one default, not an edge case — nobody did, and the
#: safety veto cannot catch every authority phrasing ("Could the owner
#: authorize the cutover?"). A longer veto phrase list is not the fix; that is
#: how word lists die. The fix is to stop asserting the unverified half: one
#: head states the DECLARATION and who made it, and stops; the other states its
#: own ignorance and tells the supervisor to read the report. Same class, same
#: handling, different honesty.
_CHECKIN_HEAD_DECLARED = (
    "[BRIEF CHECK-IN — substantive executor report you resolve YOURSELF. "
    "The executor DECLARED it needs no ruling (#FMASK1 kind: none). That is "
    "the executor's claim about its own report, not a verified fact about the "
    "text below: if the report asks for the owner's authority anyway, handle it "
    "as a DECISION regardless of this envelope. No category field."
)
_CHECKIN_HEAD_UNDECLARED = (
    "[BRIEF CHECK-IN — substantive executor report you resolve YOURSELF. "
    "The executor did NOT say whether it needs a ruling — it has not adopted "
    "the ask protocol — so READ THE REPORT before you treat this as needing no "
    "reply. If it does need the owner's authority, handle it as a DECISION "
    "regardless of this envelope. No category field."
)

ENVELOPE_CHECKIN = """[BRIEF CHECK-IN — substantive executor report you resolve YOURSELF. No reply is sought and no authority is asked for; if it needs the owner's authority it is a DECISION, not this. No category field.
Reply to the owner in exactly this form, four fields, this order, ZERO '?' characters — the executor's question must NOT survive into what the owner reads.
Bold header on its own line, then ONE blank line, then bullets with the colon
inside the bold span. One plain-English sentence per field, no paths, no
timestamps, no counts, no technical evidence:
**FOREMAN CHECK-IN — no reply needed**

- **Executor finished:** <one short plain-English sentence, past tense>
- **Executor stopped at:** <one short plain-English sentence>
- **Michael needs to inspect:** <one short plain-English sentence>
- **Next expected action:** <one short plain-English sentence>]"""

ENVELOPE_DECISION = """[BRIEF DECISION — before you send it, restate all three or downgrade:
(a) you cannot resolve it within authority you hold; (b) it needs an authority you lack
(sudo, spend, prod push, deletion, credential, external comms) or is outside brief scope;
(c) at least two genuinely available options. Two of three is a report, not a decision.
Form — exactly ONE '?' in the whole message, and it ends the final line; category
from {authority|scope|tradeoff|blocked}; bold header, ONE blank line, bullets with
the colon inside the bold span, ONE blank line before the question:
**DECISION REQUIRED — <category>**

- **Why this stopped:** <plain English, 1-3 sentences, no jargon, no file paths>
- **My recommendation:** <one sentence, and it must pick one>
- **Why you might choose differently:** <one honest counterpoint>

<one direct question, ending in ?>]"""

ENVELOPES = {
    INTERNAL: ENVELOPE_INTERNAL,
    PROGRESS: ENVELOPE_PROGRESS,
    CHECKIN: ENVELOPE_CHECKIN,
    DECISION: ENVELOPE_DECISION,
    ORDINARY: "",
}

#: The axis suffix `classify_payload` sets when the executor positively declared
#: it has no ask. The only thing that entitles the envelope to say so.
NO_ASK_AXIS_SUFFIX = ":no-ask"


def envelope_for(cls: str, axis: str) -> str:
    """The envelope, with CHECK-IN's opening claim matched to what is known.

    Everything after the first line is identical between the two CHECK-IN
    variants — the reply FORM does not change, only the assertion about whether
    anyone actually said no ruling was needed.
    """
    base = ENVELOPES[cls]
    if cls != CHECKIN:
        return base
    head = (_CHECKIN_HEAD_DECLARED if axis.endswith(NO_ASK_AXIS_SUFFIX)
            else _CHECKIN_HEAD_UNDECLARED)
    rest = base.split("\n", 1)[1] if "\n" in base else ""
    return head + "\n" + rest

#: What user-facing output this class permits. INTERNAL permits none — the
#: anti-masquerade check asserts exactly that.
USER_FACING_EXPECTED = {
    INTERNAL: "",
    PROGRESS: "BUILD PROGRESS",
    CHECKIN: "FOREMAN CHECK-IN",
    DECISION: "DECISION REQUIRED",
    ORDINARY: "",
}


# ── THE CONCISE RENDERED BODY ─────────────────────────────────────────────────
# What actually crosses the gateway. The raw payload stops at the ledger.
#
# THE ONE RULE THIS SECTION MAY NOT BREAK: every body it returns names its
# ledger path. Thinning without a pointer is deletion with extra steps. The
# ledger path is therefore the LAST thing built and the last thing truncated —
# which is to say, never.

def _deferral(payload: str) -> list:
    """The deferred-replay note ("this wake was DEFERRED Ns"). Always carried:
    a wake that arrives late without saying so is a wake that lies about when
    its facts were true."""
    return [m.group(0).strip() for m in DEFERRAL_RE.finditer(payload)]


def _provenance(payload: str) -> list:
    """Provenance. Exactly ONE line is carried — the replay path can append a
    second, and two provenance lines on one wake is a cosmetic lie about how
    many registries were read."""
    hits = [ln.strip() for ln in payload.splitlines() if ln.strip().startswith("(provenance:")]
    return hits[:1]


def _is_stale_pointer_line(line: str) -> bool:
    """True only for a pointer this formatter could have emitted here.

    A bare `startswith("full payload:")` predicate would silently delete
    executor prose beginning with those words. A real pointer is an unindented
    absolute path under this run's ledger directory, with the safe `.jsonl`
    basename produced by ledger_path_for(). Anything else is the executor's
    text and survives unchanged.
    """
    prefix = "full payload: "
    if not line.startswith(prefix):
        return False
    path = line[len(prefix):]
    directory, filename = os.path.split(path)
    if not os.path.isabs(path):
        return False
    if os.path.normpath(directory) != os.path.normpath(log_dir()):
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9._-]+\.jsonl", filename))


def _facts(payload: str) -> list:
    """The short structured lines a wake carries: its own header and whatever
    the producing script wrote around the fenced report. Boilerplate menu,
    fenced transcript and provenance are removed — none of them is news."""
    text = REPORT_FENCE_RE.sub("", payload)
    text = BOILERPLATE_RE.sub("", text)
    text = DEFERRAL_RE.sub("", text)
    text = PROV_LINE_RE.sub("", text)
    text = GATE_STANDARD_RE.sub("", text)
    out = []
    seen = set()
    for ln in clean_terminal_text(text).splitlines():
        # A payload that already carries a `full payload:` pointer is a
        # body that was thinned once already. Carrying its old pointer forward
        # would put two of them on one wire, the first of them stale — a wake
        # that names the wrong ledger is worse than one that names none.
        if _is_stale_pointer_line(ln):
            continue
        if ln and ln not in seen:
            seen.add(ln)
            out.append(ln)
    return out


def canonical_presentation(cls: str, payload: str):
    """The payload's own bytes when the PRODUCER already wrote this class's
    binding format, normalised to LF. `None` for everything else.

    This is the ONLY route by which a wake body can be a plain-English build
    message, and it carries no authorship of its own: the words are the
    producer's, already in the form, already passing every rail. Nothing here
    paraphrases, summarises, or substitutes a fixture. If the producer did not
    write the format, the answer is `None` and the caller thins the facts
    instead — because the plain sentences the owner reads are the supervisor's
    to write, and a program that writes them in its voice fabricates a report.
    """
    fmt = {CHECKIN: P_CHECKIN, PROGRESS: P_PROGRESS, DECISION: P_DECISION}.get(cls)
    if fmt is None:
        return None
    try:
        if detect_presentation_format(payload) != fmt:
            return None
        normalised = payload.replace("\r\n", "\n")
        if validate_presentation(normalised, fmt):
            return None  # in the form but breaks a rail — thin it, do not surface it
        return normalised
    except Exception:  # noqa: BLE001 — original bytes outrank rendering
        return None


def render_body(cls: str, payload: str, *, build_id: str, caller: str, axis: str,
                ledger_path: str, category: str = "", facts=None) -> str:
    """Render, and let a rendering failure REACH THE HOOK.

    No inner catch. Swallowing the exception and returning the payload reads as
    fail-open and is not: the caller would still prepend an envelope, so a
    rendering crash would deliver `envelope + raw payload` — a third thing,
    neither thinned nor byte-identical. Only the HOOK still holds the original
    `$msg`, so an exception exits non-zero, the hook's `|| _briefed=""` takes
    over, and the wake goes out byte-for-byte unformatted. One guard, at the
    boundary that owns the bytes, instead of two that disagree.
    """
    return _render_thinned_body(
        cls, payload, build_id=build_id, caller=caller, axis=axis,
        ledger_path=ledger_path, category=category, facts=facts,
    )


def _render_thinned_body(cls: str, payload: str, *, build_id: str, caller: str, axis: str,
                         ledger_path: str, category: str = "", facts=None) -> str:
    """Return the body that goes on the wire for this class.

    ORDINARY is byte-identical passthrough: an unrecognised payload is
    delivered exactly as it arrived. A classifier miss cannot silence or
    mangle a wake — it can only fail to quieten it.
    """
    if cls == ORDINARY:
        return payload

    # A producer-supplied canonical message goes on the wire as itself,
    # untouched. Everything else — including every real wake — takes the
    # thinned factual body below. Refusing to fabricate is right, but the
    # alternative to fabricating is thinning, not the whole transcript: a raw
    # build-close wake can run to tens of KB where its thinned body is ~2 KB.
    if cls in (CHECKIN, PROGRESS, DECISION):
        canonical = canonical_presentation(cls, payload)
        if canonical is not None:
            return canonical

    pointer = f"full payload: {ledger_path}"
    alarms = carry_gate_alarm(payload)
    deferral = _deferral(payload)

    if cls == INTERNAL:
        # THE MINIMAL INTERNAL ENVELOPE, per the ruling. Header line so Michael
        # knows which build and which plumbing without opening anything; the
        # pointer so he can open it when he needs to. Nothing else travels.
        lines = [_clip(_first_line(payload) or f"(foreman internal wake — build {build_id})",
                       MAX_APPENDED_LINE_CHARS)]
        lines.append(f"build {build_id} · caller {caller or '?'} · axis {axis}")
        lines += [_clip(x, MAX_APPENDED_LINE_CHARS) for x in alarms + deferral]
        lines.append(pointer)
        # The same ceiling governs the internal envelope. This is the
        # high-frequency class; an unbounded alarm here is the loudest version
        # of the defect, not an exempt one.
        return _assemble_body(lines, pointer)

    # Facts are offered whole, in order, after the standing per-line cap.
    # There is no upstream aggregate fact budget and therefore no second answer
    # to "what is worth saying?" The final Law-A byte limiter below sees the
    # envelope, facts, excerpt, alarms, provenance and pointer together; it is
    # the only stage allowed to stop admitting facts.
    if facts is None:
        facts = _facts(payload)
    lines = [_clip(ln, MAX_APPENDED_LINE_BYTES) for ln in facts]

    if cls in (CHECKIN, DECISION):
        # DECISION joins CHECK-IN here: an executor report is the reason it
        # exists, and thinning it to bare facts would hide the evidence behind
        # the ask.
        report = executor_report(payload)
        # Reuse the exact stale-pointer predicate used by `_facts`. A quoted
        # pointer from an earlier wake is not executor substance and must not sit
        # beside the current ledger pointer.
        report = "\n".join(
            ln for ln in report.split("\n")
            if not _is_stale_pointer_line(ln)
        )
        if report:
            excerpt = report[-MAX_EXCERPT_CHARS:]
            if len(report) > MAX_EXCERPT_CHARS:
                excerpt = "…" + excerpt
            lines.append(_clip(
                f"Executor report — last {len(excerpt)} of {len(report)} chars, "
                "excerpt not transcript:",
                MAX_APPENDED_LINE_BYTES,
            ))
            lines.append(_clip(excerpt, MAX_APPENDED_LINE_BYTES))

    for extra in alarms + deferral:
        if extra not in lines:
            lines.append(_clip(extra, MAX_APPENDED_LINE_CHARS))
    lines += [_clip(p, MAX_APPENDED_LINE_CHARS) for p in _provenance(payload)]
    lines.append(pointer)
    return _assemble_body(lines, pointer)


#: A single appended line — a gate alarm, a deferral note, a provenance line —
#: cannot be longer than this. Budgeting only the FACTS let an appended
#: 4,000-character alarm push a visible body far past its stated ceiling. An
#: alarm that long is a report pasted into a notice, and its full text is in
#: the ledger like everything else.
MAX_APPENDED_LINE_BYTES = 300
#: LAW A — the ceiling on the EXACT DELIVERED BYTES: envelope, separator and
#: body together, measured in UTF-8 as the hook posts them. A bound that counts
#: CODE POINTS and excludes the envelope lets multi-byte text cross the gateway
#: well over it; the stated ceiling must be the quantity being enforced.
#:
#: This binds SUCCESSFULLY FORMATTED, non-ORDINARY output only. LAW B — ORDINARY
#: passthrough and hook fail-open are NAMED EXEMPTIONS, not oversights: a ceiling
#: that clips a fail-open is the exact silencing this whole design exists to
#: prevent. Two separate laws, tested separately.
MAX_DELIVERED_BYTES = 2499

#: Back-compat alias. New code uses the byte-named constant; the final Law-A
#: limit is the only aggregate delivery bound.
MAX_APPENDED_LINE_CHARS = MAX_APPENDED_LINE_BYTES

#: The clip marker, measured once. It is appended to a clipped line, so the
#: budget for the surviving text is the limit MINUS these bytes.
_ELLIPSIS = "…"
_ELLIPSIS_BYTES = len(_ELLIPSIS.encode("utf-8"))
BODY_CLIPPED_NOTICE = "… body clipped; the full wake is in the ledger below."


def _byte_trunc(text: str, limit: int) -> str:
    """Longest prefix of `text` fitting `limit` UTF-8 bytes, on a CHARACTER boundary.

    Never splits a character: slicing encoded bytes and decoding the fragment is
    how a clipper emits a partial code point, and `errors='ignore'` would hide it
    rather than prevent it. Walking code points and accumulating their encoded
    widths cannot produce a broken sequence by construction.
    """
    if limit <= 0:
        return ""
    out, used = [], 0
    for ch in text:
        w = len(ch.encode("utf-8"))
        if used + w > limit:
            break
        out.append(ch)
        used += w
    return "".join(out)


def _clip(text: str, limit: int) -> str:
    """Clip one line to `limit` UTF-8 BYTES, marker included in the budget."""
    if len(text.encode("utf-8")) <= limit:
        return text
    return _byte_trunc(text, limit - _ELLIPSIS_BYTES).rstrip() + _ELLIPSIS


_MIDDLE_ELISION = " … [middle elided; not a path] … "


def _byte_suffix(text: str, limit: int) -> str:
    """Longest suffix fitting `limit` UTF-8 bytes, on a character boundary."""
    if limit <= 0:
        return ""
    out, used = [], 0
    for ch in reversed(text):
        width = len(ch.encode("utf-8"))
        if used + width > limit:
            break
        out.append(ch)
        used += width
    return "".join(reversed(out))


def _middle_elide_pointer(pointer: str, limit: int) -> str:
    """Present both ends of an overlong pointer without emitting a locator.

    Head clipping could name a real, different file when its surviving
    prefix happened to collide. This representation keeps the stable root and
    ledger filename while placing an explicit non-locator marker in the middle;
    unlike a clipped prefix, it cannot be mistaken for the complete path.
    """
    if len(pointer.encode("utf-8")) <= limit:
        return pointer
    marker_bytes = len(_MIDDLE_ELISION.encode("utf-8"))
    if marker_bytes >= limit:
        raise ValueError("pointer presentation limit cannot hold elision marker")
    remaining = limit - marker_bytes
    head_budget = remaining // 2
    tail_budget = remaining - head_budget
    return (
        _byte_trunc(pointer, head_budget).rstrip()
        + _MIDDLE_ELISION
        + _byte_suffix(pointer, tail_budget).lstrip()
    )


def _assemble_body(lines: list, pointer: str) -> str:
    """ASSEMBLE ONLY. This function does not drop bytes and must never learn to.

    It once enforced a SECOND ceiling with an all-or-break loop and no per-line
    clip, ahead of the real limiter. A long first line broke the loop on its
    first iteration and every later line vanished: kilobytes of content arrived
    as a body of one ellipsis under a PROGRESS envelope — loss presenting as
    concision. Two limiters that must agree is how that defect existed; teaching
    them to agree leaves the next author to re-break the agreement silently. So
    there is exactly ONE place where bytes are ever dropped —
    `enforce_delivered_bound`, on the assembled envelope+separator+body,
    per-line clipped, pointer last.
    """
    return "\n".join(lines)


def enforce_delivered_bound(envelope: str, body: str, pointer: str) -> str:
    """LAW A. Return the delivered string, at most MAX_DELIVERED_BYTES UTF-8 bytes.

    Called on the ASSEMBLED value — envelope, blank-line separator and body — so
    the quantity enforced is the quantity delivered. The caller applies this to
    non-ORDINARY successful formatting only; Law B's exemptions never reach here.

    The envelope is never clipped: it is the binding instruction that tells the
    supervisor what form the owner's reply must take, and a half-envelope is worse than a long
    message. If the envelope alone cannot leave room for a body this RAISES, so
    the hook fails open to the original bytes — an envelope delivered with its
    facts amputated would be a silent, well-formatted lie.
    """
    def assemble(b):
        return (envelope + "\n\n" + b) if envelope else b

    # The ledger pointer is an appended presentation line and obeys the
    # same per-line cap as every other appended line.  Do this inside the final
    # byte limiter, even when the total already fits, so a pathological log
    # directory spends its own presentation rather than an unrelated fact's
    # shaping budget.  The complete path remains in the ledger record's
    # `ledger_path` field; this is only the on-wire presentation.
    display_pointer = _middle_elide_pointer(pointer, MAX_APPENDED_LINE_BYTES)
    body = "\n".join(
        display_pointer if line == pointer else line
        for line in body.split("\n")
    )

    delivered = assemble(body)
    if len(delivered.encode("utf-8")) <= MAX_DELIVERED_BYTES:
        return delivered

    overhead = len(assemble("").encode("utf-8"))
    notice = BODY_CLIPPED_NOTICE
    floor = len(display_pointer.encode("utf-8")) + len(notice.encode("utf-8")) + 2
    if overhead + floor > MAX_DELIVERED_BYTES:
        raise ValueError(
            f"envelope of {overhead} B leaves no room for a body under "
            f"{MAX_DELIVERED_BYTES} B; refusing to deliver an amputated message"
        )

    budget = MAX_DELIVERED_BYTES - overhead
    # Re-apply the per-line presentation cap here because this function is a
    # public test seam and must be safe even when called with an unshaped body.
    # In the CLI path these lines are already capped, so this is idempotent.
    lines = [
        _clip(ln, MAX_APPENDED_LINE_BYTES)
        for ln in body.split("\n")
        if ln != display_pointer
    ]
    keep, used = [], 0
    for ln in lines:
        sep = 1 if keep else 0
        room = budget - floor - used - sep
        # Every upstream line is already capped. Admit a complete presented
        # line or stop; a fact clipped here would be counted as delivered while
        # its assertion was incomplete. Any remaining headroom is therefore
        # strictly smaller than the next offered line plus its separator.
        line_bytes = len(ln.encode("utf-8"))
        if room < line_bytes:
            break
        used += line_bytes + sep
        keep.append(ln)
    keep.append(notice)
    keep.append(display_pointer)        # LAST LINE STANDING; self-clipped only
    return assemble("\n".join(keep))


def _fact_delivery_stats(offered_facts: list, body: str) -> tuple:
    """Count offered facts and their complete, ordered on-wire representations."""
    offered = [_clip(ln, MAX_APPENDED_LINE_BYTES) for ln in offered_facts]
    wire_lines = body.split("\n")
    delivered = 0
    cursor = 0
    for fact in offered:
        try:
            cursor = wire_lines.index(fact, cursor) + 1
        except ValueError:
            break
        delivered += 1
    return len(offered), delivered


# ── ledger ────────────────────────────────────────────────────────────────────

def log_dir() -> str:
    explicit = os.environ.get("FM_BRIEF_LOG_DIR", "").strip()
    if explicit:
        return explicit
    ahi_home = os.environ.get("FM_AHI_HOME") or os.environ.get("AHI_HOME") or os.path.expanduser("~/ahi")
    root = os.environ.get("FOREMAN_ROOT") or os.path.join(ahi_home, "foreman")
    return os.path.join(root, "briefings")


def ledger_path_for(build_id: str) -> str:
    """Where this build's ledger lives. Resolved BEFORE rendering, because the
    rendered body must name it — the pointer is the whole reason thinning is
    not deletion."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", build_id) or "unattributed"
    return os.path.join(log_dir(), safe + ".jsonl")


def append_ledger(record: dict) -> str:
    """Append one JSON line. Raises on any failure — law 2 then triggers law 1."""
    d = log_dir()
    os.makedirs(d, exist_ok=True)
    path = ledger_path_for(record["build_id"])
    line = json.dumps(record, ensure_ascii=False, sort_keys=False)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return path


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


# ══════════════════════════════════════════════════════════════════════════════
# PRESENTATION LAYER — the three binding owner-facing formats
#
# `render_presentation` produces them and `validate_presentation` accepts
# exactly them. A gateway that re-implements these formats should be tested
# against the same bytes, rail for rail.
#
# Scope discipline: this layer binds ONLY the three declared formats. An ordinary
# message never reaches it, is never bulleted, never bolded and never capped.
# Nothing here changes origin, routing, threading or authorship.
# ══════════════════════════════════════════════════════════════════════════════

P_CHECKIN = "checkin"
P_PROGRESS = "progress"
P_DECISION = "decision"
P_FORMATS = (P_CHECKIN, P_PROGRESS, P_DECISION)

#: §1 headers, byte-exact including the em dash. DECISION takes `— <category>`.
P_HEADER_TEXT = {
    P_CHECKIN: "FOREMAN CHECK-IN — no reply needed",
    P_PROGRESS: "BUILD PROGRESS — no reply needed",
}
P_DECISION_HEADER_PREFIX = "DECISION REQUIRED — "

#: §2(4) field order is fixed and complete. Labels carry NO colon here; the
#: renderer puts the colon INSIDE the bold span — `- **Finished:** text`.
P_FIELDS = {
    P_CHECKIN: (
        "Executor finished",
        "Executor stopped at",
        "Michael needs to inspect",
        "Next expected action",
    ),
    P_PROGRESS: ("Finished", "Now", "Michael's steer", "Acceptance"),
    P_DECISION: (
        "Why this stopped",
        "My recommendation",
        "Why you might choose differently",
    ),
}

#: §2 field-name correction. The old spelling is accepted on INBOUND PARSING
#: ONLY and is never emitted — `render_presentation` writes the canonical name
#: and `validate_presentation` rejects the legacy one outright.
P_LEGACY_INBOUND_LABELS = {"Why you might not": "Why you might choose differently"}

#: §4 caps, in VISIBLE characters. Visible = markdown markers removed. A field's
#: visible length is measured as `Label: value` — the text the owner actually reads,
#: without the bullet marker or the bold asterisks. Over-cap is REJECTION.
P_CAP_FIELD_DEFAULT = 200
P_CAP_FIELD = {
    "Why this stopped": 400,
    "My recommendation": 200,
    "Why you might choose differently": 200,
}
P_CAP_QUESTION = 120
P_CAP_TOTAL = 900

#: §2(8) sentence budget per field: exactly one, except `Why this stopped:`.
P_SENTENCES = {"Why this stopped": (1, 3)}
P_SENTENCES_DEFAULT = (1, 1)

#: §5 the only thing the owner ever sees when rendering fails. Single line, no
#: markdown, names nothing about the failure but that detail was retained.
SAFE_FALLBACK = (
    "A build message came in that I could not render cleanly. "
    "I have kept the full detail and will summarise it myself."
)

P_BULLET_RE = re.compile(r"^- \*\*([^*]+):\*\* (\S.*)$")
P_HEADER_RE = re.compile(r"^\*\*(.+)\*\*$")
P_EXACT_HEADER_RE = {
    P_CHECKIN: re.compile(r"^\*\*FOREMAN CHECK\-IN — no reply needed\*\*$"),
    P_PROGRESS: re.compile(r"^\*\*BUILD PROGRESS — no reply needed\*\*$"),
}
P_EXACT_DECISION_HEADER_RE = re.compile(
    r"^\*\*DECISION REQUIRED — ([^:*\n]+)\*\*$"
)
P_SENTENCE_END_RE = re.compile(r"[.!?](?=\s|$)")


class PresentationError(Exception):
    """Raised by `render_presentation` when its own output fails the rails.

    Carries the violation list for the internal log ONLY. §5(1): the violation
    list is never surfaced.
    """

    def __init__(self, violations):
        self.violations = list(violations)
        super().__init__("; ".join(self.violations) or "presentation rejected")


# ── §3 content-exclusion rails ────────────────────────────────────────────────
# Applied to FIELD VALUES and the DECISION QUESTION only — never to the header,
# which is fixed normative text the rails would otherwise reject on its own caps
# and casing. Each rail is a named id so a negative fixture can assert exactly
# which rail fired, and so the gateway port can be proven rail-for-rail equal.
#
# These were checked against the golden bytes before being committed: no rail
# No rail may fire on normative text. Words such as "format" and "renders"
# occur in valid messages and are therefore NOT bannable — only the specific
# technical constructions are.

P_CONTENT_RAILS = (
    ("path-absolute",
     re.compile(r"(?:^|[\s(\[\"'])~?/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]*)+"),
     "filesystem path"),
    ("path-relative",
     re.compile(r"(?<![A-Za-z0-9._-])(?!(?:and|or)/(?:and|or)\b)"
                r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+"
                r"(?:/[A-Za-z0-9._-]+)*", re.IGNORECASE),
     "relative filesystem path"),
    ("filename-extension",
     re.compile(r"\b[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,15}\b"),
     "bare filename with an extension"),
    ("timestamp-date",
     re.compile(r"\b\d{4}-\d{2}-\d{2}\b|\b\d{8}T\d{6}Z?\b"
                r"|\b(?:mon|tue|wed|thu|fri|sat|sun)day\b\s*\d|\bUTC\b",
                re.IGNORECASE),
     "date or ISO timestamp"),
    ("clock-time",
     re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|z)?\b", re.IGNORECASE),
     "clock time"),
    ("duration",
     re.compile(r"\b\d+(?:\.\d+)?\s*(?:s|ms|us|ns|sec|secs|second|seconds|min"
                r"|mins|minute|minutes|h|hr|hrs|hour|hours|day|days|week|weeks)\b",
                re.IGNORECASE),
     "duration or elapsed counter"),
    ("hash-digest",
     re.compile(r"\b[0-9a-f]{7,64}\b", re.IGNORECASE),
     "hash, sha, digest or commit id"),
    ("internal-identifier",
     re.compile(r"\b\d{8}-\d{6}-[A-Za-z0-9-]+\b"
                r"|\b[0-9a-f]{4,}-[0-9a-f]{4,}\b"
                r"|\b(?:FM|F|R|G|S)-\d+\b"
                r"|\bgate[- ]set\b"
                r"|\b(?:item|ticket|gate|issue|job)\s*#?\s*\d+\b"
                r"|\btmux\b"
                r"|\b(?:session|pane|window|socket)\s+[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b",
                re.IGNORECASE),
     "internal gate, build, item, ticket or session identifier"),
    ("internal-agent-name",
     re.compile(r"\b(?:(?i:agent|executor|subagent|foreman)\s+"
                r"(?:(?i:called|named)\s+)?[A-Z][a-z]+"
                r"|Zali|Avi)\b"),
     "internal agent or session persona name"),
    ("marker-token",
     re.compile(r"\b[A-Z][A-Z0-9]+(?:[-_][A-Z0-9]+)+\b"),
     "internal marker or screaming-caps token"),
    ("diagnostics",
     re.compile(r"\b(?:traceback|stack ?trace|exit code|exit status|errno"
                r"|stderr|stdout|segfault|core dump|byte|bytes|kib|mib|gib"
                r"|kb|mb|gb|token|tokens|char|chars|characters|line count"
                r"|loc|warnings?\b\s*:|assertion)\b", re.IGNORECASE),
     "diagnostics, counters or byte/token/line counts"),
    ("technical-evidence",
     re.compile(r"\b[A-Z]{2,8}\s+"
                r"(?:OK|PASS(?:ED)?|FAIL(?:ED)?|ERROR|UP|DOWN|HEALTHY|UNHEALTHY)\b"
                r"|\b(?i:status|health|response)\s*(?:code|=|:)\s*\d{3}\b"),
     "protocol, health or machine-status evidence"),
    ("usage-quota",
     re.compile(r"\b(?:usage|quota|weekly limit|rate ?limit|billing|billed"
                r"|invoice|resets|budget|allowance)\b", re.IGNORECASE),
     "usage, quota, limit or billing line"),
    ("model-tier",
     re.compile(r"\b(?:opus|sonnet|haiku|gpt-?\d|claude|model tier|tier \d)\b",
                re.IGNORECASE),
     "model tier"),
    ("correction-history",
     re.compile(r"\b(?:correct(?:ed|ing|ion)|amend(?:ed|ing|ment)"
                r"|retract(?:ed|ing|ion)|revis(?:e|ed|ing|ion)"
                r"|as I said|as noted earlier|previously I|earlier I|I was wrong"
                r"|to correct|restating|my mistake|prior (?:account|claim|statement|message|report)"
                r"|earlier (?:account|claim|statement|message|report)"
                r"|apologies|apologise|apologize)\b", re.IGNORECASE),
     "correction history"),
    ("process-narration",
     re.compile(r"\b(?:I will now|I am now going to|as instructed above"
                r"|per my instructions|my context|this turn|my previous message"
                r"|I re-?read|my own output|my earlier)\b", re.IGNORECASE),
     "self-referential process narration"),
    ("formatter-instruction",
     re.compile(r"\b(?:formatter|envelope|classifier|validator|ledger"
                r"|briefing contract|golden fixture|fixture|rail)\b",
                re.IGNORECASE),
     "formatter, envelope or wake instruction"),
    ("raw-wake-text",
     re.compile(r"\(foreman wake|\(provenance:|\(FM-\d+:|full payload"
                r"|Executor report\s+—|wake payload|foreman wake|went idle",
                re.IGNORECASE),
     "raw wake text"),
    ("command-or-flag",
     re.compile(r"(?:^|\s)--?[A-Za-z][\w-]*\b"
                r"|\b(?:npm|npx|tsc|git|systemctl|journalctl|crontab|sudo|chmod"
                r"|chown|grep|sed|awk|curl|wget|bash|python3?|node|pip|pkill"
                r"|kill|mkdir|rmdir)\b(?![\w-])"),
     "command, flag or shell invocation"),
    ("env-var",
     re.compile(r"\$[A-Za-z_]\w*|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[A-Z]{2,}=\S"),
     "environment variable"),
    ("code-literal",
     re.compile(r"`|</?[A-Za-z][^>]*>|\{\{|\b[a-z_][\w]*\(\)|::|=>|\{\}"
                r"|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b"),
     "code, markup, snake_case identifier or technical literal"),
)

#: §3: "Verified counts are permitted only in `Acceptance:`, and only as a plain
#: count." Enforced as its own rail so a negative fixture can name it.
P_COUNT_FIELD = "Acceptance"
P_DIGIT_RE = re.compile(r"\d")
P_PLAIN_COUNT_RE = re.compile(r"\d+\s*(?:%|/)|\b\d+\s*(?:x|×)\b")


def content_rail_hits(text: str, *, field: str = "") -> list:
    """Return the ids of every §3 rail this text trips. Empty == clean."""
    hits = []
    for rail_id, rx, _note in P_CONTENT_RAILS:
        if rx.search(text):
            hits.append(rail_id)
    if P_DIGIT_RE.search(text):
        if field != P_COUNT_FIELD:
            hits.append("count-outside-acceptance")
        elif P_PLAIN_COUNT_RE.search(text):
            hits.append("count-not-plain")
    return hits


# ── visible length (§4) ───────────────────────────────────────────────────────

def visible_text(s: str) -> str:
    """Strip the markdown markers this layer emits. Nothing else is touched."""
    return s.replace("**", "")


def visible_field_len(label: str, value: str) -> int:
    """`Label: value` — Unicode code points, never bytes/code units."""
    return len(f"{label}: {value}")


def visible_message(msg: str) -> str:
    """The whole message with bold markers and bullet markers removed."""
    out = []
    for ln in msg.replace("\r\n", "\n").rstrip("\n").split("\n"):
        v = visible_text(ln)
        if v.startswith("- "):
            v = v[2:]
        out.append(v)
    return "\n".join(out)


def visible_message_len(msg: str) -> int:
    # Python len(str) is the binding Unicode-code-point count.
    return len(visible_message(msg))


def sentence_count(value: str) -> int:
    return len(P_SENTENCE_END_RE.findall(value))


# ── render (§1, §2) ───────────────────────────────────────────────────────────

def render_presentation(fmt: str, fields: dict, *, category: str = "",
                        question: str = "") -> str:
    """Render one of the three binding formats, then validate the bytes.

    Returns the exact bytes that go on the surface, with a single trailing
    newline — matching the golden fixtures. Raises PresentationError if its own
    output fails any rail: an unrenderable message is never surfaced malformed.
    """
    if fmt not in P_FORMATS:
        raise PresentationError([f"unknown format {fmt!r}"])

    labels = P_FIELDS[fmt]
    missing = [lb for lb in labels if not str(fields.get(lb, "")).strip()]
    if missing:
        raise PresentationError([f"missing field {lb!r}" for lb in missing])

    if fmt == P_DECISION:
        cat = (category or "").strip()
        if cat not in CATEGORIES:
            raise PresentationError(
                [f"category {cat!r} outside closed set {'|'.join(CATEGORIES)}"]
            )
        header = P_DECISION_HEADER_PREFIX + cat
    else:
        header = P_HEADER_TEXT[fmt]

    lines = [f"**{header}**", ""]
    for lb in labels:
        lines.append(f"- **{lb}:** {str(fields[lb]).strip()}")

    if fmt == P_DECISION:
        q = (question or "").strip()
        if not q:
            raise PresentationError(["DECISION carries no question"])
        lines += ["", q]

    msg = "\n".join(lines) + "\n"
    bad = validate_presentation(msg, fmt)
    if bad:
        raise PresentationError(bad)
    return msg


# ── validate (§2, §3, §4) ─────────────────────────────────────────────────────

def detect_presentation_format(msg: str):
    """Which of the three formats this message declares itself to be, or None."""
    first = ""
    for ln in msg.replace("\r\n", "\n").split("\n"):
        if ln.strip():
            first = ln
            break
    if P_EXACT_HEADER_RE[P_CHECKIN].fullmatch(first):
        return P_CHECKIN
    if P_EXACT_HEADER_RE[P_PROGRESS].fullmatch(first):
        return P_PROGRESS
    if P_EXACT_DECISION_HEADER_RE.fullmatch(first):
        return P_DECISION
    return None


def is_presentation_form(msg: str) -> bool:
    """True when the message is written in the §1 bold-bullet presentation form.

    Used so the legacy plain-text validators keep working on legacy input while
    the presentation rails bind everything emitted from now on.
    """
    for ln in msg.replace("\r\n", "\n").split("\n"):
        if ln.strip():
            return ln.strip().startswith("**")
    return False


def validate_presentation(msg: str, fmt=None) -> list:
    """Return the list of violations. Empty list == ACCEPTED.

    Enforces spec §2 structure, §3 content exclusions and §4 length caps. The
    violation list is diagnostic only: §5(1) forbids surfacing it.
    """
    bad = []
    if not isinstance(msg, str) or not msg.strip():
        return ["empty message"]

    text = msg.replace("\r\n", "\n")
    if not text.endswith("\n"):
        bad.append("message must end with exactly one newline")
        body = text
    else:
        body = text[:-1]
        if body.endswith("\n"):
            bad.append("message must end with exactly one newline")
            body = body.rstrip("\n")

    lines = body.split("\n")
    if lines and lines[0] != lines[0].strip():
        bad.append("nothing may precede the header")          # §2(9)
    if lines and lines[0].strip() == "":
        bad.append("nothing may precede the header")          # §2(9)
    if lines and lines[-1].strip() == "":
        bad.append("nothing may follow the last field")       # §2(9)
    for i, ln in enumerate(lines):
        if ln != ln.rstrip():
            bad.append(f"line {i + 1} carries trailing whitespace")

    detected = detect_presentation_format(body)
    if fmt is None:
        fmt = detected
    if fmt not in P_FORMATS:
        return bad + ["message is not one of the three binding formats"]
    if detected is not None and detected != fmt:
        bad.append(f"header declares {detected!r} but {fmt!r} was expected")

    labels = P_FIELDS[fmt]

    # §2(1) header is bold, on its own line, byte-exact including the em dash.
    header_line = lines[0] if lines else ""
    m = P_HEADER_RE.match(header_line)
    if not m:
        bad.append("header must be bold on its own line: '**…**'")
        inner = header_line
    else:
        inner = m.group(1)
    if fmt == P_DECISION:
        if not inner.startswith(P_DECISION_HEADER_PREFIX):
            bad.append(f"header must be '**{P_DECISION_HEADER_PREFIX}<category>**'")
        else:
            cat = inner[len(P_DECISION_HEADER_PREFIX):]
            if cat not in CATEGORIES:
                bad.append(
                    f"category {cat!r} outside closed set {'|'.join(CATEGORIES)}"
                )
    else:
        want = P_HEADER_TEXT[fmt]
        if inner != want:
            bad.append(f"header must be exactly {want!r}, found {inner!r}")
        # §2(5) CHECK-IN and PROGRESS carry no category, ever.
        if inner.startswith(want.split(" — ")[0]) and inner != want:
            bad.append("this format carries no category; category belongs to "
                       "DECISION alone")

    # §2(2) exactly one blank line after the header, and for DECISION exactly
    # one blank line before the question. §2(9) nothing else anywhere.
    expect_len = 2 + len(labels) + (2 if fmt == P_DECISION else 0)
    if len(lines) != expect_len:
        bad.append(f"expected exactly {expect_len} lines, found {len(lines)}")
    if len(lines) > 1 and lines[1] != "":
        bad.append("exactly one blank line must follow the header")

    # §2(3)(4) bullets, bold label, colon inside the bold span, fixed order.
    values = {}
    for i, lb in enumerate(labels):
        idx = 2 + i
        if idx >= len(lines):
            bad.append(f"missing field {lb!r}")
            continue
        ln = lines[idx]
        bm = P_BULLET_RE.match(ln)
        if not bm:
            legacy = [k for k in P_LEGACY_INBOUND_LABELS
                      if f"**{k}:**" in ln or ln.startswith(f"- {k}:")]
            if legacy:
                bad.append(
                    f"field {legacy[0]!r} is the legacy inbound spelling; the "
                    f"binding name is {P_LEGACY_INBOUND_LABELS[legacy[0]]!r}"
                )
            else:
                bad.append(
                    f"field {i + 1} must read '- **{lb}:** <text>', "
                    f"found {ln[:48]!r}"
                )
            continue
        got, value = bm.group(1), bm.group(2)
        if got in P_LEGACY_INBOUND_LABELS:
            bad.append(
                f"field {got!r} is the legacy inbound spelling; the binding "
                f"name is {P_LEGACY_INBOUND_LABELS[got]!r}"
            )
            continue
        if got != lb:
            bad.append(f"field {i + 1} must be {lb!r}, found {got!r}")
            continue
        values[lb] = value

    question = ""
    if fmt == P_DECISION and len(lines) == expect_len:
        if lines[-2] != "":
            bad.append("exactly one blank line must precede the question")
        question = lines[-1]
        if question != question.strip() or not question.strip():
            bad.append("the question must be a single plain line")

    # §2(6)(7) the '?' rails.
    n_q = body.count("?")
    if fmt == P_DECISION:
        if n_q != 1:
            bad.append(f"DECISION must contain exactly one '?', found {n_q}")
        elif not lines[-1].endswith("?"):
            bad.append("the single '?' must terminate the final line")
        for lb, v in values.items():
            if "?" in v:
                bad.append(f"field {lb!r} asks a question; the question is its "
                           "own final line")
    elif n_q:
        bad.append(f"{fmt} must contain zero '?' characters, found {n_q}")

    # §2(8) sentence budget, §4 caps, §3 content rails.
    for lb in labels:
        v = values.get(lb)
        if v is None:
            continue
        lo, hi = P_SENTENCES.get(lb, P_SENTENCES_DEFAULT)
        n_s = sentence_count(v)
        if n_s < lo or n_s > hi:
            want = f"{lo}" if lo == hi else f"{lo} to {hi}"
            bad.append(f"field {lb!r} must be {want} sentence(s), found {n_s}")
        if not v.endswith((".", "!")):
            bad.append(f"field {lb!r} must end in a full stop")
        cap = P_CAP_FIELD.get(lb, P_CAP_FIELD_DEFAULT)
        # "character" means Unicode code point at every cap site.
        n_v = visible_field_len(lb, v)
        if n_v > cap:
            bad.append(f"field {lb!r} is {n_v} visible chars, cap is {cap}")
        for rail in content_rail_hits(v, field=lb):
            bad.append(f"field {lb!r} trips content rail {rail}")

    if fmt == P_DECISION and question:
        # Python len(str) counts Unicode code points.
        if len(question) > P_CAP_QUESTION:
            bad.append(f"question is {len(question)} visible chars, cap is "
                       f"{P_CAP_QUESTION}")
        for rail in content_rail_hits(question):
            bad.append(f"question trips content rail {rail}")

    # total-visible-message cap is the same code-point definition.
    total = visible_message_len(text)
    if total > P_CAP_TOTAL:
        bad.append(f"total visible message is {total} chars, cap is {P_CAP_TOTAL}")

    # de-duplicate while preserving order; §2(9) can fire twice by construction
    seen = set()
    uniq = []
    for b in bad:
        if b not in seen:
            seen.add(b)
            uniq.append(b)
    return uniq


# ── §5 failure behaviour ──────────────────────────────────────────────────────

def presentation_log_path() -> str:
    """Where the complete failure record goes. Never the surface."""
    return os.path.join(log_dir(), "brief-presentation.jsonl")


def append_presentation_log(record: dict) -> str:
    """Append one complete JSON record, fsync'd. §5(3)(4): the record is never
    dropped, and a logging failure must not crash the caller either."""
    d = log_dir()
    os.makedirs(d, exist_ok=True)
    path = presentation_log_path()
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return path


def presentation_emergency_log_path() -> str:
    """Independent durable fallback for a failed primary presentation sink."""
    return os.environ.get(
        "FM_BRIEF_PRESENTATION_EMERGENCY_LOG",
        "/var/tmp/fm-brief-presentation-emergency.jsonl",
    )


def append_presentation_emergency_log(record: dict) -> str:
    path = presentation_emergency_log_path()
    d = os.path.dirname(path) or "."
    os.makedirs(d, mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        with os.fdopen(fd, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    return path


def _retain_presentation_failure(record: dict, sink=None, emergency_sink=None) -> None:
    """Try the primary, then a separately implemented durable sink."""
    try:
        (sink or append_presentation_log)(record)
        return
    except Exception:  # noqa: BLE001 — secondary path is the required response
        pass
    try:
        (emergency_sink or append_presentation_emergency_log)(record)
    except Exception:  # noqa: BLE001 — §5(4): never crash the caller
        pass


def safe_present(fmt: str, fields: dict, *, category: str = "", question: str = "",
                 raw: str = "", build_id: str = "", sink=None,
                 emergency_sink=None) -> str:
    """Render, or return the §5 safe fallback. NEVER raises, never leaks.

    On failure the complete record — original payload, detected format, every
    violation — is written to the internal log, and the owner sees one plain line
    that names only that a message could not be rendered and detail was kept.
    """
    try:
        return render_presentation(fmt, fields, category=category, question=question)
    except Exception as exc:  # noqa: BLE001 — §5(4): never crash the caller
        violations = getattr(exc, "violations", None) or [
            f"{type(exc).__name__}: {exc}"
        ]
        record = {
            "ts": now_iso(),
            "build_id": build_id or "unattributed",
            "event": "brief-presentation-rejected",
            "format_declared": fmt,
            "format_detected": detect_presentation_format(raw) if raw else None,
            "fields": {k: str(v) for k, v in (fields or {}).items()},
            "category": category,
            "question": question,
            "raw": raw,
            "violations": violations,
            "tool": VERSION,
        }
        _retain_presentation_failure(record, sink, emergency_sink)
        return SAFE_FALLBACK


def safe_validate(msg: str, fmt=None, *, build_id: str = "", sink=None,
                  emergency_sink=None):
    """Gate an already-rendered message. Returns (text, violations).

    Accepted → the message unchanged. Rejected → the §5 fallback, with the
    complete record logged. Used by whatever finally hands bytes to the surface.
    """
    detected = detect_presentation_format(msg)
    # Only detected presentation-format messages are normalised; ordinary text is never
    # touched. Accepted presentation bytes are LF-normative.
    candidate = msg.replace("\r\n", "\n") if detected is not None else msg
    try:
        bad = validate_presentation(candidate, fmt)
    except Exception as exc:  # noqa: BLE001
        bad = [f"{type(exc).__name__}: {exc}"]
    if not bad:
        return candidate, []
    record = {
        "ts": now_iso(),
        "build_id": build_id or "unattributed",
        "event": "brief-presentation-rejected",
        "format_declared": fmt,
        "format_detected": detected,
        "raw": msg,
        "violations": bad,
        "tool": VERSION,
    }
    _retain_presentation_failure(record, sink, emergency_sink)
    return SAFE_FALLBACK, bad


# ── inbound ───────────────────────────────────────────────────────────────────
# Everything in an inbound wake that is not plain English is stripped before the
# owner sees anything. Line-level noise goes first, then SENTENCE-level
# filtering: a sentence that trips any content rail is withheld whole.
# Withholding is not destruction — the raw payload is already in the ledger.

P_INBOUND_NOISE_LINE_RE = re.compile(
    r"^\s*(?:\(foreman wake\b"
    r"|\(provenance:"
    r"|\(FM-\d+:"
    r"|\([^\n]*\bwake was DEFERRED\b"
    r"|full payload:"
    r"|Executor report\s+—"
    r"|The \S+ build session"
    r"|You'?ve used \d"
    r"|#FMBRIEF"
    r"|\[BRIEF )",
    re.IGNORECASE,
)

P_INBOUND_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def parse_inbound(msg: str):
    """Parse an inbound message in either the presentation or the legacy plain
    form, tolerating the legacy `Why you might not:` spelling.

    Returns (fmt, category, fields, question). `fields` keys are the CANONICAL
    labels — the legacy spelling is normalised here and never emitted again.
    """
    fmt = detect_presentation_format(msg)
    category = ""
    fields = {}
    question = ""
    lines = [ln.rstrip() for ln in msg.replace("\r\n", "\n").split("\n")]
    nonblank = [ln for ln in lines if ln.strip()]
    # Legacy plain headers remain parseable inbound without weakening the
    # exact-bold wire detector.
    if fmt is None and nonblank:
        plain_head = nonblank[0].strip()
        if plain_head == P_HEADER_TEXT[P_CHECKIN]:
            fmt = P_CHECKIN
        elif plain_head == P_HEADER_TEXT[P_PROGRESS]:
            fmt = P_PROGRESS
        elif re.fullmatch(r"DECISION REQUIRED — [^:*\n]+", plain_head):
            fmt = P_DECISION
    if nonblank:
        head = nonblank[0].strip()
        hm = P_HEADER_RE.match(head)
        inner = hm.group(1).strip() if hm else head
        if inner.startswith(P_DECISION_HEADER_PREFIX):
            category = inner[len(P_DECISION_HEADER_PREFIX):].strip()
    known = list(P_FIELDS.get(fmt, ())) + list(P_LEGACY_INBOUND_LABELS)
    for ln in nonblank[1:]:
        s = ln.strip()
        bm = P_BULLET_RE.match(s)
        if bm:
            label, value = bm.group(1), bm.group(2)
        else:
            s2 = s[2:].strip() if s.startswith("- ") else s
            s2 = visible_text(s2)
            hit = next((k for k in known if s2.startswith(k + ":")), None)
            if hit is None:
                if s.endswith("?"):
                    question = s
                continue
            label, value = hit, s2[len(hit) + 1:].strip()
        label = P_LEGACY_INBOUND_LABELS.get(label, label)
        fields[label] = value
    if not question:
        for ln in reversed(nonblank):
            if ln.strip().endswith("?"):
                question = ln.strip()
                break
    return fmt, category, fields, question


def strip_inbound(raw: str) -> str:
    """Reduce a raw wake payload to clean plain English, or "" if none survives.

    Drops wake chrome line by line, then withholds any sentence that trips a §3
    rail. The result is guaranteed to carry zero rail hits — the test asserts it
    rather than trusting it.
    """
    # The fenced executor report is NOT removed: the surviving prose lives
    # inside it. Only the chrome around and inside it goes.
    text = strip_pane_chrome(raw)
    text = GATE_STANDARD_RE.sub("", text)
    kept = []
    depth = 0          # a noise parenthetical may wrap onto following lines
    for ln in text.replace("\r\n", "\n").split("\n"):
        s = ln.strip()
        if not s:
            continue
        if depth > 0:
            depth += s.count("(") - s.count(")")
            continue
        if P_INBOUND_NOISE_LINE_RE.match(s):
            if s.startswith("("):
                depth = max(0, s.count("(") - s.count(")"))
            continue
        kept.append(s)
    paragraph = " ".join(kept)
    paragraph = re.sub(r"\s+", " ", paragraph).strip()
    if not paragraph:
        return ""
    out = []
    for sent in P_INBOUND_SENTENCE_SPLIT_RE.split(paragraph):
        s = sent.strip()
        if not s:
            continue
        if s.startswith(("…", "...")):
            continue                     # a truncated fragment is not English
        if not s.endswith((".", "!")):
            continue                     # no terminator: a fragment, not prose
        if content_rail_hits(s):
            continue                     # withheld, not destroyed: it is logged
        out.append(s)
    return " ".join(out)


# ── format validation (§3 rails) ──────────────────────────────────────────────

PROGRESS_HEADER = "BUILD PROGRESS — no reply needed"
PROGRESS_FIELDS = ("Finished:", "Now:", "Michael's steer:", "Acceptance:")

CHECKIN_HEADER = "FOREMAN CHECK-IN — no reply needed"
CHECKIN_FIELDS = (
    "Executor finished:",
    "Executor stopped at:",
    "Michael needs to inspect:",
    "Next expected action:",
)

DECISION_HEADER_RE = re.compile(r"^DECISION REQUIRED — (\S+)\s*$")
#: The binding counter-case label. The old spelling
#: `Why you might not:` is accepted on INBOUND PARSING ONLY (see
#: DECISION_COUNTER_INBOUND) and is never emitted by any site in this file.
DECISION_COUNTER_FIELD = "Why you might choose differently:"
DECISION_COUNTER_INBOUND = (DECISION_COUNTER_FIELD, "Why you might not:")
DECISION_FIELDS = ("Why this stopped:", "My recommendation:", DECISION_COUNTER_FIELD)

NO_RECOMMENDATION_RE = re.compile(
    r"^\s*(i have no recommendation|none|n/a|no recommendation|tbd|unclear|you decide)\b",
    re.IGNORECASE,
)


def _validate_four_field(msg: str, header: str, fields, label: str):
    """Shared engine for BUILD PROGRESS and FOREMAN CHECK-IN.

    Both are: exact header, blank line, exactly four fields in fixed order,
    nothing else, zero '?' anywhere. Written once so the two rails cannot drift.
    """
    bad = []
    lines = [ln.rstrip() for ln in msg.strip().splitlines()]
    lines = [ln for ln in lines if ln.strip() != ""]
    if not lines or lines[0].strip() != header:
        bad.append(f"header must be exactly {header!r}")
        return bad
    body = lines[1:]
    if len(body) != 4:
        bad.append(f"expected exactly 4 fields, found {len(body)}")
    for i, want in enumerate(fields):
        if i >= len(body):
            bad.append(f"missing field {want!r}")
        elif not body[i].startswith(want):
            bad.append(f"field {i + 1} must start {want!r}, found {body[i][:40]!r}")
        elif not body[i][len(want):].strip():
            bad.append(f"field {want!r} is empty")
    if "?" in msg:
        bad.append(
            f"{label} contains '?' — anti-masquerade rail: a report that asks "
            "anything is a contract violation, not a style nit"
        )
    return bad


def validate_progress(msg: str):
    """Return list of violations. Empty list == ACCEPTED."""
    if is_presentation_form(msg):
        return validate_presentation(msg, P_PROGRESS)
    return _validate_four_field(msg, PROGRESS_HEADER, PROGRESS_FIELDS, "BUILD PROGRESS")


def validate_checkin(msg: str):
    """Return list of violations. Empty list == ACCEPTED.

    §3: four fields, fixed order, zero '?', and NO category — the
    header carries no `— <category>` suffix, because category belongs to
    DECISION alone.
    """
    if is_presentation_form(msg):
        return validate_presentation(msg, P_CHECKIN)
    bad = _validate_four_field(msg, CHECKIN_HEADER, CHECKIN_FIELDS, "FOREMAN CHECK-IN")
    first = msg.strip().splitlines()[0].strip() if msg.strip() else ""
    if first.startswith("FOREMAN CHECK-IN") and first != CHECKIN_HEADER:
        extra = first[len("FOREMAN CHECK-IN"):].strip()
        if extra and extra != "— no reply needed":
            bad.append(
                f"CHECK-IN header carries an extra field {extra!r} — a CHECK-IN "
                "has no category; category belongs to DECISION alone"
            )
    if re.search(r"(?mi)^\s*category\s*:", msg):
        bad.append("CHECK-IN carries a category field; category belongs to DECISION alone")
    return bad


def validate_decision(msg: str):
    """Return list of violations. Empty list == ACCEPTED."""
    if is_presentation_form(msg):
        return validate_presentation(msg, P_DECISION)
    bad = []
    stripped = msg.strip()
    lines = [ln.rstrip() for ln in stripped.splitlines()]
    nonblank = [ln for ln in lines if ln.strip() != ""]
    if not nonblank:
        return ["empty message"]

    m = DECISION_HEADER_RE.match(nonblank[0].strip())
    if not m:
        bad.append("header must be 'DECISION REQUIRED — <category>'")
    elif m.group(1) not in CATEGORIES:
        bad.append(
            f"category {m.group(1)!r} outside closed set {'|'.join(CATEGORIES)}"
        )

    fields = {}
    for want in DECISION_FIELDS:
        # Inbound leniency ONLY: the legacy counter-case spelling is still
        # parsed here so old messages validate, but it is never emitted.
        spellings = DECISION_COUNTER_INBOUND if want == DECISION_COUNTER_FIELD else (want,)
        hit = None
        for spelling in spellings:
            hit = next((ln for ln in nonblank if ln.startswith(spelling)), None)
            if hit is not None:
                fields[want] = hit[len(spelling):].strip()
                break
        if hit is None:
            bad.append(f"missing field {want!r}")

    rec = fields.get("My recommendation:", "")
    if not rec:
        bad.append("recommendation empty — that offloads the thinking the owner is paying for")
    elif NO_RECOMMENDATION_RE.match(rec):
        bad.append(f"recommendation {rec[:40]!r} does not pick one")

    counter = fields.get(DECISION_COUNTER_FIELD, "")
    if not counter:
        bad.append("counter-case empty — a recommendation with no downside is a sales pitch")

    why = fields.get("Why this stopped:", "")
    if not why:
        bad.append("'Why this stopped:' empty")

    n_q = stripped.count("?")
    if n_q != 1:
        bad.append(f"must contain exactly one '?', found {n_q}")
    elif not nonblank[-1].strip().endswith("?"):
        bad.append("the single '?' must end the final line — the direct question")

    return bad


def validate_ordinary(msg: str):
    """§3: ordinary updates carry NO envelope and NO headers."""
    bad = []
    stripped = msg.strip()
    if SENTINEL in stripped:
        bad.append("ordinary update carries the briefing sentinel")
    if "[BRIEF " in stripped:
        bad.append("ordinary update carries a briefing envelope — colonisation")
    bullets = [ln for ln in stripped.splitlines() if re.match(r"^\s*[-*•]\s", ln)]
    if len(bullets) > 5:
        bad.append(f"ordinary update has {len(bullets)} bullets, limit is 5")
    return bad


VALIDATORS = {
    "progress": validate_progress,
    "checkin": validate_checkin,
    "decision": validate_decision,
    "ordinary": validate_ordinary,
}


def detect_format(msg: str) -> str:
    return detect_presentation_format(msg) or "ordinary"


# ── subcommands ───────────────────────────────────────────────────────────────

def _record_fail_open(args, payload: str, exc: Exception) -> None:
    """Record the raw bytes the shell hook will deliver after our failure.

    The production hook treats every non-zero classify exit as fail-open and
    posts the original payload. Therefore a classifier exception is itself a
    delivery decision. Record it before propagating the exception so an
    oversized raw fallback cannot erase its own detector. If the ledger is the
    thing that failed, the caller still gets the raw wake; no process can
    truthfully claim it recorded to storage that rejected the write.
    """
    caller = args.caller or os.environ.get("FM_BRIEF_CALLER", "")
    declared = args.declare or os.environ.get("FM_BRIEF_CLASS", "")
    producer, transport, declaration_source = resolve_declaration(
        args, caller, declared)
    build_id = (
        args.build_id
        or os.environ.get("FM_BRIEF_BUILD_ID", "")
        or extract_build_id(payload)
    )
    raw_bytes = len(payload.encode("utf-8"))
    raw_over_bound = raw_bytes > MAX_DELIVERED_BYTES
    ledger_path = ledger_path_for(build_id)
    record = {
        "ts": now_iso(),
        "build_id": build_id,
        # The formatter did not produce a trustworthy semantic class. ORDINARY
        # is the wire contract the shell now applies; fail_open and axis retain
        # the reason without inventing a semantic label.
        "class": ORDINARY,
        "category": "",
        "raw": payload,
        "rendered": "",
        "canonical": False,
        "wire": payload,
        "body": payload,
        "user_facing_expected": USER_FACING_EXPECTED[ORDINARY],
        "envelope": "",
        "caller": os.path.basename(caller) if caller else "",
        "producer": producer,
        "transport": transport,
        "origin_producer": args.origin_producer,
        "origin_transport": args.origin_transport,
        "declared_kind": bool(transport),
        "declaration_source": declaration_source,
        "axis": f"fail-open:{type(exc).__name__}",
        "fail_open": True,
        "error_type": type(exc).__name__,
        "raw_bytes": raw_bytes,
        "wire_bytes": raw_bytes,
        "body_bytes": raw_bytes,
        "envelope_bytes": 0,
        "facts_offered": 0,
        "facts_delivered": 0,
        "facts_dropped": 0,
        "raw_over_bound": raw_over_bound,
        "delivery_mode": (
            "fail-open-raw-over-bound" if raw_over_bound else "fail-open-raw"
        ),
        "delivery_bound_bytes": MAX_DELIVERED_BYTES,
        "tool": VERSION,
        "ledger_path": ledger_path,
    }
    append_ledger(record)


def _record_undecodable_fail_open(args, payload: bytes, exc: Exception) -> None:
    """Record a reversible byte representation when stdin is not UTF-8.

    Text classification cannot proceed, but the shell still fails open to the
    original bytes it supplied. Base64 is used only because JSON cannot carry
    arbitrary bytes; it is a reversible encoding, not a summary or hash.
    """
    caller = args.caller or os.environ.get("FM_BRIEF_CALLER", "")
    declared = args.declare or os.environ.get("FM_BRIEF_CLASS", "")
    producer, transport, declaration_source = resolve_declaration(
        args, caller, declared)
    build_id = (
        args.build_id
        or os.environ.get("FM_BRIEF_BUILD_ID", "")
        or "unattributed"
    )
    raw_bytes = len(payload)
    raw_over_bound = raw_bytes > MAX_DELIVERED_BYTES
    encoded = base64.b64encode(payload).decode("ascii")
    ledger_path = ledger_path_for(build_id)
    append_ledger({
        "ts": now_iso(),
        "build_id": build_id,
        "class": ORDINARY,
        "category": "",
        "raw": None,
        "raw_encoding": "base64",
        "raw_base64": encoded,
        "rendered": "",
        "canonical": False,
        "wire": None,
        "wire_encoding": "base64",
        "wire_base64": encoded,
        "body": None,
        "user_facing_expected": USER_FACING_EXPECTED[ORDINARY],
        "envelope": "",
        "caller": os.path.basename(caller) if caller else "",
        "producer": producer,
        "transport": transport,
        "origin_producer": args.origin_producer,
        "origin_transport": args.origin_transport,
        "declared_kind": bool(transport),
        "declaration_source": declaration_source,
        "axis": f"fail-open:{type(exc).__name__}",
        "fail_open": True,
        "error_type": type(exc).__name__,
        "raw_bytes": raw_bytes,
        "wire_bytes": raw_bytes,
        "body_bytes": raw_bytes,
        "envelope_bytes": 0,
        "facts_offered": 0,
        "facts_delivered": 0,
        "facts_dropped": 0,
        "raw_over_bound": raw_over_bound,
        "delivery_mode": (
            "fail-open-raw-over-bound" if raw_over_bound else "fail-open-raw"
        ),
        "delivery_bound_bytes": MAX_DELIVERED_BYTES,
        "tool": VERSION,
        "ledger_path": ledger_path,
    })


def cmd_classify(args) -> int:
    # TextIOWrapper.read() performs universal-newline conversion and
    # would silently change ordinary CRLF input before fail-open can preserve
    # it. Read the CLI bytes, then decode without newline translation.
    stdin_buffer = getattr(sys.stdin, "buffer", None)
    if stdin_buffer is None:
        payload = sys.stdin.read()
    else:
        payload_bytes = stdin_buffer.read()
        try:
            payload = payload_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            try:
                _record_undecodable_fail_open(args, payload_bytes, exc)
            except Exception:  # noqa: BLE001 — ledger failure cannot block fail-open
                pass
            raise

    try:
        return _classify_payload(args, payload)
    except Exception as exc:  # noqa: BLE001 — detector must cover all failures
        try:
            _record_fail_open(args, payload, exc)
        except Exception:  # noqa: BLE001 — ledger failure cannot block fail-open
            pass
        raise


def _classify_payload(args, payload: str) -> int:

    caller = args.caller or os.environ.get("FM_BRIEF_CALLER", "")
    declared = args.declare or os.environ.get("FM_BRIEF_CLASS", "")
    arg_category = (args.category or os.environ.get("FM_BRIEF_CATEGORY", "")).strip().lower()
    producer, transport, declaration_source = resolve_declaration(
        args, caller, declared)

    v = classify_payload(
        payload,
        caller=caller,
        declared=declared,
        producer=producer,
        transport=transport,
        origin_producer=args.origin_producer,
        origin_transport=args.origin_transport,
    )
    cls = v.cls

    if cls == DECISION:
        category = v.category or arg_category
        if category not in CATEGORIES:
            # A DECISION with no valid category cannot be rendered per §3.
            # Refuse to guess: inventing one is a fabrication and downgrading to
            # PROGRESS is a silent demotion. So fail, and the hook fails open.
            raise ValueError(
                f"DECISION with category {category!r} outside {'|'.join(CATEGORIES)}"
            )
    else:
        # §3: CHECK-IN carries NO category, and neither does anything
        # else. Category belongs to DECISION alone.
        category = ""

    build_id = args.build_id or os.environ.get("FM_BRIEF_BUILD_ID", "") or extract_build_id(payload)
    # WHETHER AN ENVELOPE TRAVELS follows from what the body actually is:
    #   canonical  — the producer wrote the binding format; those bytes ARE the
    #                message, and an envelope would corrupt them ⇒ no envelope.
    #   thinned    — the body is facts for the supervisor to read; the finished
    #                message is still the supervisor's to write ⇒ the envelope
    #                instructs it. Dropping the envelope here once delivered a
    #                whole transcript with no instruction to answer in form.
    canonical = cls in (CHECKIN, PROGRESS, DECISION) and canonical_presentation(cls, payload) is not None
    if cls == INTERNAL:
        envelope = ENVELOPE_INTERNAL
    elif cls == ORDINARY or canonical:
        envelope = ""
    else:
        envelope = envelope_for(cls, v.axis)

    # Compute the offered facts once: the same ordered list feeds both
    # rendering and the ledger counters.
    offered_facts = None
    if cls in (CHECKIN, PROGRESS, DECISION) and not canonical:
        offered_facts = _facts(payload)

    # The body is built BEFORE the append, so the ledger records the
    # exact bytes that went on the wire. `wire` is the audit trail for a
    # thinning the hook can no longer verify by containment.
    ledger_path = ledger_path_for(build_id)
    body = render_body(
        cls, payload,
        build_id=build_id,
        caller=os.path.basename(caller) if caller else "",
        axis=v.axis,
        ledger_path=ledger_path,
        category=category,
        facts=offered_facts,
    )
    if not body.strip():
        # A body that says nothing is not concision, it is silence. Fail, and
        # the hook falls open to today's bytes.
        raise ValueError(f"rendered body empty for class {cls}")
    if cls == INTERNAL and ledger_path not in body:
        raise ValueError("rendered body does not name its ledger path")

    # The exact bytes `fm_wake_michael` will post, assembled here so the ledger
    # records what was delivered rather than a component of it. The emit below
    # is built from THIS string, so the two cannot drift apart.
    delivered = (envelope + "\n\n" + body) if envelope else body

    # ── LAW A / LAW B — the byte bound, applied to what is actually delivered ──
    # Three populations, and they are three laws rather than one with holes:
    #
    #   ORDINARY   exempt. Law B. Byte-identical passthrough is the entire point
    #              of the class; a ceiling that clips it is the silencing this
    #              item exists to prevent. (Hook fail-open is exempt for the same
    #              reason and never reaches this line: it raises instead.)
    #   canonical  bounded, but a breach RAISES rather than clips. Those bytes
    #              ARE the producer's binding message; clipping one yields a
    #              well-formed lie, which is worse than failing open to raw. An
    #              over-long canonical body is a PRODUCER contract violation and
    #              must be reported as one.
    #   thinned    bounded and clipped, pointer last and never cut. The body is
    #              facts for the supervisor and the ledger holds every byte.
    if cls != ORDINARY:
        if canonical:
            if len(delivered.encode("utf-8")) > MAX_DELIVERED_BYTES:
                raise ValueError(
                    f"canonical {cls} body is {len(delivered.encode('utf-8'))} B, "
                    f"over the {MAX_DELIVERED_BYTES} B bound; refusing to clip a "
                    f"binding format — the producer must shorten it"
                )
        else:
            delivered = enforce_delivered_bound(
                envelope, body, f"full payload: {ledger_path}"
            )
            body = delivered[len(envelope) + 2:] if envelope else delivered

    # Loss is a ledger fact, not something a future reader infers
    # from an ellipsis. Only thinned visible classes offer `_facts`; canonical
    # messages are producer-authored wholes, and INTERNAL/ORDINARY use different
    # contracts. A dropped fact without the fixed notice is a hard failure.
    if cls in (CHECKIN, PROGRESS, DECISION) and not canonical:
        facts_offered, facts_delivered = _fact_delivery_stats(offered_facts, body)
        if facts_delivered < facts_offered and BODY_CLIPPED_NOTICE not in body:
            raise ValueError(
                "facts were dropped without the fixed Law-A clipping notice"
            )
    else:
        facts_offered = facts_delivered = 0

    # DETECTOR PRESERVATION. Law B still exempts raw passthrough from clipping;
    # this does not weaken that. It makes the exemption observable as a positive
    # ledger fact whenever byte-identical raw delivery exceeds Law A's bound.
    # Detection is derived from the bytes, not from class or declaration
    # intent, so a future classification defect cannot make the same delivery
    # look healthy merely by changing its label.
    raw_delivery = delivered == payload
    raw_over_bound = (
        raw_delivery
        and len(delivered.encode("utf-8")) > MAX_DELIVERED_BYTES
    )
    delivery_mode = (
        "raw-over-bound" if raw_over_bound
        else "raw-passthrough" if raw_delivery
        else "formatted"
    )

    record = {
        "ts": now_iso(),
        "build_id": build_id,
        "class": cls,
        "category": category,
        # §4: byte-identical to the payload received on stdin. Written BEFORE
        # anything is emitted downstream, so nothing is thinned before logging.
        "raw": payload,
        # `rendered` is the USER-FACING rendering this classification produces.
        # For INTERNAL that is the empty string by definition. It is empty for
        # a THINNED visible class too, and that is the honest value: a thinned
        # body is facts for the supervisor to read, not a message for the
        # owner; recording it as "rendered" would claim the formatter wrote it.
        "rendered": body if canonical else "",
        # Which of the two visible routes produced this body. The audit question
        # "did a program write words in Michael's voice?" is answered by this
        # field alone: `true` means the producer supplied the binding format.
        "canonical": bool(canonical),
        # The bytes that CROSSED THE GATEWAY, assembled exactly as the hook
        # assembles them — envelope, blank line, body — so an audit asking
        # "what was actually received?" gets the whole message. `body` keeps
        # the rendered half on its own.
        "wire": delivered,
        "body": body,
        "user_facing_expected": USER_FACING_EXPECTED[cls],
        "envelope": envelope,
        "caller": os.path.basename(caller) if caller else "",
        # STABLE MACHINE IDENTITY FOR THE CALL SITE. `caller` is a basename and
        # cannot say which of `foreman_wake.sh`'s sites fired; deriving that
        # from header prose would reintroduce prose-derived identity. These
        # are the resolved declarations, already validated against PRODUCERS,
        # recorded verbatim. declaration_source says whether that pair came
        # from argv, the explicit env pair, or the closed caller map. Empty
        # means UNLABELED, which is a real and auditable state rather than a
        # gap — a census depends on being able to count it.
        "producer": producer,
        "transport": transport,
        "origin_producer": args.origin_producer,
        "origin_transport": args.origin_transport,
        "declared_kind": bool(transport),
        "declaration_source": declaration_source,
        "axis": v.axis,
        "raw_bytes": len(payload.encode("utf-8")),
        "wire_bytes": len(delivered.encode("utf-8")),
        "body_bytes": len(body.encode("utf-8")),
        "envelope_bytes": len(envelope.encode("utf-8")),
        "facts_offered": facts_offered,
        "facts_delivered": facts_delivered,
        "facts_dropped": facts_offered - facts_delivered,
        # A checker needs no knowledge of the intended class or caller. This
        # positive fact is enough to find every successful raw delivery whose
        # bytes exceed the bound, while delivery_mode distinguishes healthy
        # small passthrough from the alert state.
        "raw_over_bound": raw_over_bound,
        "delivery_mode": delivery_mode,
        "delivery_bound_bytes": MAX_DELIVERED_BYTES,
        "tool": VERSION,
        # Written INTO the line now, not bolted on afterwards: the body on the
        # wire points here, so the record has to be able to confirm it is here.
        "ledger_path": ledger_path,
    }
    written = append_ledger(record)
    if written != ledger_path:
        raise ValueError(f"ledger path moved under the render: {written} != {ledger_path}")

    # Only now — after the ledger is on disk and fsync'd — is anything emitted.
    out = SENTINEL + "\n" + delivered + "\n" + END_MARKER
    sys.stdout.write(out)
    return 0


def cmd_validate(args) -> int:
    msg = sys.stdin.read()
    kind = args.format
    if kind == "auto":
        kind = detect_format(msg)
    if kind not in VALIDATORS:
        print(f"REJECTED unknown format {kind!r}", file=sys.stderr)
        return 2
    bad = VALIDATORS[kind](msg)
    if bad:
        print(f"REJECTED ({kind})", file=sys.stderr)
        for b in bad:
            print(f"  - {b}", file=sys.stderr)
        return 1
    print(f"ACCEPTED ({kind})")
    return 0


def cmd_render(args) -> int:
    """Render one of the three binding formats from JSON on stdin.

    stdin: {"format": "checkin|progress|decision", "fields": {...},
            "category": "...", "question": "...", "build_id": "..."}
    stdout: the message bytes, or the §5 safe fallback — ALWAYS something safe.
    exit 0 rendered clean · 1 fallback substituted · 2 input unusable.
    """
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception as exc:  # noqa: BLE001 — §5(4): never crash the caller
        append_presentation_log({
            "ts": now_iso(), "build_id": "unattributed",
            "event": "brief-presentation-rejected", "raw": raw,
            "violations": [f"{type(exc).__name__}: {exc}"], "tool": VERSION,
        })
        sys.stdout.write(SAFE_FALLBACK + "\n")
        return 2
    out = safe_present(
        (args.format if args.format != "auto" else data.get("format", "")) or "",
        data.get("fields") or {},
        category=data.get("category", "") or "",
        question=data.get("question", "") or "",
        raw=raw,
        build_id=data.get("build_id", "") or "",
    )
    sys.stdout.write(out if out.endswith("\n") else out + "\n")
    return 1 if out == SAFE_FALLBACK else 0


def cmd_strip_inbound(args) -> int:
    """Reduce a raw wake payload on stdin to clean plain English on stdout.

    Withheld detail is not destroyed: the raw payload is already in the ledger.
    exit 0 prose survived · 1 nothing surfaceable survived.
    """
    text = strip_inbound(sys.stdin.read())
    if not text:
        return 1
    sys.stdout.write(text + "\n")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="fm_brief", description="foreman briefing contract")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("classify", help="classify a wake payload read from stdin")
    c.add_argument("--caller", default="", help="originating script ($0 / BASH_SOURCE)")
    c.add_argument("--declare", default="", help="legacy class hint (e.g. PROGRESS); corroborates the closed caller map")
    c.add_argument("--category", default="", help="DECISION category: authority|scope|tradeoff|blocked")
    c.add_argument("--build-id", default="", help="build id; inferred from payload if omitted")
    # ── DECLARED KIND ─────────────────────────────────────────
    # Argparse defaults stay empty. resolve_declaration() applies atomic source
    # precedence: argv pair, then FM_BRIEF_PRODUCER/FM_BRIEF_TRANSPORT pair,
    # then the closed single-kind caller map. Partial declarations are never
    # completed from another source. Unresolved calls remain UNLABELED and take
    # Contract 4's visible raw path.
    c.add_argument("--producer", default="",
                   help="call-site id from PRODUCERS, e.g. foreman_wake.sh:idle-report")
    c.add_argument("--transport", default="",
                   help="transport kind from TRANSPORTS; must be allowed for --producer")
    c.add_argument("--origin-producer", default="",
                   help="replay carrier only: the call-site id of the original wake")
    c.add_argument("--origin-transport", default="",
                   help="replay carrier only: the transport of the original wake")
    c.set_defaults(func=cmd_classify)

    v = sub.add_parser("validate", help="check an outbound message against its format rails")
    v.add_argument(
        "--format", default="auto",
        choices=["auto", "progress", "checkin", "decision", "ordinary"],
    )
    v.set_defaults(func=cmd_validate)

    r = sub.add_parser("render", help="render a binding format from JSON on stdin")
    r.add_argument(
        "--format", default="auto",
        choices=["auto", "progress", "checkin", "decision"],
    )
    r.set_defaults(func=cmd_render)

    s = sub.add_parser(
        "strip-inbound", help="reduce a raw wake payload on stdin to plain English"
    )
    s.set_defaults(func=cmd_strip_inbound)

    args = p.parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001 — law 1: every failure is fail-open
        print(f"FM-BRIEF-FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.dont_write_bytecode = True  # no shadow .pyc beside a digest-checked file
    sys.exit(main())
