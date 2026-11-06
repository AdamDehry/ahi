/**
 * Owner rules. The seed's owner column is free text written by a person;
 * these rules turn it into exactly one owner tag plus the honest extras
 * (who else has a stake, and a documented split when there is one).
 * Generic: "unknown" first, then a business or shared marker, else it's yours.
 */
import { OWNERS, type Owner } from "./types.js";

export interface OwnerTag {
  owner: Owner;
  shared_with: Owner[];
  split: Partial<Record<Owner, number>> | null;
}

export function tagOwner(label: string | null | undefined): OwnerTag {
  const t = (label ?? "").trim();
  const l = t.toLowerCase();
  const has = (s: string) => l.includes(s);
  if (!t || has("unknown")) return { owner: "unknown", shared_with: [], split: null };
  if (/\b(llc|inc|ltd|corp|company|business)\b/.test(l)) return { owner: "business", shared_with: [], split: null };
  if (/\b(shared|joint)\b/.test(l)) return { owner: "shared", shared_with: ["owner"], split: null };
  return { owner: "owner", shared_with: [], split: null };
}

export function assertOwner(x: unknown): Owner {
  if (typeof x === "string" && (OWNERS as readonly string[]).includes(x)) return x as Owner;
  throw new Error(`not an owner: ${String(x)}`);
}

/**
 * Netting. A figure belongs to its owner and nobody else. `perOwner` never
 * mixes pools. `lookThrough` is the ONE labelled exception: the owner's share
 * of an entity with a documented split is added to the owner's own line, and
 * the result is always labelled "look-through". Undocumented splits are never
 * guessed: the full figure stays on the tagged owner with the co-owner named
 * beside it.
 */
export interface Netted {
  owner: Owner;
  assets: number;
  liabilities: number;
  net: number;
  /** Count of figures that are unknown (null) and therefore NOT in the totals. */
  unknown_figures: number;
  known_figures: number;
}

export interface NettableLine {
  owner: Owner;
  side: "asset" | "liability" | "contingent";
  amount: number | null;
  split: Partial<Record<Owner, number>> | null;
}

export function netPerOwner(lines: NettableLine[]): Record<Owner, Netted> {
  const out = {} as Record<Owner, Netted>;
  for (const o of OWNERS) out[o] = { owner: o, assets: 0, liabilities: 0, net: 0, unknown_figures: 0, known_figures: 0 };
  for (const l of lines) {
    const n = out[l.owner];
    if (l.side === "contingent") continue;
    if (l.amount === null || !Number.isFinite(l.amount)) {
      n.unknown_figures++;
      continue;
    }
    n.known_figures++;
    if (l.side === "asset") n.assets += l.amount;
    else n.liabilities += l.amount;
  }
  for (const o of OWNERS) out[o].net = round2(out[o].assets - out[o].liabilities);
  for (const o of OWNERS) {
    out[o].assets = round2(out[o].assets);
    out[o].liabilities = round2(out[o].liabilities);
  }
  return out;
}

export interface LookThrough {
  label: "look-through";
  for: Owner;
  own: Netted;
  /** Each entity's documented share added, with the percentage used. */
  shares: Array<{ owner: Owner; pct: number; assets: number; liabilities: number; net: number }>;
  net: number;
}

export function lookThrough(lines: NettableLine[], who: Owner): LookThrough {
  const per = netPerOwner(lines);
  const shares: LookThrough["shares"] = [];
  const byEntity = new Map<Owner, { pct: number; assets: number; liabilities: number }>();
  for (const l of lines) {
    if (l.side === "contingent" || l.amount === null || !l.split) continue;
    const pct = l.split[who];
    if (!pct || l.owner === who) continue;
    const e = byEntity.get(l.owner) ?? { pct, assets: 0, liabilities: 0 };
    if (l.side === "asset") e.assets += (l.amount * pct) / 100;
    else e.liabilities += (l.amount * pct) / 100;
    byEntity.set(l.owner, e);
  }
  let net = per[who].net;
  for (const [owner, e] of byEntity) {
    const s = { owner, pct: e.pct, assets: round2(e.assets), liabilities: round2(e.liabilities), net: round2(e.assets - e.liabilities) };
    shares.push(s);
    net += s.net;
  }
  return { label: "look-through", for: who, own: per[who], shares, net: round2(net) };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
