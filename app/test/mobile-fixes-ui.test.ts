/**
 * Mobile fixes, in the hook harness:
 *   - a "Michael needs you" bar is keyed on the question, not on the card's
 *     activity time, so a dismissal holds until a NEW question arrives
 *   - dismissals are kept per user in storage (a refresh keeps them), and a
 *     storage that refuses the write still dismisses for the session
 *   - the bell's "Mark all as seen" (and opening a row) dismisses those bars too
 *   - a phone conversation is the full-screen mode; Back leaves it for the page
 *     before, or Home on a cold open
 */
import { strict as assert } from "node:assert";
import { register } from "node:module";
import { afterEach, describe, it } from "node:test";

process.env.NODE_ENV = "development";
// The bell imports the shell, which pulls in stylesheets: load those as empty modules here.
register("data:text/javascript," + encodeURIComponent('export async function load(u, c, next) { return u.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(u, c); }'));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { act, create, createElement, installReactGlobal } = await import("../web/test-support/renderer.js");
installReactGlobal();
const mem = new Map<string, string>();
let refuse = false;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (refuse) throw new Error("Access to storage is not allowed from this context.");
    mem.set(k, String(v));
  },
  removeItem: (k: string) => void mem.delete(k),
};
let backs = 0;
const storageListeners: Array<(e: { key: string }) => void> = [];
const history = { state: null as unknown, back: () => void backs++ };
(globalThis as Record<string, unknown>).document ??= { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
(globalThis as Record<string, unknown>).window ??= {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  location: { protocol: "https:", host: "app.test" },
  addEventListener(type: string, fn: (e: { key: string }) => void) {
    if (type === "storage") storageListeners.push(fn);
  },
  removeEventListener() {},
};
(globalThis.window as unknown as Record<string, unknown>).history = history;

const { attentionItems } = await import("../web/src/lib/ship.js");
const { actions, getState } = await import("../web/src/store.js");
const { default: AttentionBar } = await import("../web/src/components/AttentionBar.js");
const { default: BellInbox } = await import("../web/src/redesign/Bell.js");
const { leaveChat, phoneChatOpen } = await import("../web/src/redesign/history.js");
const { default: ChatHeader } = await import("../web/src/redesign/ChatHeader.js");

const OWNER = { userId: "owner", name: "Owner", admin: true, agents: ["michael"] } as never;
const OTHER = { userId: "guest", name: "Guest", admin: true, agents: ["michael"] } as never;
const question = (over: Record<string, unknown> = {}) => ({
  id: "bld-portal", title: "Client portal", kicker: "question", ask: "7 days or 30?", ask_record: "rec-1",
  last_activity_at: "2026-11-06T18:00:00Z", opened_at: "2026-11-06T17:00:00Z", ship: null, ...over,
});

let root: ReturnType<typeof create> | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  refuse = false;
});

describe("attention bar keys", () => {
  it("stay the same while the build works, change with a new question", () => {
    const [a] = attentionItems([question()]);
    const [busy] = attentionItems([question({ last_activity_at: "2026-11-06T18:05:00Z" })]);
    assert.equal(busy.key, a.key, "runner activity is not a new question");
    const [next] = attentionItems([question({ ask_record: "rec-2", ask: "Which colour?" })]);
    assert.notEqual(next.key, a.key, "a new needs_owner record is");
    const [old] = attentionItems([question({ ask_record: undefined })]);
    assert.equal(old.key, attentionItems([question({ ask_record: undefined, last_activity_at: "2026-11-06T19:00:00Z" })])[0].key, "no record id: keyed on the question text");
  });
});

describe("dismissals persist per user", () => {
  it("× survives a new read, a sign-out and back (the refresh path), and is the user's own", async () => {
    await act(async () => actions.loggedIn(OWNER));
    await act(async () => actions.setAttention(attentionItems([question()])));
    await act(async () => {
      root = create(createElement(AttentionBar, {}));
    });
    const x = root!.root.findAll((n) => n.type === "button" && n.props.className === "attn-x")[0];
    await act(async () => x.props.onClick());
    assert.equal(root!.toJSON(), null);
    await act(async () => actions.setAttention(attentionItems([question({ last_activity_at: "2026-11-06T18:09:00Z" })])));
    assert.equal(root!.toJSON(), null, "the same question with newer activity stays dismissed");
    assert.deepEqual(JSON.parse(mem.get("ahi-attn-dismissed:owner") ?? "[]"), [attentionItems([question()])[0].key]);

    await act(async () => actions.loggedOut());
    await act(async () => actions.loggedIn(OTHER));
    await act(async () => actions.setAttention(attentionItems([question()])));
    assert.notEqual(root!.toJSON(), null, "another user's bar is not dismissed by the owner's ×");

    await act(async () => actions.loggedOut());
    await act(async () => actions.loggedIn(OWNER));
    await act(async () => actions.setAttention(attentionItems([question()])));
    assert.equal(root!.toJSON(), null, "the owner's dismissal is read back from storage");
    await act(async () => actions.setAttention(attentionItems([question({ ask_record: "rec-9", ask: "Ship now?" })])));
    assert.match(JSON.stringify(root!.toJSON()), /Michael needs you — Client portal/, "a NEW question comes back");
  });

  it("a storage that refuses the write still dismisses for the session, without throwing", async () => {
    await act(async () => actions.loggedOut());
    await act(async () => actions.loggedIn({ userId: "blocked", name: "B", admin: true, agents: ["michael"] } as never));
    refuse = true;
    const [it1] = attentionItems([question({ id: "bld-x" })]);
    assert.doesNotThrow(() => actions.dismissAttention(it1.key));
    assert.ok(getState().attentionDismissed.includes(it1.key));
    assert.equal(mem.get("ahi-attn-dismissed:blocked"), undefined);
  });
});

