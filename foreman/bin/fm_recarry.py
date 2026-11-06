#!/usr/bin/env python3
"""THE REPAIR FOR A RED RECONCILER — re-carry one gate, or carry a new one,
from QUEUE.md into ACTIVE-GATES.md. Deliberately, one key at a time, with the
diff printed.

WHY THIS FILE IS PART OF THE LANDING AND NOT A CONVENIENCE
──────────────────────────────────────────────────────────
The failure mode of the gate machinery is not a broken file, it is a fleet
that quietly stops launching:

    Append ONE new gate-shaped ruling to QUEUE.md — the single most ordinary
    event there is — and the reconciler goes UNCARRIED, and `build_start.sh`
    then refuses EVERY launch with rc=3.

That refusal is correct: a build must not receive a gate set that provably
disagrees with the queue. But as first written it named no repair. It printed
the problem and offered `FM_GATES_OPTOUT`, which does not fix anything — it
launches ungated. The only actual remedy was "a human re-pastes forty lines of
ruling text and recomputes a sha256 by hand", and a remedy that tedious is one
that gets skipped under pressure, or done by eye and subtly wrong — which puts a
DIVERGED carry-copy into every spawn prompt while the check reads green.

A mechanical detector whose only remedy is manual is half a control. This is
the other half, and `fm_gates.py check` now names it in the failure report.

WHY IT IS NOT A `fm_gates.py` SUBCOMMAND
────────────────────────────────────────
fm_gates.py is on the runtime path of the launcher, the guard and the chain.
Nothing that WRITES the gate source belongs in the binary those three read.

And re-carry must stay an explicit human act. An automatic "sync" would make
ACTIVE-GATES.md agree with QUEUE.md by definition, and a check that cannot
disagree is not a check — it reads green by construction. **The check detects; a
person accepts.** So: one key at a time, named on the command line, diff to
stdout, and nothing is written without `--write`.

USAGE
─────
    fm_recarry.py <GATE-KEY> [--write]        # a carried ruling drifted
    fm_recarry.py --add <anchor-prefix> --key K [--ruling R] [--authority A]
                  [--dated D] [--status active] [--write]
                                               # a ruling QUEUE.md has and this does not

`--add` scaffolds the entry from the QUEUE.md block and stops there. It does NOT
guess `blocks:` or `forbid:` — those are judgements about what a ruling STOPS,
and a wrong guess either gates a phase nobody gated or silently fails to gate
one that was. It prints a reminder to set them by hand.
"""
import difflib
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fm_gates import queue_lines, find_block, digest, normalize  # noqa: E402

AHI_HOME = os.environ.get("FM_AHI_HOME") or os.environ.get("AHI_HOME") or os.path.expanduser("~/ahi")
FOREMAN_ROOT = os.environ.get("FOREMAN_ROOT") or os.path.join(AHI_HOME, "foreman")
GATES = os.environ.get("FM_GATES_FILE") or os.path.join(FOREMAN_ROOT, "ACTIVE-GATES.md")


def split_entries(text):
    """Return [(key, start_idx, end_idx)] over the raw lines of ACTIVE-GATES.md."""
    lines = text.split("\n")
    out, cur = [], None
    for i, ln in enumerate(lines):
        m = re.match(r"^## GATE (\S+)\s*$", ln)
        if m:
            if cur:
                out.append((cur[0], cur[1], i))
            cur = (m.group(1), i)
    if cur:
        out.append((cur[0], cur[1], len(lines)))
    return lines, out


