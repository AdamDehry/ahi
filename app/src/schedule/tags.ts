/**
 * tags.ts — which block a piece of agent work belongs to.
 *
 * tags.json (Michael's, beside week.json):
 *   names  exact build name (redo suffixes dropped) → tag
 *   rules  [{ tag, words }] — first rule with a word in the name wins
 * A brief may also say `tag: sales` in its header; that beats both.
 * No match = null: the work still shows, in the background lane.
 */
import { runGroupKey } from "../review/ledger.js";

export interface TagRules {
  version: 1;
  note?: string;
  /** Tag → plain label. */
  tags: Record<string, string>;
  names: Record<string, string>;
  rules: Array<{ tag: string; words: string[] }>;
}

export function validateTags(raw: unknown): string[] {
  const t = raw as Partial<TagRules> | null;
  if (!t || typeof t !== "object") return ["not a JSON object"];
  const errs: string[] = [];
  if (t.version !== 1) errs.push("version must be 1");
  if (!t.tags || typeof t.tags !== "object" || Array.isArray(t.tags)) errs.push("tags missing");
  else if (Object.values(t.tags).some((v) => typeof v !== "string")) errs.push("every tag label must be text");
  if (t.names !== undefined && (!t.names || typeof t.names !== "object" || Array.isArray(t.names))) errs.push("names must be an object");
  else if (t.names && Object.values(t.names).some((v) => typeof v !== "string")) errs.push("every names entry must be a tag (text)");
  if (!Array.isArray(t.rules)) errs.push("rules must be a list");
  else
    t.rules.forEach((r, i) => {
      if (!r || typeof r.tag !== "string" || !Array.isArray(r.words) || r.words.some((w) => typeof w !== "string")) errs.push(`rules[${i}] needs tag + words`);
    });
  return errs;
}

/** The tag for a piece of work named `name` (a build name, a feed heading). */
export function tagFor(name: string, rules: TagRules, explicit?: string | null): string | null {
  if (explicit && explicit.trim()) return explicit.trim().toLowerCase();
  const key = runGroupKey(name.trim());
  const named = rules.names?.[key] ?? rules.names?.[name.trim().toLowerCase()];
  if (named) return named;
  const hay = name.toLowerCase();
  for (const r of rules.rules) if (r.words.some((w) => w && hay.includes(w.toLowerCase()))) return r.tag;
  return null;
}

export function tagLabel(tag: string | null, rules: TagRules): string {
  if (!tag) return "Other";
  return rules.tags[tag] ?? tag;
}
