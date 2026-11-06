#!/usr/bin/env python3
"""EFFORT — the one table. Both the gate and build_start.sh call this; there is
no second copy to drift.

WHY THIS FILE EXISTS: people read effort words off the DESKTOP CLI PICKER. Our
scripts write a FLAG. The two vocabularies are not the same, and without one
bridge the docs get "corrected" toward one surface or the other and the other
half goes stale again.

  picker  →  flag           runtime
  extra      xhigh          claude
  light      low            codex
  extra high xhigh          codex
  ultracode  (NOT AN EFFORT — see below)

The failure this prevents is SILENT. `claude --effort ultracode` does not
error; it warns on stderr, drops the value, and runs at the default — into a
pane nobody is reading. The build then records "ultracode" in meta.json and the
ledger reports an effort that never happened.

Verify by probe, not by memory:
  claude --effort <v> --version                  → CLI warns + falls back on a bad value
  codex -m M -c model_reasoning_effort=<v> exec  → the API 400s on a bad value

The model tables below are CURRENT EXAMPLES. When a vendor ships or retires a
model, re-probe and update them here; nothing else in the foreman needs editing.

Usage:  fm_effort.py <claude|codex> <model-slug> <word>
        stdout = the value to pass through; exit 0
        stderr = why it was refused;        exit 1
"""
import sys

# ── CLAUDE ─────────────────────────────────────────────────────────────────
# `claude --help`: "--effort <level>  (low, medium, high, xhigh, max)".
# Probe result: xhigh ✓ max ✓ | extra ✗ ultracode ✗ ultra ✗ (warn + silent fallback).
CLAUDE = {"low", "medium", "high", "xhigh", "max"}

# ── CODEX ──────────────────────────────────────────────────────────────────
# Server-side validation: a bad value is a 400 unsupported_value on
# reasoning.effort, so the API is authoritative here, not the CLI — and the
# picker can hide a value the API accepts (ultra on a small model, say).
# Example probe results (re-probe when the model list changes):
#   gpt-5.6-*      none ✓ low ✓ xhigh ✓ ultra ✓ max ✓
#   gpt-5.5 / older  low ✓ none ✓ xhigh ✓ | ultra ✗ max ✗ (400 unsupported_value)
#   "extra high" ✗ and "light" ✗ everywhere — those are picker labels, not values
CODEX_56 = {"none", "low", "medium", "high", "xhigh", "ultra", "max"}
CODEX_OLD = {"none", "low", "medium", "high", "xhigh"}
# GPT-6 family — example probe results:
#   gpt-6.1-sol  low ✓ max ✓ ultra ✓ | none ✗ (400 unsupported_value)
#   gpt-6-astra  ultra ✓             | none ✗ (400 unsupported_value)
#   gpt-6-sol    ultra ✓ none ✓
#   gpt-6-luna   ultra ✓ max ✓ none ✓
CODEX_6 = {"low", "medium", "high", "xhigh", "ultra", "max"}
CODEX_6_NONE_OK = {"gpt-6-sol", "gpt-6-luna"}

# What people say / click → what the flag actually takes.
PICKER = {
    "extra": "xhigh",
    "extra high": "xhigh",
    "extrahigh": "xhigh",
    "x-high": "xhigh",
    "light": "low",
}

ULTRACODE = (
    "'ultracode' is NOT an effort level — it sits in the same picker, which is why it "
    "reads like a sixth rung, but there is no --effort value for it. It is a SESSION "
    "MODE (multi-agent workflow orchestration) and `claude --effort ultracode` is "
    "warned about on stderr, dropped, and silently run at the DEFAULT. Order the "
    "effort you want (max is the top rung) and turn ultracode on inside the session, "
    "or by putting the word in the build brief."
)


def allowed(runtime, model):
    if runtime == "claude":
        return CLAUDE
    if model.startswith("gpt-6"):
        return CODEX_6 | ({"none"} if model in CODEX_6_NONE_OK else set())
    return CODEX_56 if model.startswith("gpt-5.6") else CODEX_OLD


def resolve(runtime, model, word):
    """→ (value, None) or (None, reason). Never returns a value the runtime would drop."""
    w = (word or "").strip().lower()
    if not w:
        return None, "-e missing — effort is a decision, not a leftover"
    w = PICKER.get(w, w)
    ok = allowed(runtime, model)
    if w in ok:
        return w, None
    if w in ("ultracode", "ultra code"):
        return None, ULTRACODE
    if w == "ultra" and runtime == "codex":
        return None, (f"'ultra' is real, but only on the gpt-6 and gpt-5.6 tiers (verified "
                      f"against the API). {model} rejects it with a 400 "
                      f"unsupported_value. Use xhigh, or move the build to a gpt-6 model.")
    if w == "ultra" and runtime == "claude":
        return None, "Claude's top rung is 'max', not 'ultra' — that word is Codex's ladder."
    return None, (f"'{word}' is not a value {runtime}/{model} accepts ({'|'.join(sorted(ok))}). "
                  f"Picker words translate: extra→xhigh, extra high→xhigh, light→low.")


def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 1
    runtime, model, word = sys.argv[1], sys.argv[2], " ".join(sys.argv[3:])
    value, reason = resolve(runtime, model, word)
    if reason:
        print(reason, file=sys.stderr)
        return 1
    print(value)
    return 0


if __name__ == "__main__":
    sys.exit(main())