def opt(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def add(write):
    """Carry a ruling QUEUE.md has and ACTIVE-GATES.md does not — the UNCARRIED
    repair. Appends a scaffolded entry; deliberately does not invent `blocks:`.
    """
    prefix = opt("--add")
    key = opt("--key")
    if not prefix or not key:
        print("--add needs an anchor prefix and --key", file=sys.stderr)
        return 2

    qlines = queue_lines()
    status, text, lineno = find_block(qlines, prefix)
    if status != "ok":
        print("cannot carry: QUEUE.md lookup for that anchor says %s" % status, file=sys.stderr)
        return 1
    # The anchor must be the RAW head line, comment marker and all — that is what
    # find_block() matches against on every later check. find_block() returns the
    # block COMMENT-STRIPPED, so taking the anchor from its text drops the "# "
    # and every subsequent reconcile reports MISSING-IN-QUEUE. Caught by running
    # the round trip instead of reading the output, which is the whole rule.
    rawhead = qlines[lineno - 1].rstrip("\n")

    raw = open(GATES, errors="replace").read()
    _lines, entries = split_entries(raw)
    if any(k == key for k, _s, _e in entries):
        print("gate key %s already exists — use `fm_recarry.py %s` to re-carry it"
              % (key, key), file=sys.stderr)
        return 1

    head = rawhead.lstrip("#").strip()   # guess off the words, not the comment marker
    # Best-effort only, and it is stated as such: a wrong guess here is visible
    # in the printed entry and costs nothing, because nothing is written without
    # --write and a human reading it.
    m = re.match(r"\s*([A-Z]+-\d+[a-z]?)\b", head)
    ruling = opt("--ruling") or (m.group(1) if m else key)
    m = re.search(r"\bby\s+([A-Z][a-z]+)", head)
    authority = opt("--authority") or (m.group(1) if m else "?")
    m = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", head)
    dated = opt("--dated") or (m.group(1) if m else "?")

    entry = [
        "",
        "## GATE %s" % key,
        "ruling: %s" % ruling,
        "authority: %s" % authority,
        "dated: %s" % dated,
        "status: %s" % (opt("--status") or "active"),
        "deliver: prompt",
        "anchor: %s" % rawhead,
        "digest: %s" % digest(text),
        "<<<VERBATIM",
        text.rstrip(),
        "VERBATIM",
        "",
    ]
    print("NEW ENTRY for %s, carried from QUEUE.md:%d\n" % (key, lineno))
    print("\n".join(entry[:9]))
    print("<<<VERBATIM\n  ... %d lines of ruling text ...\nVERBATIM" % len(text.split("\n")))
    print("\nNOT SET, and NOT guessed — set by hand if they apply:")
    print("  blocks:     which phase this ruling STOPS. The chain's gate check reads")
    print("              this and nothing else; a ruling with no blocks: line will")
    print("              NOT stop the chain from naming that phase as next.")
    print("  forbid:     a mechanical rail for the PreToolUse guard, if one fits.")
    print("  ruling/authority/dated were read off the head line — check them.")
    if not write:
        print("\n(dry run — pass --write to carry it)")
        return 0
    open(GATES, "w").write(raw.rstrip("\n") + "\n" + "\n".join(entry))
    print("\ncarried %s into %s — now run `fm_gates.py check`" % (key, GATES))
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    write = "--write" in sys.argv
    if "--add" in sys.argv:
        return add(write)
    key = sys.argv[1]

    raw = open(GATES, errors="replace").read()
    lines, entries = split_entries(raw)
    hit = [e for e in entries if e[0] == key]
    if not hit:
        print("no such gate key: %s (have: %s)"
              % (key, ", ".join(e[0] for e in entries)), file=sys.stderr)
        return 1
    _k, s, e = hit[0]
    entry = lines[s:e]

    anchor = None
    for ln in entry:
        if ln.startswith("anchor: "):
            anchor = ln[len("anchor: "):]
    if anchor is None:
        print("gate %s has no anchor:" % key, file=sys.stderr)
        return 1

    status, text, _n = find_block(queue_lines(), anchor)
    if status != "ok":
        print("cannot re-carry %s: QUEUE.md lookup says %s" % (key, status), file=sys.stderr)
        return 1

    # Rebuild the entry: everything before digest: is preserved verbatim (the
    # human metadata — status, blocks, forbid, note — is NOT regenerated;
    # regenerating it silently discards human judgements, which is the reason
    # this tool is narrow).
    new, i = [], 0
    while i < len(entry):
        ln = entry[i]
        if ln.startswith("digest: "):
            new.append("digest: %s" % digest(text))
        elif ln.startswith("<<<VERBATIM"):
            new.append("<<<VERBATIM")
            new.append(text.rstrip())
            while i < len(entry) and entry[i].rstrip() != "VERBATIM":
                i += 1
            new.append("VERBATIM")
        else:
            new.append(ln)
        i += 1

    if new == entry:
        print("gate %s already matches QUEUE.md — nothing to do." % key)
        return 0

    print("".join(difflib.unified_diff([l + "\n" for l in entry], [l + "\n" for l in new],
                                       fromfile="ACTIVE-GATES.md:%s (carried)" % key,
                                       tofile="QUEUE.md:%s (authored)" % key)))

    # The words are what matter; a reflow is not a ruling change. Say which
    # this is, because they warrant different amounts of attention.
    old_v = "\n".join(entry)
    if normalize(text) in normalize(old_v):
        print("NOTE: whitespace-only change — the ruling's WORDS are unchanged.")
    else:
        print("NOTE: the ruling's WORDS CHANGED. Read the diff before --write.")

    if not write:
        print("\n(dry run — pass --write to accept)")
        return 0

    out = lines[:s] + new + lines[e:]
    open(GATES, "w").write("\n".join(out))
    print("re-carried %s into %s" % (key, GATES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
