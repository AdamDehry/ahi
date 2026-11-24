/**
 * Languages: every catalog (the web app's, the desktop app's) is complete in Hebrew, and the pieces that
 * carry the owner's choice to the server, the agents and the voice behave.
 */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const { AREAS } = await import("../web/src/i18n/catalog/index.js");
const i18n = await import("../web/src/i18n/index.js");
const desktop = createRequire(import.meta.url)("../onboarding/ui/i18n.js") as {
  STRINGS: Record<"en" | "he", Record<string, string>>;
  t: (lang: string, key: string, params?: Record<string, unknown>) => string;
  systemLang: (list: string[]) => string;
};

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** The checks every catalog passes: same keys, nothing empty, the same placeholders, arrows turned. */
function checkCatalog(name: string, en: Record<string, string>, he: Record<string, string>): void {
  const missing = Object.keys(en).filter((k) => !(k in he));
  assert.deepEqual(missing, [], `${name}: keys without a Hebrew translation`);
  const extra = Object.keys(he).filter((k) => !(k in en));
  assert.deepEqual(extra, [], `${name}: Hebrew keys with no English source`);
  for (const [k, v] of Object.entries(en)) {
    const h = he[k];
    assert.ok(v.trim() && h?.trim(), `${name}: ${k} is empty`);
    // A "_one" form may say the count in words ("לפני דקה") instead of {n}.
    const enP = placeholders(v).filter((p) => !(k.endsWith("_one") && p === "n"));
    const heP = placeholders(h).filter((p) => !(k.endsWith("_one") && p === "n"));
    assert.deepEqual(heP, enP, `${name}: ${k} has different placeholders in Hebrew`);
    if (v.includes("→") && !v.includes("←")) assert.ok(h.includes("←") && !h.includes("→"), `${name}: ${k} — a forward arrow points left in Hebrew`);
    if (v.includes("←") && !v.includes("→")) assert.ok(h.includes("→") && !h.includes("←"), `${name}: ${k} — a back arrow points right in Hebrew`);
  }
}

describe("web catalog", () => {
  it("every area is complete in Hebrew, with matching placeholders and turned arrows", () => {
    for (const [area, cat] of Object.entries(AREAS)) checkCatalog(`web/${area}`, cat.en, cat.he);
  });

  it("every key lives in its own area's file, once", () => {
    const seen = new Map<string, string>();
    for (const [area, cat] of Object.entries(AREAS)) {
      for (const k of Object.keys(cat.en)) {
        assert.ok(k.startsWith(`${area}.`), `${k} is in ${area}.ts but named for another area`);
        assert.ok(!seen.has(k), `${k} is defined in both ${seen.get(k)} and ${area}`);
        seen.set(k, area);
      }
    }
  });

  it("t() fills placeholders, isolates them in Hebrew, and switches with the language", () => {
    i18n.setLang("en", false);
    assert.equal(i18n.t("common.minutesAgo_other", { n: 1200 }), "1,200 minutes ago");
    assert.equal(i18n.tn("common.minutesAgo", 1), "1 minute ago");
    i18n.setLang("he", false);
    assert.equal(i18n.isRtl(), true);
    assert.equal(i18n.locale(), "he-IL");
    assert.equal(i18n.tn("common.minutesAgo", 1), "לפני דקה");
    assert.equal(i18n.tn("common.minutesAgo", 5), "לפני ⁨5⁩ דקות");
    i18n.setLang("en", false);
  });
});

