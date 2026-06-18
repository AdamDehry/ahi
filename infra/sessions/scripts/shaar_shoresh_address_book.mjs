/**
 * Shared address book for the שערים/שרשים methodology.
 *
 * Read by:
 *   - the enrichment pass (`enrich_shaar_shoresh.mjs`) — writes shaar/shoresh
 *     onto every session in `~/ai/infra/sessions/index.json`.
 *   - the gateway's UserPromptSubmit hook (`retrieval-cli`) — translates
 *     English keywords from the user's turn into the same gate so the
 *     hook can return additionalContext addressed to that gate.
 *
 * Keeping the address book in one place is the whole point of letters-
 * as-coordinates: both ends of the system must agree on what gate a
 * concept lives under, otherwise the index does not function as an
 * address.
 *
 * Schema per category bucket:
 *   shaar:           2 Hebrew letters — the Sha'ar (gate)
 *   default_shoresh: 3 Hebrew letters — fallback root inside the gate
 *   meaning:         English gloss for telemetry only (NOT part of address)
 *   keywords:        list of [substring, shoresh] pairs; first match wins
 *
 * The buckets are keyed by the gateway's existing `category` field so
 * the enrichment is purely additive — no rebuild of upstream data is
 * required. As the Ginsburg corpus is indexed in future passes the
 * keyword lists get more diverse Sha'arim per category, and the
 * deterministic rule here gets replaced by a Hebrew-NLP front end. The
 * skill's address-shape (one Sha'ar key + one Shoresh value) does not
 * change.
 */

export const ADDRESS_BOOK = Object.freeze({
  // AHI infrastructure — gateway, agents, soul, deployment, builds.
  // Sha'ar בנ ("build") opens to roots of construction/foundation.
  "ahi-infrastructure": {
    shaar: "בנ",
    default_shoresh: "בנה",   // b-n-h: to build, root of binyan
    meaning: "build / construct / infrastructure",
    keywords: [
      ["voice",    "קלט"],   // k-l-t: receive/intake (audio in)
      ["tts",      "קול"],   // k-w-l: voice/sound
      ["audio",    "קול"],
      ["retrieval","זכר"],   // z-k-r: remember
      ["memory",   "זכר"],
      ["session",  "זכר"],
      ["hook",     "אחז"],   // a-h-z: grasp/hold
      ["skill",    "כשר"],   // k-sh-r: skilled/capable
      ["gateway",  "שער"],   // sh-'-r: gate
      ["router",   "שער"],
      ["telegram", "שלח"],   // sh-l-h: to send
      ["deploy",   "שלח"],
      ["agent",    "מלך"],   // m-l-k: messenger/king (mal'akh)
      ["soul",     "נפש"],   // n-p-sh: soul
      ["identity", "שמה"],   // sh-m-h: name/identity
      ["design",   "צור"],   // ts-w-r: form/shape
      ["schema",   "צור"],
      ["ui",       "צור"],
      ["pwa",      "צור"],
      ["frontend", "צור"],
      ["dashboard","צור"],
    ],
  },

  // Torah learning.
  // Sha'ar תו opens to roots of teaching/Torah.
  "torah-learning": {
    shaar: "תו",
    default_shoresh: "למד",   // l-m-d: to learn/teach
    meaning: "Torah / learning",
    keywords: [
      ["tanya",    "תני"],   // t-n-y: to teach/repeat
      ["rashi",    "פרש"],   // p-r-sh: to explain
      ["rambam",   "פסק"],   // p-s-k: to rule (halacha)
      ["halach",   "פסק"],
      ["tehilim",  "תהל"],   // t-h-l: praise
      ["psalm",    "תהל"],
      ["daven",    "פלל"],   // p-l-l: to pray
      ["tefil",    "פלל"],
      ["parsha",   "פרש"],
      ["parasha",  "פרש"],
      ["chumash",  "פרש"],
      ["omer",     "ספר"],   // s-p-r: to count
      ["count",    "ספר"],
      ["sefirot",  "ספר"],
      ["kabbal",   "סוד"],   // s-w-d: secret/mystery
      ["chassid",  "סוד"],
      ["mashiach", "משח"],   // m-sh-h: to anoint
      ["messianic","משח"],
      ["gemara",   "שלם"],   // sh-l-m: complete (talmud)
      ["talmud",   "שלם"],
      ["rebbe",    "רבב"],   // r-b-b: great/master
      ["ginsburg", "רבב"],
      ["tzimtzum", "צמצ"],   // ts-m-ts: contraction
      ["keter",    "כתר"],   // k-t-r: crown
    ],
  },

  // Commerce / business workflows.
  // Sha'ar קנ opens to roots of acquisition/commerce.
  "business-build": {
    shaar: "קנ",
    default_shoresh: "קנה",   // k-n-h: to acquire/buy
    meaning: "acquire / commerce",
    keywords: [
      ["lease",   "שכר"],    // s-k-r: hire/rent
      ["rent",    "שכר"],
      ["dealer",  "סחר"],    // s-h-r: trade/merchant
      ["trade",   "סחר"],
      ["vehicle", "רכב"],    // r-k-b: ride/vehicle
      ["car",     "רכב"],
      ["auto",    "רכב"],
      ["crm",     "כתב"],    // k-t-b: write/record
      ["data",    "כתב"],
      ["scrape",  "כתב"],
      ["payment", "שלם"],    // sh-l-m: pay/complete
      ["price",   "שלם"],
      ["rate",    "שלם"],
      ["call",    "קרא"],    // k-r-': to call
      ["voice",   "קרא"],
      ["ad",      "קרא"],
      ["twilio",  "קרא"],
    ],
  },

  // Care / client-service workflows.
  // Sha'ar רפ opens to roots of healing/restoration.
  "client-care": {
    shaar: "רפ",
    default_shoresh: "רפא",   // r-p-': to heal
    meaning: "heal / care",
    keywords: [
      ["schedul",  "מוע"],   // m-w-': appointed time (mo'ed)
      ["calendar", "מוע"],
      ["book",     "מוע"],
      ["client",   "אשה"],   // '-sh-h: woman (the clientele)
      ["women",    "אשה"],
      ["treatment","תקן"],   // t-k-n: fix/repair
      ["formula",  "תקן"],
      ["skin",     "עור"],   // '-w-r: skin
      ["face",     "עור"],
    ],
  },

  // Personal / family.
  // Sha'ar אה opens to roots of love/connection.
  "personal": {
    shaar: "אה",
    default_shoresh: "אהב",   // '-h-b: to love
    meaning: "love / personal / family",
    keywords: [
      ["wife",     "אשה"],
      ["family",   "בית"],   // b-y-t: house/family
      ["home",     "בית"],
      ["kid",      "ילד"],   // y-l-d: child
      ["child",    "ילד"],
      ["mother",   "אמם"],   // '-m-m: mother
      ["brother",  "אחה"],   // '-h-h: brother
      ["friend",   "רעה"],   // r-'-h: friend
      ["feel",     "רגש"],   // r-g-sh: feel
      ["relation", "חבר"],   // h-b-r: connect
    ],
  },

  // Voice work.
  // Sha'ar קל opens to roots of voice/sound.
  "voice-work": {
    shaar: "קל",
    default_shoresh: "קול",   // k-w-l: voice
    meaning: "voice / sound",
    keywords: [
      ["tts",     "דבר"],    // d-b-r: to speak
      ["stt",     "שמע"],    // sh-m-': to hear
      ["listen",  "שמע"],
      ["speak",   "דבר"],
      ["twilio",  "קרא"],    // k-r-': to call
      ["phone",   "קרא"],
    ],
  },

  // Tax / accounting.
  // Sha'ar מס opens to roots of count/tax.
  "tax": {
    shaar: "מס",
    default_shoresh: "מסס",   // m-s-s: assess/tax
    meaning: "tax / count",
    keywords: [
      ["book",   "ספר"],     // s-p-r: count/record
      ["ledger", "ספר"],
      ["cpa",    "חשב"],     // h-sh-b: think/reckon
      ["audit",  "בדק"],     // b-d-k: examine
    ],
  },

  // General — fallback / cross-cutting.
  // Sha'ar כל opens to roots of all/whole.
  "general": {
    shaar: "כל",
    default_shoresh: "כלל",   // k-l-l: include/general rule
    meaning: "general / all",
    keywords: [
      ["plan",    "יעץ"],    // y-'-ts: counsel/plan
      ["strategy","יעץ"],
      ["decide",  "פסק"],
      ["review",  "בדק"],
      ["status",  "פקד"],    // p-k-d: account/visit
      ["update",  "פקד"],
    ],
  },

  // Default bucket when category is null/unknown.
  _unknown: {
    shaar: "כל",
    default_shoresh: "כלל",
    meaning: "unclassified",
    keywords: [],
  },
});

