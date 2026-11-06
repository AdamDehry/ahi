import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const CONFIG_PATH = process.env.OPERATING_COSTS_PATH
  || resolve(process.env.HOME || "", "ai/gateway/config/operating-costs.json");

// Step 3d: buckets ("categories" in the UI) are dynamic — the three
// built-ins always exist; additional ones live in CostsFile.categories.
// Widened from the fixed union additively: every existing value remains valid.
export type Bucket = string;
export type CostType = "fixed" | "usage" | "subscription" | "free";

export interface CostEntry {
  id: string;
  service: string;
  bucket: Bucket;
  category: string;
  used_for: string | null;
  cost_type: CostType;
  monthly_cost_fixed: number | null;
  monthly_cost_estimate: number | null;
  billing_url: string | null;
  notes: string | null;
  duplicate_of?: string;
  active: boolean;
}

export interface CostCategory {
  key: string;
  label: string;
}

interface CostsFile {
  schema_version: number;
  updated: string;
  notes?: string;
  entries: CostEntry[];
  /** Step 3d (additive): user-defined categories beyond the built-ins.
   *  Absent on pre-3d files — old readers ignore it, and because every
   *  writer round-trips the loaded object, it survives old-code writes. */
  categories?: CostCategory[];
}

const VALID_BUCKETS: Bucket[] = ["ai_automation", "business", "personal"];
const BUILTIN_LABELS: Record<string, string> = {
  ai_automation: "AI Automation",
  business: "Business",
  personal: "Personal",
};
/** The reassignment home when a category is deleted. Never deletable. */
const DEFAULT_BUCKET: Bucket = "personal";

function knownBucketKeys(file: CostsFile): string[] {
  const keys = new Set<string>(VALID_BUCKETS);
  for (const c of file.categories ?? []) keys.add(c.key);
  for (const e of file.entries) keys.add(e.bucket); // defensive: data wins
  return [...keys];
}
const VALID_COST_TYPES: CostType[] = ["fixed", "usage", "subscription", "free"];

function emptyFile(): CostsFile {
  return {
    schema_version: 1,
    updated: new Date().toISOString().slice(0, 10),
    entries: [],
  };
}

function ensureDir(): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadCosts(): CostsFile {
  if (!existsSync(CONFIG_PATH)) {
    ensureDir();
    const empty = emptyFile();
    writeFileSync(CONFIG_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as CostsFile;
    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      console.warn(`[costs] malformed file — resetting to empty`);
      return emptyFile();
    }
    return parsed;
  } catch (err) {
    console.error(`[costs] failed to parse ${CONFIG_PATH}:`, err);
    return emptyFile();
  }
}

function saveCosts(file: CostsFile): void {
  ensureDir();
  file.updated = new Date().toISOString().slice(0, 10);
  writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2));
}

export function getEntries(): CostEntry[] {
  return loadCosts().entries;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || `entry-${Date.now().toString(36)}`;
}

function validateEntryInput(body: Partial<CostEntry>, known: string[] = VALID_BUCKETS): string | null {
  if (!body.service || typeof body.service !== "string" || !body.service.trim()) {
    return "service is required";
  }
  if (!body.category || typeof body.category !== "string" || !body.category.trim()) {
    return "category is required";
  }
  if (body.bucket && !known.includes(body.bucket)) {
    return `bucket must be one of: ${known.join(", ")}`;
  }
  if (body.cost_type && !VALID_COST_TYPES.includes(body.cost_type)) {
    return `cost_type must be one of: ${VALID_COST_TYPES.join(", ")}`;
  }
  if (body.monthly_cost_fixed !== null && body.monthly_cost_fixed !== undefined && typeof body.monthly_cost_fixed !== "number") {
    return "monthly_cost_fixed must be a number or null";
  }
  if (body.monthly_cost_estimate !== null && body.monthly_cost_estimate !== undefined && typeof body.monthly_cost_estimate !== "number") {
    return "monthly_cost_estimate must be a number or null";
  }
  if (body.billing_url !== null && body.billing_url !== undefined && typeof body.billing_url !== "string") {
    return "billing_url must be a string or null";
  }
  return null;
}

export function addPersonalEntry(input: Partial<CostEntry>): { ok: true; entry: CostEntry } | { ok: false; error: string } {
  const file = loadCosts();
  const known = knownBucketKeys(file);
  const err = validateEntryInput(input, known);
  if (err) return { ok: false, error: err };

  const bucket: Bucket = (input.bucket && known.includes(input.bucket)) ? input.bucket : DEFAULT_BUCKET;
  const baseId = slugify(`${bucket}-${input.service!}`);
  let id = baseId;
  let suffix = 2;
  while (file.entries.some((e) => e.id === id)) {
    id = `${baseId}-${suffix++}`;
  }

  const entry: CostEntry = {
    id,
    service: input.service!.trim(),
    bucket,
    category: (input.category || "").trim() || "Other",
    used_for: input.used_for?.toString().trim() || null,
    cost_type: input.cost_type || "subscription",
    monthly_cost_fixed: input.monthly_cost_fixed ?? null,
    monthly_cost_estimate: input.monthly_cost_estimate ?? null,
    billing_url: input.billing_url?.toString().trim() || null,
    notes: input.notes?.toString().trim() || null,
    active: input.active !== false,
  };

  file.entries.push(entry);
  saveCosts(file);
  return { ok: true, entry };
}