describe("desktop catalog", () => {
  it("is complete in Hebrew, with matching placeholders and turned arrows", () => {
    checkCatalog("desktop", desktop.STRINGS.en, desktop.STRINGS.he);
  });

  it("every key the desktop app asks for exists", () => {
    const root = resolve(import.meta.dirname, "../onboarding");
    const files = [...readdirSync(join(root, "ui")).filter((f) => f.endsWith(".js") && f !== "i18n.js").map((f) => join(root, "ui", f)),
      ...readdirSync(join(root, "src")).filter((f) => f.endsWith(".cjs")).map((f) => join(root, "src", f))];
    const used = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // tr('key'), t(lang,'key'), t(this.language,'key'), data-i18n="key"
      for (const m of src.matchAll(/\btr\(\s*['"`]([\w.]+)['"`]|\bt\([^,()]*(?:\([^)]*\))?,\s*['"`]([\w.]+)['"`]|data-i18n="([\w.]+)"/g)) used.add(m[1] ?? m[2] ?? m[3]);
    }
    for (const f of readdirSync(join(root, "ui")).filter((f) => f.endsWith(".html"))) {
      for (const m of readFileSync(join(root, "ui", f), "utf8").matchAll(/data-i18n(?:-html)?="([\w.]+)"/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !(k in desktop.STRINGS.en));
    assert.deepEqual(missing, [], "keys used but not in ui/i18n.js");
    assert.ok(used.size > 10);
  });

  it("follows the system language and isolates values in Hebrew", () => {
    assert.equal(desktop.systemLang(["he-IL", "en-US"]), "he");
    assert.equal(desktop.systemLang(["iw"]), "he");
    assert.equal(desktop.systemLang(["fr-FR"]), "en");
    assert.equal(desktop.t("he", "signin.failed", { status: 502 }).includes("⁨502⁩"), true);
    assert.equal(desktop.t("en", "signin.failed", { status: 502 }), "AHI could not sign you in (it answered 502). Press Retry.");
  });
});

describe("server: the language reaches the agents and the voice", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahi-i18n-"));
  const prev = process.env.AHI_GATEWAY_STATE_DIR;
  process.env.AHI_GATEWAY_STATE_DIR = dir;
  after(() => {
    if (prev === undefined) delete process.env.AHI_GATEWAY_STATE_DIR;
    else process.env.AHI_GATEWAY_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves each user's language and leaves others alone", async () => {
    const prefs = await import("../src/ui-prefs.js");
    assert.equal(prefs.userLanguage("dana"), undefined);
    prefs.setUserLanguage("dana", "he");
    prefs.setUserLanguage("sam", "en");
    assert.equal(prefs.userLanguage("dana"), "he");
    assert.equal(prefs.userLanguage("sam"), "en");
    assert.equal(prefs.isLanguage("fr"), false);
  });

  it("tells the agents to answer in Hebrew, and stays silent for English", async () => {
    const { languageLine } = await import("../src/time-context.js");
    const line = languageLine({ userId: "dana", name: "Dana" });
    assert.match(line ?? "", /Answer in Hebrew by default; when they write to you in another language, answer in theirs\./);
    assert.equal(languageLine({ userId: "sam", name: "Sam" }), null);
    assert.equal(languageLine({ userId: "nobody", name: "Nobody" }), null);
  });

  it("hears Hebrew: OpenAI instead of Cartesia's English-only live model, and a Hebrew recognizer", async () => {
    const { hebrewCapable, voiceSttLanguage } = await import("../src/voice/stt-select.js");
    assert.equal(hebrewCapable("cartesia", "he", { OPENAI_API_KEY: "set" }), "openai");
    assert.equal(hebrewCapable("cartesia", "he", {}), "cartesia", "no OpenAI key: calls keep working on Cartesia");
    assert.equal(hebrewCapable("cartesia", "en", { OPENAI_API_KEY: "set" }), "cartesia");
    assert.equal(voiceSttLanguage("michael", {}, "he"), "he");
    assert.equal(voiceSttLanguage("michael", {}, "en"), "en");
    assert.equal(voiceSttLanguage("michael", { VOICE_STT_LANGUAGE: "auto" }, "he"), undefined, "an explicit setting still wins");
  });

  it("speaks Hebrew text as Hebrew on Cartesia", async () => {
    const { cartesiaLanguage, isMostlyHebrew } = await import("../src/speech-language.js");
    assert.equal(isMostlyHebrew("שלום, מה שלומך?"), true);
    assert.equal(isMostlyHebrew("Hello there"), false);
    assert.equal(cartesiaLanguage("en", "שלום, מה שלומך?"), "he");
    assert.equal(cartesiaLanguage("en", "Hello there"), "en");
    assert.equal(cartesiaLanguage("fr", "שלום"), "fr", "a configured language is kept");
  });
});