describe("dismissals across two tabs of the same user (Codex review)", () => {
  it("another tab's dismissal shows here, and a later dismissal here never writes over it", async () => {
    await act(async () => actions.loggedOut());
    await act(async () => actions.loggedIn({ userId: "tabs", name: "T", admin: true, agents: ["michael"] } as never));
    const [a, b] = attentionItems([question({ id: "bld-a", ask_record: "ra" }), question({ id: "bld-b", ask_record: "rb" })]);
    // Tab B wrote its dismissal; the browser tells this tab.
    mem.set("ahi-attn-dismissed:tabs", JSON.stringify([a.key]));
    assert.ok(storageListeners.length > 0, "the store listens for other tabs");
    await act(async () => storageListeners.forEach((f) => f({ key: "ahi-attn-dismissed:tabs" })));
    assert.ok(getState().attentionDismissed.includes(a.key));
    // Another tab writes again, this time with NO event delivered (a missed or late event).
    mem.set("ahi-attn-dismissed:tabs", JSON.stringify([a.key, "ask:bld-z:rz"]));
    await act(async () => actions.dismissAttention(b.key));
    assert.deepEqual(JSON.parse(mem.get("ahi-attn-dismissed:tabs")!).sort(), [a.key, "ask:bld-z:rz", b.key].sort(), "merged, nothing lost");
    await act(async () => storageListeners.forEach((f) => f({ key: "ahi-attn-dismissed:someone-else" })));
    assert.ok(getState().attentionDismissed.includes(b.key), "another user's key is ignored");
  });
});

describe("bell → Mark all as seen", () => {
  it("dismisses the bars its build rows stand for", async () => {
    await act(async () => actions.loggedOut());
    await act(async () => actions.loggedIn({ userId: "bell", name: "Bell", admin: true, agents: ["michael"] } as never));
    const items = attentionItems([question({ id: "bld-a", ask_record: "ra" }), question({ id: "bld-b", ask_record: "rb" })]);
    const rows = items.map((a) => ({ key: `att:${a.key}`, cat: "work" as const, kicker: "Question", title: a.title, line: a.line, at: null, open() {}, attn: a.key }));
    await act(async () => {
      root = create(createElement(BellInbox, { rows, refresh() {}, onClose() {} }));
    });
    const mark = root!.root.findAll((n) => n.type === "button" && /^Marks them seen/.test(n.props.title ?? ""))[0];
    await act(async () => mark.props.onClick());
    assert.deepEqual([...getState().attentionDismissed].sort(), items.map((i) => i.key).sort());
    assert.deepEqual(JSON.parse(mem.get("ahi-attn-dismissed:bell") ?? "[]").sort(), items.map((i) => i.key).sort());
  });
});

describe("phone conversation mode", () => {
  it("is on only while a conversation is open and Settings is not", async () => {
    await act(async () => actions.setView("messages"));
    await act(async () => actions.openMobileThread("michael"));
    assert.equal(phoneChatOpen(getState()), true);
    await act(async () => actions.toggleSettings(true));
    assert.equal(phoneChatOpen(getState()), false);
    await act(async () => actions.toggleSettings(false));
    await act(async () => actions.popMobile());
    assert.equal(phoneChatOpen(getState()), false, "the agent list is not the conversation");
  });

  it("Back sits top-left; it steps back one page, or goes Home on a cold open", async () => {
    await act(async () => actions.setView("messages"));
    await act(async () => actions.openMobileThread("michael"));
    await act(async () => {
      root = create(createElement(ChatHeader, { bot: "michael", phone: true }));
    });
    const buttons = root!.root.findAll((n) => n.type === "button");
    assert.equal(buttons[0].props["aria-label"], "Back", "first control in the header");
    history.state = { ahi: 1 };
    backs = 0;
    await act(async () => buttons[0].props.onClick());
    assert.equal(backs, 1, "an in-app page is behind it: one history step");
    history.state = null;
    await act(async () => leaveChat());
    assert.equal(backs, 1);
    assert.equal(getState().view, "home", "nothing in-app behind it: Home");
    assert.equal(phoneChatOpen(getState()), false, "leaving restores the chrome");
  });
});
