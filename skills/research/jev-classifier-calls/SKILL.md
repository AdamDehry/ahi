---
name: jev-classifier-calls
description: Call TypeSafe "Jev" (systemone) through the Vercel AI Gateway for cheap structured classification or prompt-injection screening — request shapes for choice/score/noul criteria, credit checks, and rate limits. Use when a pipeline needs a yes/no, pick-one or 0–1 judgement from a classifier rather than a full model turn. Needs an explicit fail-open/fail-closed ruling before it gates anything.
version: 1.1.0
category: research
private: false
last_verified: 2026-11-06
verified_by: skills-audit
---

# jev-classifier-calls

A classifier endpoint, called serially, with the criteria shape matched to the mode.

## When to use

- Screening inbound text for injection, or a cheap categorical/score judgement inside a script.

## Steps (parent turn: it needs the gateway token)

1. Endpoint: `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone`, authorized with `VERCEL_TOKEN`. Pass it from the env; never print it.
2. Criteria shapes:
   - `choice`: `criteria` is an OBJECT (label → description).
   - `score`: `criteria` is an ordered ARRAY. An object returns 400.
   - `noul`: returns a 0–1 value.
3. Check the balance before a batch: `GET …/v1/credits`.
4. Call serially with backoff. Concurrency 2 already produced 429/503.
5. Before it gates anything, get the ruling: when Jev is down or slow, does the gate fail open or closed? Write it next to the call.

## Gotchas

- The pilot harness cited in memory (the old jev-pilot folder under experiments) no longer exists (checked 2026-11-05). Rebuild a small one in the build's own workdir if needed.
- Any security finding that depends on an env var isn't a finding until you confirm the var is present (by name).