/**
 * Pure function — given a session-index entry (or any object with
 * `category`, `episode_name`, `summary`), return the Sha'ar/Shoresh
 * coordinates inside the address book.
 */
export function deriveAddress(entry) {
  const category = (entry?.category ?? "_unknown").toLowerCase();
  const bucket = ADDRESS_BOOK[category] ?? ADDRESS_BOOK._unknown;

  const haystack = [
    entry?.episode_name ?? "",
    (entry?.summary ?? "").slice(0, 400),
  ]
    .join(" ")
    .toLowerCase();

  for (const [kw, root] of bucket.keywords) {
    if (haystack.includes(kw)) {
      return { shaar: bucket.shaar, shoresh: root };
    }
  }
  return { shaar: bucket.shaar, shoresh: bucket.default_shoresh };
}

// Short keywords need word-boundary matching to avoid false positives —
// e.g. "ui" lighting up inside "build". Longer keywords match as substrings.
const SHORT_KW_MAX_LEN = 3;

/**
 * Translation pass for the hook pre-pass:
 *   incoming English-ish user prompt -> set of {shaar, shoresh} pairs
 * that the user's turn likely lives at. Used to bias retrieval toward
 * sessions that share addresses with the live turn, AND to surface the
 * gate annotations on the wire so the agent can opt into deeper fetches
 * via the `memory-fetch(gate, root)` skill.
 *
 * MUST stay in sync with `~/ai/builds/gateway/src/shaar-shoresh.ts`.
 */
export function gatesForQuery(query) {
  const text = (query ?? "").toLowerCase();
  if (!text) return [];
  const tokens = new Set(text.split(/[^a-z0-9א-ת]+/).filter(Boolean));

  const hits = [];
  const seen = new Set();
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
