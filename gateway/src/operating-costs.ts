import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const CONFIG_PATH = process.env.OPERATING_COSTS_PATH
  || resolve(import.meta.dirname, "../config/operating-costs.json");

export type Bucket = "ai_automation" | "personal";
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

interface CostsFile {
  schema_version: number;
  updated: string;
  notes?: string;
  entries: CostEntry[];
}

const VALID_BUCKETS: Bucket[] = ["ai_automation", "personal"];
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

function validateEntryInput(body: Partial<CostEntry>): string | null {
  if (!body.service || typeof body.service !== "string" || !body.service.trim()) {
    return "service is required";
  }
  if (!body.category || typeof body.category !== "string" || !body.category.trim()) {
    return "category is required";
  }
  if (body.bucket && !VALID_BUCKETS.includes(body.bucket)) {
    return `bucket must be one of: ${VALID_BUCKETS.join(", ")}`;
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
  const err = validateEntryInput(input);
  if (err) return { ok: false, error: err };

  const file = loadCosts();
  const bucket: Bucket = (input.bucket && VALID_BUCKETS.includes(input.bucket)) ? input.bucket : "personal";
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
  const merged: Partial<CostEntry> = { ...existing, ...input, id };
  const err = validateEntryInput(merged);
  if (err) return { ok: false, error: err };

  const nextBucket: Bucket = (merged.bucket && VALID_BUCKETS.includes(merged.bucket)) ? merged.bucket : existing.bucket;

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

// Unused export — intentionally kept quiet
export { VALID_BUCKETS, VALID_COST_TYPES };
