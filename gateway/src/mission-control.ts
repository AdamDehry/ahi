import { readFileSync, writeFileSync, existsSync, statSync, watch, mkdirSync } from "fs";
import { resolve, join } from "path";
import { broadcastEvent } from "./websocket.js";

/**
 * Mission Control — file-based knowledge surface shown in the dashboard.
 *
 * Admin users see the canonical mission-control directory directly. Non-admin
 * users see their own scoped directory
 * at `$AHI_HOME/mission-control/<userId>/`, which is seeded with a minimal
 * template on first access if it doesn't exist yet. This keeps the operator's
 * AHI coordination files completely isolated from other users' personal
 * mission-control content.
 */
const MC_ROOT = process.env.MC_DIR ||
  resolve(process.env.AHI_HOME || resolve(process.env.HOME || "", "ahi"), "mission-control");

// Admin file whitelist — preserves the AHI coordination layout.
export const MC_FILES_ADMIN: { name: string; label: string; blurb: string }[] = [
  { name: "HANDOFF.md",       label: "Handoff",       blurb: "Active work, deadlines, blockers" },
  { name: "TODAY.md",         label: "Today",         blurb: "What shipped today and yesterday" },
  { name: "ACTIVITY_FEED.md", label: "Activity",      blurb: "Cross-agent progress log" },
  { name: "TODO.md",          label: "Todo",          blurb: "Backlog and next actions" },
  { name: "AGENT_REGISTRY.md", label: "Agents",       blurb: "Sub-agent roster and assignments" },
  { name: "ARCHITECTURE.md",  label: "Architecture",  blurb: "System architecture reference" },
];

// Backward-compat export — legacy code that imported `MC_FILES` expects
// the admin layout, so alias to that.
export const MC_FILES = MC_FILES_ADMIN;

// Per-user templates. Each entry: filename, label, blurb, and initial
// seed content. Seeds are intentionally minimal — placeholders so the
// user has somewhere to start once the operator sits with them to shape it.
interface MCTemplate {
  name: string;
  label: string;
  blurb: string;
  seed: string;
}

// Default template for any non-admin user.
const MC_TEMPLATES_DEFAULT: MCTemplate[] = [
  {
    name: "HANDOFF.md",
    label: "Handoff",
    blurb: "Active work and todos",
    seed: "# Handoff\n\n",
  },
  {
    name: "TODAY.md",
    label: "Today",
    blurb: "What's happening today",
    seed: "# Today\n\n",
  },
];

function templatesFor(userId: string): MCTemplate[] {
  return MC_TEMPLATES_DEFAULT;
}

/**
 * Resolve the mission-control root dir and file list for a given user.
 * Admin gets the canonical AHI layout at $AHI_HOME/mission-control/. Everyone
 * else gets a scoped dir at $AHI_HOME/mission-control/<userId>/, seeded on
 * first access with their templates.
 */
interface MCContext {
  dir: string;
  files: { name: string; label: string; blurb: string }[];
  allowed: Set<string>;
}

function ctxForUser(userId: string, admin: boolean): MCContext {
  if (admin) {
    return {
      dir: MC_ROOT,
      files: MC_FILES_ADMIN,
      allowed: new Set(MC_FILES_ADMIN.map((f) => f.name)),
    };
  }
  const dir = join(MC_ROOT, userId);
  const templates = templatesFor(userId);
  // Seed on first access.
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
      for (const t of templates) {
        const p = join(dir, t.name);
        if (!existsSync(p)) writeFileSync(p, t.seed);
      }
      console.log(`[mc] seeded ${userId} mission-control at ${dir}`);
    } catch (err) {
      console.warn(`[mc] failed to seed ${userId}: ${(err as Error).message}`);
    }
  } else {
    // Ensure any missing template files exist (idempotent top-up).
    for (const t of templates) {
      const p = join(dir, t.name);
      if (!existsSync(p)) {
        try {
          writeFileSync(p, t.seed);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return {
    dir,
    files: templates.map((t) => ({ name: t.name, label: t.label, blurb: t.blurb })),
    allowed: new Set(templates.map((t) => t.name)),
  };
}

export interface MCEntry {
  name: string;
  label: string;
  blurb: string;
  content: string;
  mtime: number;
  exists: boolean;
}

function readEntry(ctx: MCContext, f: { name: string; label: string; blurb: string }): MCEntry {
  const path = join(ctx.dir, f.name);
  if (!existsSync(path)) {
    return { name: f.name, label: f.label, blurb: f.blurb, content: "", mtime: 0, exists: false };
  }
  const content = readFileSync(path, "utf-8");
  const mtime = statSync(path).mtimeMs;
  return { name: f.name, label: f.label, blurb: f.blurb, content, mtime, exists: true };
}

export function listMissionControl(userId: string, admin: boolean): MCEntry[] {
  const ctx = ctxForUser(userId, admin);
  return ctx.files.map((f) => readEntry(ctx, f));
}

export function readMissionControlFile(
  userId: string,
  admin: boolean,
  name: string,
): MCEntry | null {
  const ctx = ctxForUser(userId, admin);
  if (!ctx.allowed.has(name)) return null;
  const meta = ctx.files.find((f) => f.name === name);
  if (!meta) return null;
  return readEntry(ctx, meta);
}

export function writeMissionControlFile(
  userId: string,
  admin: boolean,
  name: string,
  content: string,
): MCEntry | null {
  const ctx = ctxForUser(userId, admin);
  if (!ctx.allowed.has(name)) return null;
  const path = join(ctx.dir, name);
  writeFileSync(path, content);
  return readMissionControlFile(userId, admin, name);
}

/**
 * Debounced filesystem watcher for the ADMIN mission-control directory.
 * Non-admin scoped dirs aren't watched — per-user MC content is edited
 * infrequently and on-demand; dashboard reads on tab-open are sufficient.
 * If that assumption changes, extend this to walk each user's dir too.
 */
export function watchMissionControl(): void {
  const debounce: Record<string, NodeJS.Timeout> = {};

  for (const f of MC_FILES_ADMIN) {
    const path = join(MC_ROOT, f.name);
    if (!existsSync(path)) continue;
    try {
      watch(path, { persistent: false }, () => {
        clearTimeout(debounce[f.name]);
        debounce[f.name] = setTimeout(() => {
          const entry = readMissionControlFile("primary", true, f.name);
          if (entry) {
            broadcastEvent({ type: "mc-update", file: f.name, entry });
          }
        }, 150);
      });
      console.log(`[mc] watching ${f.name}`);
    } catch (err) {
      console.warn(`[mc] failed to watch ${f.name}:`, err);
    }
  }
}
