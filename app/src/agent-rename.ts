/**
 * The builder agent was renamed from Tzali to Zali (owner's ruling, 2026-11): the old name was hard to say and to
 * hear. This file is the ONLY place the old id lives, so an install made before the rename keeps working:
 *   - canonicalAgentId() maps the old id wherever one can still arrive (users.json, foreman records, old links);
 *   - aliasLegacyAgentEnv() lets an old .env (TZALI_BOT_TOKEN, TZALI_ENABLED, ...) keep configuring the agent;
 *   - migrateLegacyAgentHome() renames the agent's folders, files and JSON keys under the AHI home once, at startup.
 * Never overwrites and never deletes: where the new name already exists, the old one is left where it is.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const OLD = "tzali";
const NEW = "zali";
const MARKER = ".agent-renamed-zali";

export function canonicalAgentId(id: string): string {
  return id === OLD ? NEW : id;
}

/** TZALI_X=… also configures ZALI_X, unless ZALI_X is set. */
export function aliasLegacyAgentEnv(env: NodeJS.ProcessEnv = process.env): void {
  const prefix = `${OLD.toUpperCase()}_`;
  for (const key of Object.keys(env)) {
    if (!key.startsWith(prefix)) continue;
    const renamed = `${NEW.toUpperCase()}_${key.slice(prefix.length)}`;
    if (env[renamed] === undefined) env[renamed] = env[key];
  }
}

/** "tzali", "TZALI.md", "tzali:123", "Tzali-notes" → the same with the new name; anything else → null. */
function renamedName(name: string): string | null {
  const m = /^(tzali)(?=$|[.:_-])/i.exec(name);
  if (!m) return null;
  const head = m[1] === "TZALI" ? "ZALI" : m[1] === "Tzali" ? "Zali" : NEW;
  return head + name.slice(m[1].length);
}

/** Move `from` to `to`; when `to` is a folder that already exists, merge into it entry by entry. */
function moveEntry(from: string, to: string, log: (s: string) => void): void {
  if (!existsSync(to)) return renameSync(from, to);
  if (!statSync(from).isDirectory() || !statSync(to).isDirectory()) return log(`kept ${from}: ${to} already exists`);
  for (const e of readdirSync(from)) moveEntry(join(from, e), join(to, e), log);
  try { rmdirSync(from); } catch { /* not empty: a conflict was kept */ }
}

function walk(dir: string, visit: (path: string, name: string, isDir: boolean) => void): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, visit);
    visit(p, e.name, e.isDirectory());
  }
}

/** Rewrite object keys named after the old id and string values that are exactly the old id. */
function renameInJson(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") return value === OLD ? { value: NEW, changed: true } : { value, changed: false };
  if (Array.isArray(value)) {
    const out = value.map(renameInJson);
    return { value: out.map((o) => o.value), changed: out.some((o) => o.changed) };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const inner = renameInJson(v);
      const nk = renamedName(k);
      // On a key collision the new key's own value wins and the old key stays as it was.
      const key = nk && !(nk in obj) ? nk : k;
      out[key] = inner.value;
      changed ||= inner.changed || key !== k;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/** The JSON text with the old id renamed, or null when it is unchanged or not JSON (then it is left alone). */
function renameJsonText(text: string, pretty: boolean): string | null {
  try {
    const r = renameInJson(JSON.parse(text));
    if (!r.changed) return null;
    return pretty ? JSON.stringify(r.value, null, 2) + (text.endsWith("\n") ? "\n" : "") : JSON.stringify(r.value);
  } catch { return null; }
}

const SOUL_TEXT: Array<[RegExp, string]> = [[/ (?:— |\()צלי\)?/g, ""], [/\bTzali\b/g, "Zali"], [/\bTZALI\b/g, "ZALI"], [/\btzali\b/g, "zali"]];

/**
 * One pass over the AHI home (`aiRoot`: agents/, mission-control/) and the server's state folder: rename every path
 * named after the old id, rewrite the old id in JSON keys and values, and the agent's name in the soul files and the
 * agent registry the setup seeded. Runs once; a marker in the state folder records that it ran.
 */
export function migrateLegacyAgentHome(aiRoot: string, stateRoot: string, log: (s: string) => void = (s) => console.log(`[agent-rename] ${s}`)): void {
  const marker = join(stateRoot, MARKER);
  if (existsSync(marker)) return;
  let moved = 0, rewritten = 0;
  for (const root of [join(aiRoot, "agents"), join(aiRoot, "mission-control"), stateRoot]) {
    // Children before parents: a file's text is rewritten, then the file (and later its folder) is renamed.
    walk(root, (p, name, isDir) => {
      if (!isDir) rewritten += rewriteFile(p, name, aiRoot);
      const nn = renamedName(name);
      if (!nn) return;
      moveEntry(p, join(p, "..", nn), log);
      moved++;
    });
  }
  try { writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 }); } catch { /* state folder not writable: try again next start */ }
  if (moved || rewritten) log(`renamed ${moved} path(s) and rewrote ${rewritten} file(s) from ${OLD} to ${NEW}`);
}

/** Rewrite the old id inside one file: JSON / JSON-lines keys and values, or the name in seeded soul text. 1 if rewritten. */
function rewriteFile(p: string, name: string, aiRoot: string): number {
  const soulText = /\.md$/i.test(name) && (p.startsWith(join(aiRoot, "agents", "soul")) || name === "AGENT_REGISTRY.md");
  const jsonl = /\.jsonl$/i.test(name);
  if (!soulText && !jsonl && !/\.json$/i.test(name)) return 0;
  let text: string;
  try { text = readFileSync(p, "utf8"); } catch { return 0; }
  if (!/tzali/i.test(text)) return 0;
  let next: string | null;
  if (soulText) next = SOUL_TEXT.reduce((t, [re, s]) => t.replace(re, s), text);
  else if (jsonl) next = text.split("\n").map((line) => renameJsonText(line, false) ?? line).join("\n");
  else next = renameJsonText(text, true);
  if (next === null || next === text) return 0;
  writeFileSync(`${p}.renaming`, next, { mode: 0o600 });
  renameSync(`${p}.renaming`, p);
  return 1;
}
