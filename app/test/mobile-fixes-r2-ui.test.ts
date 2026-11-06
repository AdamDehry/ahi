/**
 * Mobile fixes round 2:
 *   (4) chat images are fixed boxes that show a tall picture's top, and a thumbnail shown far bigger than it is
 *       swaps to the full image (sharp, never a blurry strip)
 *   (5) a voice note is the bare floating player; the owner's is the same player, with no bubble around it
 *   (6) the viewer is portalled to <body> above every layer; swipe moves one image
 *   (7) the Shared page's Media tab is a thumbnail grid that never says "0 items" while loading
 * Layout itself is proved by the harness screenshots in REPORT.md; here, the rules and the logic.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

process.env.NODE_ENV = "development";
// MediaPanel reaches redesign modules that import stylesheets: load those as empty modules.
register("data:text/javascript," + encodeURIComponent('export async function load(u, c, next) { return u.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(u, c); }'));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { act, create, createElement, installReactGlobal } = await import("../web/test-support/renderer.js");
installReactGlobal();
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
(globalThis as Record<string, unknown>).document ??= { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
(globalThis as Record<string, unknown>).window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), location: { protocol: "https:", host: "app.test", href: "https://app.test/" }, addEventListener() {}, removeEventListener() {}, devicePixelRatio: 2 };
(globalThis as Record<string, unknown>).location ??= (globalThis.window as unknown as { location: unknown }).location;

const { sharpenOnLoad, thumbSrc } = await import("../web/src/lib/mediaFormat.js");
const { stepIndex, swipeStep } = await import("../web/src/components/ExpandedMedia.js");
const { default: MediaPanel } = await import("../web/src/components/MediaPanel.js");

const css = (p: string) => readFileSync(resolve(import.meta.dirname, "../web/src", p), "utf8");
const app = css("styles/app.css");
const media = css("redesign/media.css");
const rule = (sheet: string, sel: string) => {
  // The last rule that starts a line with exactly this selector (later rules win in the cascade).
  const at = sheet.lastIndexOf(`\n${sel} {`);
  assert.ok(at >= 0, `${sel} missing`);
  return sheet.slice(at, sheet.indexOf("}", at));
};

describe("(4) chat images", () => {
  it("tiles are fixed boxes showing the top of the picture, and a multi-image grid has a width cap", () => {
    assert.match(rule(app, ".sent-tile img"), /object-fit: cover; object-position: top/);
    assert.match(rule(app, ".sent-grid:not(.sent-grid--one) .sent-tile"), /aspect-ratio: 1/);
    assert.match(rule(app, ".sent-grid:not(.sent-grid--one)"), /max-width: 420px/);
    assert.doesNotMatch(rule(app, ".sent-grid--one .sent-tile img"), /contain/, "a lone tall image no longer letterboxes into a strip");
    const lone = rule(app, ".media-image img");
    assert.match(lone, /object-fit: cover; object-position: top/);
    assert.match(lone, /min-width: min\(calc\(var\(--media-thumb-max-h\) \* 3 \/ 4\), 100%\)/, "taller than 3:4 widens to 3:4");
  });

  const img = (natural: [number, number], shown: [number, number], src = "https://app.test/ui/media/p1/thumb") => ({ currentTarget: { naturalWidth: natural[0], naturalHeight: natural[1], clientWidth: shown[0], clientHeight: shown[1], src } }) as never;

  it("a thumbnail shown at more than twice its pixels swaps once to the full image; a photo stays on the thumbnail", () => {
    const tall = img([53, 320], [171, 171]); // a long page's thumbnail cropped into a phone tile
    sharpenOnLoad(tall, "p1");
    assert.equal((tall as { currentTarget: { src: string } }).currentTarget.src, "https://app.test/ui/media/p1");
    sharpenOnLoad(tall, "p1"); // the full image's own load: no loop
    assert.equal((tall as { currentTarget: { src: string } }).currentTarget.src, "https://app.test/ui/media/p1");
    const photo = img([320, 200], [117, 117]);
    sharpenOnLoad(photo, "p1");
    assert.equal((photo as { currentTarget: { src: string } }).currentTarget.src, "https://app.test/ui/media/p1/thumb");
    assert.equal(thumbSrc({ id: "a b", thumbnail: true }), "/ui/media/a%20b/thumb");
    assert.equal(thumbSrc({ id: "x" }), "/ui/media/x", "no thumbnail: the image itself");
  });
});

describe("(5) voice notes", () => {
  it("no outline around a whole note; the owner's note is the same pill at Michael's widths, with no bubble", () => {
    assert.doesNotMatch(media, /\.agent-run \.voice-note[^{]*\{[^}]*border: 1px/);
    const bubble = rule(media, ".rd-messages .bubble-user.has-voice, .rd-app.phone .bubble-user.has-voice");
    assert.match(bubble, /width: min\(400px, 100%\); max-width: none; padding: 0; border: 0; background: none/);
    assert.match(rule(media, ".rd-app.phone .bubble-user.has-voice"), /width: var\(--vn-mobile-max\)/, "the phone cap Michael's note uses");
    assert.match(rule(media, ".rd-messages .bubble-user .vn-bar, .rd-app.phone .bubble-user .vn-bar"), /background: var\(--surface\); border: var\(--hairline\) solid var\(--line\); border-radius: var\(--radius-chip\)/);
  });
});

describe("(6) the viewer", () => {
  it("is portalled to <body> and stacks above the modal layer; a backdrop click stops at it; a shrunk list clamps", () => {
    const src = css("components/ExpandedMedia.tsx");
    assert.match(src, /createPortal\([\s\S]*document\.body,\s*\)/);
    assert.match(src, /onClick=\{\(e\) => \{\s*stop\(e\);[^\n]*\n\s*close\(\);/);
    assert.match(src, /const at = Math\.min\(index, last\);\s*const current = items\[at\];/);
    assert.match(rule(app, ".expanded-media"), /z-index: calc\(var\(--z-modal\) \+ 10\)/);
    assert.match(rule(app, ".expanded-nav"), /display: flex/, "arrows on desktop");
    assert.match(rule(app, ":root:has(.rd-app.phone) .expanded-nav"), /display: none/, "the phone swipes");
  });
  it("a swipe moves one image: left → next, right → back; short or mostly-vertical moves do nothing", () => {
    assert.equal(swipeStep(-120, 10), 1);
    assert.equal(swipeStep(120, -10), -1);
    assert.equal(swipeStep(-40, 0), 0);
    assert.equal(swipeStep(-80, 200), 0);
  });
  it("after the list shrinks, Previous and Next step from the item shown, not from the old index", () => {
    // Open on the 5th of 5, then the list drops to 2: the viewer shows the 2nd (the clamp).
    assert.equal(stepIndex(4, -1, 2), 0, "Previous goes to the 1st, it does not stay put");
    assert.equal(stepIndex(4, 1, 2), 1, "Next stays on the last");
    assert.equal(stepIndex(1, -1, 3), 0);
    assert.equal(stepIndex(0, -1, 3), 0, "never before the first");
    assert.equal(stepIndex(2, 1, 3), 2, "never past the last");
  });
});

describe("(7) the Shared page", () => {
  let root: ReturnType<typeof create> | null = null;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
  });

  it("says Loading… (never 0 items) until the first page lands, then shows a grid of tiles with no name cards", async () => {
    let answer!: (r: Response) => void;
    (globalThis as Record<string, unknown>).fetch = () => new Promise<Response>((r) => (answer = r));
    await act(async () => {
      root = create(createElement(MediaPanel, { bot: "michael", mobile: true, page: true }));
    });
    const summary = () => root!.root.findAll((n) => n.props.className === "mp-summary")[0];
    assert.match(JSON.stringify(summary().children.map((c) => (typeof c === "string" ? c : (c as { children: unknown }).children))), /Loading…/);
    const video = { key: "kv", kind: "video", bot: "michael", messageId: "v", timestamp: "2026-11-06T09:00:00Z", direction: "out", sender: "Michael", media: { id: "v1", type: "video", originalName: "v.mp4", mime: "video/mp4", size: 1, thumbnail: true } };
    const items = [1, 2, 3].map((n) => ({ key: `k${n}`, kind: "image", bot: "michael", messageId: String(n), timestamp: "2026-11-06T09:00:00Z", direction: "out", sender: "Michael", media: { id: `p${n}`, type: "image", originalName: `p${n}.png`, mime: "image/png", size: 1, thumbnail: true } }));
    await act(async () => answer(new Response(JSON.stringify({ items: [...items, video], nextCursor: null }), { status: 200 })));
    await act(async () => {});
    const tiles = root!.root.findAll((n) => n.type === "button" && n.props.className === "mp-tile");
    assert.equal(tiles.length, 4);
    assert.equal(tiles[3].findByType("img").props.onLoad, undefined, "a video poster is never swapped for the video file (Codex review)");
    assert.equal(typeof tiles[0].findByType("img").props.onLoad, "function");
    assert.equal(root!.root.findAll((n) => typeof n.props.className === "string" && n.props.className.startsWith("mp-card")).length, 0, "no name cards");
    assert.equal(tiles[0].findByType("img").props.src, "/ui/media/p1/thumb");
  });

  it("its body never shrinks to the page (the 0px tiles), and tiles are square", () => {
    assert.match(rule(media, ".media-panel.is-page .mp-body"), /flex: none/);
    assert.match(rule(media, ".media-panel.is-page .mp-tile"), /aspect-ratio: 1/);
    assert.match(rule(media, ".rd-app.phone .media-panel.is-page .mp-grid"), /repeat\(3, minmax\(0, 1fr\)\)/);
  });
});
