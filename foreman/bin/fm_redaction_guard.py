#!/usr/bin/env python3
"""fm_redaction_guard — is anything under these paths enrolled as a redaction source?

A redactor that fails closed on a missing enrolled source is correct — but if a
cleanup retires a folder that still holds an enrolled source, every ingest then
fails closed until the enrollment is repaired, and the memory index stalls for
days. Retiring the folder is not wrong; retiring it without ASKING first is.
This is the asking.

The redactor is an OPTIONAL integration. Set FM_REDACTOR_MJS to an ES module
exporting defaultSources() — the one table of "what the redactor reads". Asking
that table, rather than re-parsing an enrollment registry here, means this guard
cannot drift from the redactor. Only PATHS cross the process boundary —
defaultSources() must load no credential value.

  FM_REDACTOR_MJS unset  → no redactor configured, NOTHING is enrolled: every
                           caller (fm_close, fm_worktree_clean, `fm_worktree.sh
                           guard`) proceeds on its other checks.
  FM_REDACTOR_MJS set    → FAIL CLOSED: if the table cannot be read (missing file,
                           node error, timeout, bad output), every path is treated
                           as protected.

Both path spellings are compared (as written, and realpath), because the same
file is often reachable through symlinks, and a protection pinned to one
spelling is not a protection.

  fm_redaction_guard.py check <path>...   exit 0 none enrolled under them (or no redactor)
                                          exit 3 enrolled sources found (listed)
                                          exit 4 source table unreadable (refuse)
Library: enrolled_sources() -> [(id, path)] or raises GuardError;
         protected_under(path, sources) -> [(id, path)]; redactor_configured() -> bool
"""
import json
import os
import subprocess
import sys

REDACT = os.environ.get("FM_REDACTOR_MJS", "")  # optional; unset = no redactor, nothing enrolled
NODE = os.environ.get("FM_NODE", "node")

_JS = r"""
const { defaultSources } = await import(process.argv[1]);
const out = [];
for (const s of defaultSources()) {
  for (const p of [s.path, ...(s.paths ?? [])]) if (typeof p === "string" && p) out.push([s.id, p]);
}
process.stdout.write(JSON.stringify(out));
"""


class GuardError(Exception):
    pass


def redactor_configured():
    return bool(REDACT)


def enrolled_sources():
    if not REDACT:
        return []  # no redactor configured: nothing can be enrolled, callers proceed
    if not os.path.isfile(REDACT):
        raise GuardError("FM_REDACTOR_MJS is set but the file does not exist")
    try:
        r = subprocess.run([NODE, "--input-type=module", "-e", _JS, REDACT],
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise GuardError(f"could not run the redactor's source table ({type(e).__name__})")
    if r.returncode != 0:
        # The redactor's error strings should carry ids, statuses and counts only — keep
        # just one line anyway; this lands in clean logs.
        first = (r.stderr.strip().splitlines() or ["no stderr"])[-1][:200]
        raise GuardError(f"redactor source table refused to load (rc={r.returncode}): {first}")
    try:
        rows = json.loads(r.stdout)
        return [(str(i), str(p)) for i, p in rows]
    except (ValueError, TypeError):
        raise GuardError("redactor source table returned unparseable output")


def _forms(p):
    a = os.path.abspath(p)
    return {a, os.path.realpath(a)}


def _under(child, parent):
    return child == parent or child.startswith(parent.rstrip("/") + "/")


def protected_under(path, sources):
    """Enrolled sources at or below `path` (either spelling on either side)."""
    roots = _forms(path)
    hits = []
    for sid, sp in sources:
        if any(_under(f, r) for f in _forms(sp) for r in roots):
            hits.append((sid, sp))
    return hits


def main(argv):
    if len(argv) < 2 or argv[0] != "check":
        print(__doc__.strip().split("\n\n")[-1], file=sys.stderr)
        return 2
    try:
        sources = enrolled_sources()
    except GuardError as e:
        print(f"fm_redaction_guard: REFUSE — {e}. Treating every path as protected.", file=sys.stderr)
        return 4
    if not redactor_configured():
        print("fm_redaction_guard: clear — no redactor configured (FM_REDACTOR_MJS unset), nothing enrolled")
        return 0
    found = 0
    for p in argv[1:]:
        for sid, sp in protected_under(p, sources):
            found += 1
            print(f"PROTECTED {p}: redaction source '{sid}' -> {sp}")
    if found:
        print(f"fm_redaction_guard: {found} enrolled redaction source(s) under the given path(s). "
              f"Retire them first (register superseded values in the retired registry, move "
              f"live ones to a stable enrolled store, then drop the rows), then retry.", file=sys.stderr)
        return 3
    print(f"fm_redaction_guard: clear — none of {len(sources)} enrolled source path(s) is under the given path(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
