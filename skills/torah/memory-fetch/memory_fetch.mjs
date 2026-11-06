#!/usr/bin/env node
/**
 * memory_fetch — H-034 memory loader.
 *
 * Lazy-load AHI memory addressed by (gate, root). Reads:
 *   - the canonical address book at
 *     `$AHI_HOME/infra/sessions/scripts/shaar_shoresh_address_book.mjs`
 *   - the session index at `$AHI_HOME/state/primary/sessions/index.json`
 *   - selected deep files for the special pseudo-gates (self, founding, ahi)
 *
 * No LLM spawn. Pure file I/O. Output is human-and-LLM-readable plain text
 * (default) or JSON (with --json). Wall-time ≤ ~80ms on a warm cache.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { ADDRESS_BOOK } from "../../infra/sessions/scripts/shaar_shoresh_address_book.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const INDEX_PATH = resolve(HOME, "ai/infra/sessions/index.json");
const SOUL_DIR = resolve(HOME, "ai/agents/soul");
const AGENT_MEMORY_DIR = resolve(HOME, "ai/agents/memory");
const NESHAMA_FILE = resolve(HOME, "ai/agents/neshamah.md");
const FOUNDATION_FILE = resolve(HOME, "ai/soul/AHI-FOUNDATION.md");
const AHI_NESHAMA_FILE = resolve(HOME, "ai/mission-control/AHI_NESHAMA.md");
const ARCHITECTURE_FILE = resolve(HOME, "ai/mission-control/ARCHITECTURE.md");
const HANDOFF_FILE = resolve(HOME, "ai/mission-control/HANDOFF.md");
const ACTIVITY_FEED_FILE = resolve(HOME, "ai/mission-control/ACTIVITY_FEED.md");
const TODAY_FILE = resolve(HOME, "ai/mission-control/TODAY.md");

// English -> Sha'ar aliases. Mirrors the table in SKILL.md.
const GATE_ALIASES = {
  build: "בנ",
  infra: "בנ",
  ahi: "בנ",            // overlaps with the pseudo-gate "ahi"; resolution is by --root
  torah: "תו",
  learning: "תו",
  business: "קנ",
  business: "קנ",
  heal: "רפ",
  personal: "אה",
  family: "אה",
  voice: "קל",
  sound: "קל",
  tax: "מס",
  count: "מס",
  general: "כל",
  all: "כל",
};

// English -> Shoresh aliases (per-gate). Lets the agent type
// `--gate build --root memory` instead of `--root זכר`. We only seed the
// most common; uncommon roots can be passed as Hebrew directly.
const ROOT_ALIASES = {
  // build / בנ
  memory: "זכר",       // z-k-r remember
  session: "זכר",
  retrieval: "זכר",
  audio: "קול",
  voice: "קלט",
  hook: "אחז",
  skill: "כשר",
  gateway: "שער",
  router: "שער",
  telegram: "שלח",
  deploy: "שלח",
  agent: "מלך",
  soul: "נפש",
  identity: "שמה",
  ui: "צור",
  schema: "צור",
  pwa: "צור",
  // torah / תו
  parsha: "פרש",
  rashi: "פרש",
  count_torah: "ספר",
  pray: "פלל",
  mystical: "סוד",
  // commerce / קנ
  car: "רכב",
  vehicle: "רכב",
  rate: "שלם",
  price: "שלם",
  call: "קרא",
  // heal / care / רפ
  schedule: "מוע",
  client: "אשה",
  treatment: "תקן",
  skin: "עור",
  // personal / אה
  wife: "אשה",
  family_unit: "בית",
  child: "ילד",
  brother: "אחה",
  // tax / מס
  ledger: "ספר",
  audit: "בדק",
};

// Special pseudo-gates: keys = gate, values = { root: handler }
// Handlers return strings (rendered plain text) or {error}.
const PSEUDO_GATES = {
  self: {
    soul: ({ agent }) => loadSoul(agent),
    memory: ({ agent }) => loadAgentMemory(agent),
  },
  founding: {
    angel: () => readOrFlag(FOUNDATION_FILE, "AHI Foundation (angel essay)"),
    neshama: () => readOrFlag(NESHAMA_FILE, "Shared neshama"),
  },
  ahi: {
    state: () => loadStateBundle(),
    architecture: () =>
      readOrFlag(ARCHITECTURE_FILE, "AHI Architecture — שערים/שרשים"),
    core: () => readOrFlag(AHI_NESHAMA_FILE, "AHI Shared Neshama (full)"),
  },
};

function readOrFlag(path, label) {
  if (!existsSync(path)) return `[memory-fetch] missing: ${label} (${path})`;
  return `== ${label} (${path}) ==\n\n${readFileSync(path, "utf-8")}`;
}

function loadSoul(agent) {
  if (!agent)
    return "[memory-fetch] error: --agent <name> required for self/soul";
  const soulPath = resolve(SOUL_DIR, `${agent.toUpperCase()}.md`);
  return readOrFlag(soulPath, `Soul: ${agent}`);
}

function loadAgentMemory(agent) {
  if (!agent)
    return "[memory-fetch] error: --agent <name> required for self/memory";
  const memDir = resolve(AGENT_MEMORY_DIR, agent.toLowerCase());
  const memFile = resolve(memDir, "MEMORY.md");
  if (!existsSync(memFile))
    return `[memory-fetch] missing per-agent memory: ${memFile}`;
  return `== Per-agent memory: ${agent} (${memFile}) ==\n\n` +
    readFileSync(memFile, "utf-8");
}

function loadStateBundle() {
  // HANDOFF + ACTIVITY_FEED head + TODAY. Keep it tight — agents that need
  // the full activity log can Read() it directly.
  const handoff = existsSync(HANDOFF_FILE)
    ? readFileSync(HANDOFF_FILE, "utf-8")
    : "[missing]";
  const activity = existsSync(ACTIVITY_FEED_FILE)
    ? readFileSync(ACTIVITY_FEED_FILE, "utf-8").split("\n").slice(0, 80).join("\n")
    : "[missing]";
  const today = existsSync(TODAY_FILE)
    ? readFileSync(TODAY_FILE, "utf-8")
    : "[missing]";
  return [
    `== AHI State Bundle ==\n`,
    `### HANDOFF.md (${HANDOFF_FILE})\n${handoff}`,
    `### ACTIVITY_FEED.md head (${ACTIVITY_FEED_FILE})\n${activity}`,
    `### TODAY.md (${TODAY_FILE})\n${today}`,
  ].join("\n\n---\n\n");
}

// ── Address resolution ───────────────────────────────────────────────────

function resolveGate(input) {
  if (!input) return null;
  // Hebrew already? (any non-ASCII char in the first byte heuristic — Hebrew
  // letters live in U+05D0..U+05EA, well above ASCII 0x7F)
  if (/[֐-׿]/.test(input)) return input;
  const key = input.toLowerCase();
  return GATE_ALIASES[key] ?? null;
}

function resolveRoot(input) {
  if (!input) return null;
  if (/[֐-׿]/.test(input)) return input;
  const key = input.toLowerCase();
  return ROOT_ALIASES[key] ?? null;
}

// ── Index lookup ─────────────────────────────────────────────────────────

function loadIndex() {
  if (!existsSync(INDEX_PATH)) {
    return { entries: [], error: `index not found at ${INDEX_PATH}` };
  }
  try {
    return { entries: JSON.parse(readFileSync(INDEX_PATH, "utf-8")), error: null };
  } catch (err) {
    return { entries: [], error: `index parse failed: ${err.message}` };
  }
}

function entriesAt(entries, gate, root) {
  return entries.filter(
    (e) => e?.shaar === gate && (root ? e?.shoresh === root : true),
  );
}

function bucketLabelFor(gate, root) {
  for (const [bucketKey, bucket] of Object.entries(ADDRESS_BOOK)) {
    if (bucket.shaar === gate) {
      const rootLabel = root ?? "(any)";
      return `${gate}/${rootLabel} (${bucket.meaning})`;
    }
  }
  return `${gate}/${root ?? "(any)"}`;
}

// ── Output rendering ─────────────────────────────────────────────────────

function renderEntry(entry) {
  const date = (entry.started_at ?? "").slice(0, 10) || "unknown";
  const summary = (entry.summary ?? "(no summary)").trim();
  const path = entry.transcript_path_md ?? "(no transcript)";
  return [
    `### ${date} — ${entry.episode_name ?? "(no title)"} (${entry.agent ?? "?"})`,
    `Address: ${entry.shaar ?? "?"}/${entry.shoresh ?? "?"}  ·  Category: ${entry.category ?? "_unknown"}  ·  Path: ${path}`,
    summary,
  ].join("\n");
}

function renderPlain(label, total, shown, entries, titlesOnly) {
  const head = `== Memory @ ${label} ==\nTotal entries at this address: ${total}. Showing ${shown} most recent.`;
  if (entries.length === 0) {
    return `${head}\n\n[memory-fetch] no entries at this address — try a different (gate, root) or use Grep over the index.`;
  }
  if (titlesOnly) {
    const lines = entries.map((e) => {
      const d = (e.started_at ?? "").slice(0, 10);
      return `- ${d}  ${e.shaar}/${e.shoresh}  ${e.episode_name ?? "(no title)"} [${e.agent ?? "?"}]`;
    });
    return `${head}\n\n${lines.join("\n")}`;
  }
  return `${head}\n\n${entries.map(renderEntry).join("\n\n")}`;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    gate: null,
    root: null,
    agent: null,
    limit: 10,
    titlesOnly: false,
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gate") args.gate = argv[++i];
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--agent") args.agent = argv[++i];
    else if (a === "--limit") args.limit = Math.max(1, Number(argv[++i]) || 10);
    else if (a === "--titles-only") args.titlesOnly = true;
    else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: memory_fetch.sh --gate <gate> --root <root> [options]

Required:
  --gate <gate>     Sha'ar — Hebrew (e.g. בנ) or English alias (e.g. build).
                    Special pseudo-gates: self, founding, ahi
  --root <root>     Shoresh — Hebrew (e.g. זכר) or English alias (e.g. memory).
                    For pseudo-gates, see SKILL.md for valid roots.

Options:
  --agent <name>    Required for self/* pseudo-gates (your agent name)
  --limit <n>       Max session results to return (default: 10)
  --titles-only     Only list episode titles + addresses, not summaries
  --json            JSON output (full entry shape)
  -h, --help        This help

Examples:
  memory_fetch.sh --gate בנ --root זכר
  memory_fetch.sh --gate build --root memory --limit 5
  memory_fetch.sh --gate self --root soul --agent zali
  memory_fetch.sh --gate ahi --root state
  memory_fetch.sh --gate founding --root angel
`);
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.gate || !args.root) {
    console.error("[memory-fetch] error: --gate and --root are required.");
    printHelp();
    process.exit(2);
  }

  // Pseudo-gate dispatch — bypass the index entirely.
  const pseudo = PSEUDO_GATES[args.gate.toLowerCase()];
  if (pseudo) {
    const handler = pseudo[args.root.toLowerCase()];
    if (!handler) {
      console.error(
        `[memory-fetch] error: pseudo-gate '${args.gate}' has no root '${args.root}'. ` +
          `Valid roots: ${Object.keys(pseudo).join(", ")}`,
      );
      process.exit(2);
    }
    const out = handler({ agent: args.agent });
    if (args.json) {
      process.stdout.write(JSON.stringify({ pseudo: true, gate: args.gate, root: args.root, body: out }, null, 2));
    } else {
      process.stdout.write(out);
      if (!out.endsWith("\n")) process.stdout.write("\n");
    }
    return;
  }

  // Real address dispatch — translate, then look up the index.
  const gate = resolveGate(args.gate);
  if (!gate) {
    console.error(
      `[memory-fetch] error: unknown gate '${args.gate}'. Valid English aliases: ${Object.keys(
        GATE_ALIASES,
      ).join(", ")}. Or pass a Hebrew Sha'ar directly (e.g. בנ).`,
    );
    process.exit(2);
  }
  const root = resolveRoot(args.root);
  if (!root) {
    console.error(
      `[memory-fetch] error: unknown root '${args.root}'. Pass a Hebrew Shoresh directly (e.g. זכר) or one of the English aliases in SKILL.md.`,
    );
    process.exit(2);
  }

  const { entries, error } = loadIndex();
  if (error) {
    console.error(`[memory-fetch] ${error}`);
    process.exit(1);
  }

  const matches = entriesAt(entries, gate, root);
  // Sort: newest first by started_at; entries with no started_at go to the end.
  matches.sort((a, b) => {
    const sa = a.started_at ?? "";
    const sb = b.started_at ?? "";
    if (sa && sb) return sb.localeCompare(sa);
    if (sa) return -1;
    if (sb) return 1;
    return 0;
  });
  const shown = matches.slice(0, args.limit);

  const label = bucketLabelFor(gate, root);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          gate,
          root,
          label,
          total: matches.length,
          shown: shown.length,
          entries: shown,
        },
        null,
        2,
      ),
    );
  } else {
    process.stdout.write(renderPlain(label, matches.length, shown.length, shown, args.titlesOnly));
    process.stdout.write("\n");
  }
}

main();
