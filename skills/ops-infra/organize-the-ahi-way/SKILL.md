---
name: organize-the-ahi-way
description: The AHI method for organizing knowledge, files and work so any agent finds the right thing in one step — one home per thing, how-to as skills on category shelves, rulings in memory as one-line pointers, current truth separate from history, the old rule replaced at its source, anything repeated enforced in a script. Teach it to any new bot. Use when setting up a new agent, project or folder, when filing anything, when memory or a folder gets bloated, or when the same mistake happens twice.
version: 1.0.0
category: ops-infra
private: false
last_verified: 2026-11-05
verified_by: michael
---

# organize-the-ahi-way

Organization is speed. If an agent knows where a thing lives, it doesn't search, guess or redo work. Every rule below exists to make "where is it?" a one-step answer.

## When to use

- Onboarding a new bot or agent: hand it this skill first.
- Starting a new project, folder or desk.
- Filing anything: a document, a ruling, a method, a build note.
- A memory file or folder has grown heavy, or two places disagree.
- The same mistake has happened twice.

## The seven rules

1. **One home per thing.** Every fact, method and file has exactly one home. Everywhere else holds a pointer to it, never a copy. Two copies will drift apart, and then nobody knows which one is true.

2. **Sort by kind first, then by topic.** There are four kinds of knowledge, and each kind has its own home:
   - **How-to** (steps, commands, a method) → a **skill** on the shelf for its category.
   - **Ruling** (a decision the owner made, a standing rule) → **memory**, STANDING RULES, one line.
   - **Current truth** (what is live or open right now) → **memory**, CURRENT TRUTH, one line, a pointer.
   - **History** (what happened) → a dated archive file, reached by a one-line pointer.
   Build progress lives in that build's own report, not in memory.

3. **Shelves by category.** Skills sit on one shelf per category (for example video, design, permits, pricing, code-quality, ops-infra, research, torah). The shelf's README is a generated map. Rule zero for any task: **open the shelf for the task's category and use the newest verified skill before doing anything by hand.**

4. **A new ruling replaces the old one at its source.** Never add a diary line next to a rule it contradicts. Find every older version (memory, skills, briefs, scripts, docs) and rewrite or delete it, so only one version is left. (Steps: skill record-a-ruling.)

5. **Anything repeated gets enforced in code.** If the owner has to say it twice, a reminder isn't enough. Put it in the script, the brief template, a hook or a gate, so it can't be skipped. Memory remembers; scripts enforce.

6. **Pointers stay short, and archives keep the detail.** Memory is an index, not a diary. One line per item: what, where, the next step. Compact it before it gets heavy (ours: 17 KB), and move closed lines verbatim to a dated archive with a pointer back.

7. **Verify, version, date.** Every skill carries a version, a last-verified date and its sources. A nightly audit flags stale skills. A skill nobody has verified is a guess.

## Filing a new thing: the decision

- Is it steps someone will repeat? → a skill. Copy `_template/`, put it on the right shelf, fill in the frontmatter, then run the shelf index.
- Is it a decision the owner made? → one line in memory's STANDING RULES. Then apply rule 4.
- Is it a status that will change? → one line in CURRENT TRUTH, pointing to where the detail lives.
- Is it a document or file? → the folder for its owner and topic (e.g. personal/finance/bills). Never a second copy elsewhere.
- None of these? → ask whether it needs keeping at all.

## Making a skill fire on its own

A skill only helps if it gets used. Three layers, weakest to strongest:

1. **A good description.** The router matches tasks to skills by their description. Write "Use when…" with concrete triggers.
2. **A prompt hook** (UserPromptSubmit). It reads the request, matches it against the shelf's descriptions and injects "use skill X" into the turn. This is a nudge: the agent sees it every time.
3. **A gate hook** (PreToolUse). It blocks a risky action, such as publishing the board or a deploy, until the matching skill has been loaded in this turn. This is the enforcement: the agent can't skip it.

Use 2 for everything. Use 3 for work where skipping the method costs money or breaks something live.

## When NOT to use

- Code architecture inside one repo: use that repo's own conventions.
- Deleting or offloading data: use storagebox-offload-and-restore (deletes sync to other machines).