export function updatePersonalEntry(id: string, input: Partial<CostEntry>): { ok: true; entry: CostEntry } | { ok: false; error: string } {
  const file = loadCosts();
  const idx = file.entries.findIndex((e) => e.id === id);
  if (idx === -1) return { ok: false, error: `Entry not found: ${id}` };
  const existing = file.entries[idx];

  // Allow partial updates — validate only the fields present
  const known = knownBucketKeys(file);
  const merged: Partial<CostEntry> = { ...existing, ...input, id };
  const err = validateEntryInput(merged, known);
  if (err) return { ok: false, error: err };

  const nextBucket: Bucket = (merged.bucket && known.includes(merged.bucket)) ? merged.bucket : existing.bucket;

  const updated: CostEntry = {
    ...existing,
    bucket: nextBucket,
    service: merged.service!.trim(),
    category: (merged.category || "").trim() || "Other",
    used_for: merged.used_for === undefined ? existing.used_for : (merged.used_for?.toString().trim() || null),
    cost_type: merged.cost_type || existing.cost_type,
    monthly_cost_fixed: merged.monthly_cost_fixed === undefined ? existing.monthly_cost_fixed : (merged.monthly_cost_fixed ?? null),
    monthly_cost_estimate: merged.monthly_cost_estimate === undefined ? existing.monthly_cost_estimate : (merged.monthly_cost_estimate ?? null),
    billing_url: merged.billing_url === undefined ? existing.billing_url : (merged.billing_url?.toString().trim() || null),
    notes: merged.notes === undefined ? existing.notes : (merged.notes?.toString().trim() || null),
    active: merged.active === undefined ? existing.active : !!merged.active,
  };

  file.entries[idx] = updated;
  saveCosts(file);
  return { ok: true, entry: updated };
}

export function deletePersonalEntry(id: string): { ok: true } | { ok: false; error: string } {
  const file = loadCosts();
  const idx = file.entries.findIndex((e) => e.id === id);
  if (idx === -1) return { ok: false, error: `Entry not found: ${id}` };
  file.entries.splice(idx, 1);
  saveCosts(file);
  return { ok: true };
}

// ── Cost categories (Step 3d, additive) ─────────────────────────────

export interface CostCategoryInfo extends CostCategory {
  builtin: boolean;
}

export function listCostCategories(): CostCategoryInfo[] {
  const file = loadCosts();
  const overrides = new Map((file.categories ?? []).map((c) => [c.key, c.label]));
  const out: CostCategoryInfo[] = VALID_BUCKETS.map((key) => ({
    key,
    label: overrides.get(key) ?? BUILTIN_LABELS[key] ?? key,
    builtin: true,
  }));
  for (const c of file.categories ?? []) {
    if (!VALID_BUCKETS.includes(c.key)) out.push({ ...c, builtin: false });
  }
  // Defensive: buckets present on entries but registered nowhere still show.
  const listed = new Set(out.map((c) => c.key));
  for (const e of file.entries) {
    if (!listed.has(e.bucket)) {
      listed.add(e.bucket);
      out.push({ key: e.bucket, label: e.bucket, builtin: false });
    }
  }
  return out;
}

export function createCostCategory(label: string): { ok: true; category: CostCategoryInfo } | { ok: false; error: string } {
  const trimmed = (label ?? "").trim();
  if (!trimmed) return { ok: false, error: "Category name required" };
  const key = slugify(trimmed).replace(/-/g, "_");
  const file = loadCosts();
  if (knownBucketKeys(file).includes(key)) return { ok: false, error: `Category already exists: ${key}` };
  file.categories = [...(file.categories ?? []), { key, label: trimmed }];
  saveCosts(file);
  return { ok: true, category: { key, label: trimmed, builtin: false } };
}

export function renameCostCategory(key: string, label: string): { ok: true; category: CostCategoryInfo } | { ok: false; error: string } {
  const trimmed = (label ?? "").trim();
  if (!trimmed) return { ok: false, error: "Category name required" };
  const file = loadCosts();
  if (!knownBucketKeys(file).includes(key)) return { ok: false, error: `Category not found: ${key}` };
  const categories = file.categories ?? [];
  const idx = categories.findIndex((c) => c.key === key);
  // Built-ins rename via a label override entry; keys never change, so
  // existing entries (and the live public/ dashboard) keep working.
  if (idx >= 0) categories[idx] = { key, label: trimmed };
  else categories.push({ key, label: trimmed });
  file.categories = categories;
  saveCosts(file);
  return { ok: true, category: { key, label: trimmed, builtin: VALID_BUCKETS.includes(key) } };
}

/** Delete a category. Its entries are REASSIGNED to the default bucket —
 *  never deleted. The default bucket itself is protected. */
export function deleteCostCategory(key: string): { ok: true; reassigned: number } | { ok: false; error: string } {
  if (VALID_BUCKETS.includes(key)) return { ok: false, error: "Built-in categories cannot be deleted" };
  const file = loadCosts();
  if (!knownBucketKeys(file).includes(key)) return { ok: false, error: `Category not found: ${key}` };
  let reassigned = 0;
  for (const e of file.entries) {
    if (e.bucket === key) {
      e.bucket = DEFAULT_BUCKET;
      reassigned++;
    }
  }
  file.categories = (file.categories ?? []).filter((c) => c.key !== key);
  saveCosts(file);
  return { ok: true, reassigned };
}

// Unused export — intentionally kept quiet
export { VALID_BUCKETS, VALID_COST_TYPES };
