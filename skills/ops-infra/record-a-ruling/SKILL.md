---
name: record-a-ruling
description: What Michael does the moment the owner (or Michael) issues a new ruling — find every older contradicting rule wherever it lives, replace it at its source, enforce repeats in code, carry gate-level rulings into ACTIVE-GATES, and keep memory to pointers. Also where how-to belongs (a skill) versus a ruling (memory). Use on every new ruling or standing instruction.
version: 1.2.0
category: ops-infra
private: false
last_verified: 2026-11-06
verified_by: skills-audit
---

# record-a-ruling

One ruling, one place, the old one gone, the repeat enforced in code.

## When to use

- The owner rules something on a call or in chat; a standing instruction changes; a lesson should become a rule.

## Steps

1. **Grep for the contradicting older rule everywhere it can live:** agent memory, standing docs, scripts,
   config, live build briefs and the skills shelf. Use `command grep -rn`.
2. **Replace it at its source** — edit the script, doc, config or skill itself; never just a diary line beside it.
3. **Anything repeated gets enforced in code** (e.g. the restart script checks live calls), not only written down.
4. **Gate-level rulings** (anything that stops or permits a phase) → carry into the foreman's ACTIVE-GATES with
   `foreman/bin/fm_recarry.py`, then `foreman/bin/fm_gates.py check`, so every build it starts is told.
5. **Memory hygiene:** the ruling itself goes in STANDING RULES as one line (who, date, what). CURRENT TRUTH holds
   pointers only, one line each. Build progress lives in the build's REPORT. Compact before 17 KB.
6. **How-to goes on the shelf:** if the ruling changes a procedure, update (and version-bump) the skill on
   `$AHI_AI_ROOT/skills/<category>/<skill>/` and cite the ruling in its "Rulings this depends on". Do not paste
   steps into memory.

## Gotchas

- A grep for an identifier is not proof the edit landed — read the lines back.
- Newest date wins; say in the replaced place what it supersedes.

## Rulings this depends on

- Your operator's memory procedure: rulings live in memory as one line each, how-to lives on the skills shelf.

## Related skills

`safe-shell-hygiene`.
