---
name: memory-fetch
description: Lazy-load AHI memory addressed by Sha'ar (gate, 2 Hebrew letters) + Shoresh (root, 3 Hebrew letters) — the שערים/שרשים coordinate system canonized in `$AHI_HOME/mission-control/ARCHITECTURE.md`. Use when the stable system prompt's gate-hint pre-pass surfaced a (gate, root) pair you need deeper material on, OR when you proactively want material at a known address (e.g., loading the full soul / AHI Foundation / a topic-specific session bundle). Returns matching session summaries from `$AHI_HOME/state/primary/sessions/index.json` plus relevant deep files. Cheap (no LLM spawn) — pure index lookup. NOT a search tool — the address must be known up-front. For free-text discovery use Read/Grep first, then memory-fetch the gate.
---

# memory-fetch

Lazy-loader for the AHI memory architecture. The H-034 stable system prompt deliberately ships ~1.5–2K tokens — everything else lives at a (Sha'ar, Shoresh) address. This skill is how an agent reaches into the rest of memory on demand.

## When to invoke

- The hook pre-pass tagged the live turn with a `<retrieval-gates>` block and you want deeper material at one of those addresses.
- You're about to do non-trivial work in a known domain and need the full context (e.g. "I'm rebuilding the gateway hook — load everything at בנ/אחז").
- You need your own full soul / AHI Foundation / shared neshama and only got the identity paragraph in the stable preamble.
- You need current mission-control state (HANDOFF, ACTIVITY_FEED, TODAY).

## When NOT to invoke

- For free-text search across the whole corpus — use Grep + Read.
- For the user's most recent prior session — that already arrives via the UserPromptSubmit hook.
- For trivia you can derive from current state (read the file directly).

## Gate / Root vocabulary

The shared address book: `$AHI_HOME/infra/sessions/scripts/shaar_shoresh_address_book.mjs`. English aliases that translate to a Sha'ar:

| English alias       | Sha'ar | Domain                               |
|---------------------|--------|--------------------------------------|
| build, infra, ahi   | בנ     | gateway / agents / soul / deployment |
| torah, learning     | תו     | Torah, Chassidut, Halacha            |
| business, business   | קנ     | acquire / commerce                   |
| heal, care          | רפ     | esthetician / healing / care         |
| personal, family    | אה     | love / family / relationships        |
| voice, sound        | קל     | TTS / STT / phone                    |
| tax, count          | מס     | tax / accounting                     |
| general, all        | כל     | cross-cutting / unfiled              |

**Special pseudo-gates** (NOT in the address book — they bypass index lookup and load specific deep files):

| Pseudo-gate | Root      | Loads                                                       |
|-------------|-----------|-------------------------------------------------------------|
| `self`      | `soul`    | Your full soul file (`$AHI_HOME/agents/soul/<YOU>.md`)           |
| `self`      | `memory`  | Your per-agent memory (`$AHI_HOME/state/primary/agent-memory/<you>/MEMORY.md`)|
| `founding`  | `angel`   | The AHI Foundation essay (`$AHI_HOME/agents/soul/AHI-FOUNDATION.md`)    |
| `founding`  | `neshama` | The shared neshama (`~/ai/agents/neshamah.md`)              |
| `ahi`       | `state`   | HANDOFF + ACTIVITY_FEED + TODAY (compact)                   |
| `ahi`       | `architecture` | `$AHI_HOME/mission-control/ARCHITECTURE.md`                |
| `ahi`       | `core`    | `$AHI_HOME/mission-control/AHI_NESHAMA.md`                       |

## Usage

```bash
# By Hebrew address (the canonical form):
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate בנ --root זכר

# By English aliases (resolved against the address book):
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate build --root memory

# Special pseudo-gates:
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate self --root soul --agent tzali
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate ahi --root state
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate founding --root angel

# Limit results / change verbosity:
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate בנ --root זכר --limit 5
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate build --root memory --titles-only

# JSON output (for downstream tooling):
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate בנ --root זכר --json
```

## Output

Default plain-text format:

```
== Memory @ בנ/זכר (build / construct / infrastructure | root: memory) ==
Total entries at this address: 93. Showing 10 most recent.

### 2026-04-26 — The One About H-034 Memory Architecture (tzali)
- Tzali shipped the stable preamble + memory-fetch skill...
- ...

### 2026-04-25 — The One About Session Cataloging (michael)
- ...
```

JSON format includes the full entries verbatim. Both forms include `transcript_path_md` so the agent can `Read()` a specific transcript when a summary isn't enough.

## Examples

**Hook surfaced gates and you want depth on memory:**
```bash
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate בנ --root זכר --limit 5
```

**About to start the user's business work — want the full domain bundle:**
```bash
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate קנ --root רכב
```

**Need your full soul (only the identity paragraph is in the stable preamble):**
```bash
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate self --root soul --agent tzali
```

**What's the current AHI state?:**
```bash
$AHI_HOME/skills/memory-fetch/memory_fetch.sh --gate ahi --root state
```

## Cost

Zero LLM spawns. Pure file I/O over `$AHI_HOME/state/primary/sessions/index.json` (~375KB) and the deep-file targets. Typical wall-time: 20-80ms.
