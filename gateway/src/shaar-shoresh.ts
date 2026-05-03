/**
 * שערים/שרשים address book — TS source for the gateway runtime.
 *
 * Maps English keywords to (Sha'ar, Shoresh) coordinates so the retrieval
 * pre-pass can surface relevant memory anchors without a model call. Buckets
 * align with the category set used by retrieval.ts.
 *
 * Read by:
 *   - the UserPromptSubmit hook helper (`retrieval-cli.ts`) — translates
 *     English keywords from the user's turn into the gate coordinates
 *     surfaced to the agent.
 *   - any future TS consumer in the gateway.
 */

export interface AddressBucket {
  shaar: string;
  default_shoresh: string;
  meaning: string;
  keywords: ReadonlyArray<readonly [string, string]>;
}

export interface GateHit {
  shaar: string;
  shoresh: string;
  meaning: string;
  keyword: string;
  category: string;
}

// Same payload as the canonical .mjs. Frozen so accidental mutation throws.
export const ADDRESS_BOOK: Readonly<Record<string, AddressBucket>> = Object.freeze({
  "ahi-infrastructure": {
    shaar: "בנ",
    default_shoresh: "בנה",
    meaning: "build / construct / infrastructure",
    keywords: [
      ["voice",     "קלט"],
      ["tts",       "קול"],
      ["audio",     "קול"],
      ["retrieval", "זכר"],
      ["memory",    "זכר"],
      ["session",   "זכר"],
      ["hook",      "אחז"],
      ["skill",     "כשר"],
      ["gateway",   "שער"],
      ["router",    "שער"],
      ["telegram",  "שלח"],
      ["deploy",    "שלח"],
      ["agent",     "מלך"],
      ["soul",      "נפש"],
      ["identity",  "שמה"],
      ["design",    "צור"],
      ["schema",    "צור"],
      ["ui",        "צור"],
      ["pwa",       "צור"],
      ["frontend",  "צור"],
      ["dashboard", "צור"],
    ] as const,
  },
  "torah-learning": {
    shaar: "תו",
    default_shoresh: "למד",
    meaning: "Torah / learning",
    keywords: [
      ["tanya",     "תני"],
      ["rashi",     "פרש"],
      ["rambam",    "פסק"],
      ["halach",    "פסק"],
      ["tehilim",   "תהל"],
      ["psalm",     "תהל"],
      ["daven",     "פלל"],
      ["tefil",     "פלל"],
      ["parsha",    "פרש"],
      ["parasha",   "פרש"],
      ["chumash",   "פרש"],
      ["omer",      "ספר"],
      ["count",     "ספר"],
      ["sefirot",   "ספר"],
      ["kabbal",    "סוד"],
      ["chassid",   "סוד"],
      ["mashiach",  "משח"],
      ["messianic", "משח"],
      ["gemara",    "שלם"],
      ["talmud",    "שלם"],
      ["rebbe",     "רבב"],
      ["ginsburg",  "רבב"],
      ["tzimtzum",  "צמצ"],
      ["keter",     "כתר"],
    ] as const,
  },
  personal: {
    shaar: "אה",
    default_shoresh: "אהב",
    meaning: "love / personal / family",
    keywords: [
      ["spouse",   "אשה"],
      ["wife",     "אשה"],
      ["husband",  "אשה"],
      ["family",   "בית"],
      ["home",     "בית"],
      ["kid",      "ילד"],
      ["child",    "ילד"],
      ["mother",   "אמם"],
      ["brother",  "אחה"],
      ["yacov",    "אחה"],
      ["friend",   "רעה"],
      ["feel",     "רגש"],
      ["relation", "חבר"],
    ] as const,
  },
  "voice-work": {
    shaar: "קל",
    default_shoresh: "קול",
    meaning: "voice / sound",
    keywords: [
      ["tts",    "דבר"],
      ["stt",    "שמע"],
      ["listen", "שמע"],
      ["speak",  "דבר"],
      ["twilio", "קרא"],
      ["phone",  "קרא"],
    ] as const,
  },
  tax: {
    shaar: "מס",
    default_shoresh: "מסס",
    meaning: "tax / count",
    keywords: [
      ["book",   "ספר"],
      ["ledger", "ספר"],
      ["cpa",    "חשב"],
      ["audit",  "בדק"],
    ] as const,
  },
  general: {
    shaar: "כל",
    default_shoresh: "כלל",
    meaning: "general / all",
    keywords: [
      ["plan",     "יעץ"],
      ["strategy", "יעץ"],
      ["decide",   "פסק"],
      ["review",   "בדק"],
      ["status",   "פקד"],
      ["update",   "פקד"],
    ] as const,
  },
  _unknown: {
    shaar: "כל",
    default_shoresh: "כלל",
    meaning: "unclassified",
    keywords: [] as const,
  },
});

// Short keywords (<= 3 chars) need word-boundary matching to avoid
// false positives — e.g. "ui" lighting up inside "build". Longer keywords
// match as substrings so stems like "schedul" catch "schedule"/"scheduling"
// without us having to enumerate every form.
const SHORT_KW_MAX_LEN = 3;

/**
 * Hook pre-pass — translate the user's English-ish prompt into the set of
 * {Sha'ar, Shoresh} addresses likely to be relevant. Cheap (substring
 * scan, no spawn). First match per (gate, root) wins, deduped.
 *
 * Designed to be sub-100ms even for long prompts (single-pass over the
 * keyword array; total entries ~120).
 */
export function gatesForQuery(query: string): GateHit[] {
  const text = (query ?? "").toLowerCase();
  if (!text) return [];

  // Split once for short-keyword word-boundary checks. \W+ keeps it cheap
  // and catches both spaces and punctuation as boundaries (e.g. "stt,").
  const tokens = new Set(text.split(/[^a-z0-9א-ת]+/).filter(Boolean));

  const hits: GateHit[] = [];
  const seen = new Set<string>();
  for (const [bucketKey, bucket] of Object.entries(ADDRESS_BOOK)) {
    if (bucketKey === "_unknown") continue;
    for (const [kw, root] of bucket.keywords) {
      const matches =
        kw.length <= SHORT_KW_MAX_LEN ? tokens.has(kw) : text.includes(kw);
      if (!matches) continue;
      const addr = `${bucket.shaar}/${root}`;
      if (!seen.has(addr)) {
        seen.add(addr);
        hits.push({
          shaar: bucket.shaar,
          shoresh: root,
          meaning: bucket.meaning,
          keyword: kw,
          category: bucketKey,
        });
      }
    }
  }
  return hits;
}

/**
 * Format the gate hits as a compact human-and-LLM-readable hint block. Used
 * by the hook to surface what the pre-pass found alongside the recent-
 * context retrieval. Empty string when there are no hits.
 */
export function formatGateHints(hits: GateHit[]): string {
  if (!hits || hits.length === 0) return "";
  const lines = hits
    .slice(0, 8) // cap to avoid bloating the hook output
    .map(
      (h) =>
        `- ${h.shaar}/${h.shoresh}  (${h.meaning}; matched "${h.keyword}")`,
    );
  return [
    `<retrieval-gates source="ahi-retrieval-prepass">`,
    `Detected gate(s) for this turn (Sha'ar/Shoresh — letters as coordinates):`,
    ...lines,
    `Lazy-load deeper material via \`Skill(memory-fetch)\` { gate, root }.`,
    `</retrieval-gates>`,
  ].join("\n");
}
