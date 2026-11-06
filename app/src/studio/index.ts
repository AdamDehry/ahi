/**
 * Live studio — production wiring. The only file in src/studio/ that knows
 * the gateway's sockets, users, stores and env; the rest take them as deps.
 *
 * installStudio() never throws. It is on unless STUDIO_ENABLED=0; agents
 * with it: STUDIO_AGENTS (default "avi"). Engines that need a key (fal) say
 * so in Avi's hint and are refused until the key is in the gateway env.
 *
 * Env (all optional):
 *   STUDIO_ROOT        job folders (default ~/ai/studio — on this box, not
 *                      the Syncthing mirror, so generated video never fills
 *                      the Mac)
 *   STUDIO_GUIDES_DIR  the one-guide-per-use-case folder (default Avi's
 *                      canonical skills: ~/AHI/business/ahi/skills/avi-studio/guides)
 *   STUDIO_WORKER=0    turn the background-Avi engine off
 *   STUDIO_FIXTURE_DIR preview/tests ONLY: a "fixture" engine that copies
 *                      pictures from that folder. Logged loudly.
 */
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readdirSync, realpathSync } from "node:fs";
import type { Context, Hono } from "hono";
import { broadcast, broadcastUpdate } from "../websocket.js";
import { lookupByUserId } from "../users.js";
import { getMessagesForUser } from "../message-store.js";
import { mediaRef, registerMedia } from "../media-store.js";
import { ensureDir, multiUserPaths, safeSegment } from "../multi-user-paths.js";
import { mediaStorer } from "./cards.js";
import { FAL_MODELS, falEngine, fixtureEngine, workerEngine, type RunWorker, type StudioEngine } from "./engines.js";
import { registerStudioRoutes } from "./routes.js";
import { Studio, type StudioUser } from "./service.js";
import { setStudio } from "./sentinel.js";

export function studioAgents(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.STUDIO_AGENTS ?? "avi").split(",").map((s) => s.trim()).filter(Boolean);
}

export function studioRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.STUDIO_ROOT || join(env.AHI_AI_ROOT || join(env.AHI_HOME || homedir(), "ai"), "studio"));
}

export function studioGuidesDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.STUDIO_GUIDES_DIR || join(env.AHI_HOME || homedir(), "AHI", "business", "ahi", "skills", "avi-studio", "guides"));
}

/** Engines for this gateway. */
export function studioEngines(opts: { runWorker: RunWorker | null; env?: NodeJS.ProcessEnv }): Record<string, StudioEngine> {
  const env = opts.env ?? process.env;
  const list: StudioEngine[] = FAL_MODELS.map((m) => falEngine(m, { env }));
  if (env.STUDIO_WORKER !== "0") list.push(workerEngine(opts.runWorker));
  const fixture = env.STUDIO_FIXTURE_DIR?.trim();
  if (fixture) list.push(fixtureEngine(fixture));
  return Object.fromEntries(list.map((e) => [e.name, e]));
}

/** Is `path` (resolved, links followed) inside `root`? */
export function under(path: string, root: string): boolean {
  let real: string;
  let r = root;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  try {
    r = realpathSync(root);
  } catch {
    /* a root that does not exist matches nothing real */
  }
  return real === r || real.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** What the studio may read (refs it uploads to fal, option files it shows). */
export interface StudioRoots {
  /** STUDIO_ROOT — job folders, per user under it. */
  studioRoot: string;
  guidesDir: string;
  /** AHI_HOME — where ~/AHI lives. */
  home: string;
  /** This user's own chat uploads (media + files). */
  userUploads(userId: string): string[];
}

/**
 * The ONLY folders a studio ref or option may come from: a
 * ref is uploaded to fal, i.e. it leaves the machine, so a prompt-injected
 * reply must not be able to name a customer's licence scan or another
 * user's upload. No admin exception.
 *   - this user's studio folder;
 *   - the guides folder;
 *   - Avi's creative roots: ~/AHI/personal/creative and ~/AHI/business/ahi/skills/avi*;
 *   - this user's own chat uploads.
 */
export function studioAllowedRoots(userId: string, r: StudioRoots): string[] {
  const skills = join(r.home, "AHI", "business", "ahi", "skills");
  let avi: string[] = [];
  try {
    avi = readdirSync(skills, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("avi")).map((d) => join(skills, d.name));
  } catch {
    /* no skills folder on this machine */
  }
  return [join(r.studioRoot, safeSegment(userId, "unknown")), r.guidesDir, join(r.home, "AHI", "personal", "creative"), ...avi, ...r.userUploads(userId)];
}

/** Inside one of those folders once every link is followed (a link that points out is refused). */
export function isStudioPath(path: string, userId: string, r: StudioRoots): boolean {
  return studioAllowedRoots(userId, r).some((root) => under(path, root));
}

let current: Studio | null = null;

/** The running studio (null before install / when off). */
export function studioService(): Studio | null {
  return current;
}

export function installStudio(
  app: Hono<any>,
  resolveUser: (c: Context) => { userId: string } | null,
  opts: {
    stateDir: string;
    /** A background Avi turn (index.ts wires invokeAgent). */
    runWorker: RunWorker | null;
    /** Say a line on the user's live call with that agent. */
    announce?: (userId: string, bot: string, text: string) => boolean;
  },
): Studio | null {
  try {
    if (process.env.STUDIO_ENABLED === "0") {
      console.log("[studio] off (STUDIO_ENABLED=0)");
      return null;
    }
    const root = studioRoot();
    const engines = studioEngines({ runWorker: opts.runWorker });
    const roots: StudioRoots = {
      studioRoot: root,
      guidesDir: studioGuidesDir(),
      home: process.env.AHI_HOME || homedir(),
      userUploads: (userId) => {
        const p = multiUserPaths(userId);
        return [p.mediaRoot, p.filesRoot];
      },
    };
    const user = (id: string): StudioUser | null => {
      const u = lookupByUserId(id);
      return u ? { userId: u.userId, name: u.name, agents: u.agents, telegramChatId: u.telegramChatId, admin: u.admin } : null;
    };
    const botLabel = (bot: string): string => (bot.charAt(0).toUpperCase() + bot.slice(1));
    const studio = new Studio(
      {
        user,
        broadcast,
        broadcastUpdate,
        botLabel,
        thread: (bot, userId) => getMessagesForUser(bot, userId, 200),
        // The same confined folders for everyone, admins included (see studioAllowedRoots).
        isAllowedPath: (path, u) => isStudioPath(path, u.userId, roots),
        announce: opts.announce,
        agents: () => studioAgents(),
        storeMedia: mediaStorer({
          mediaDir: (userId, day) => multiUserPaths(userId).mediaDir(day),
          ensureDir,
          register: async ({ userId, bot, path, name, video }) =>
            mediaRef(await registerMedia({ userId, bot, source: "agent", type: video ? "video" : "image", filePath: path, originalName: name })),
        }),
      },
      engines,
      { root, statePath: join(opts.stateDir, "studio-jobs.json"), guidesDir: studioGuidesDir() },
    );
    registerStudioRoutes(app, { studio, resolveUser, agents: () => studioAgents() });
    setStudio(studio);
    current = studio;
    const settled = studio.settleLost();
    if (settled) console.log(`[studio] ${settled} card(s) of jobs lost at the last stop marked as failed`);
    const on = Object.values(engines).filter((e) => !e.unavailable()).map((e) => e.name);
    const off = Object.values(engines).filter((e) => e.unavailable()).map((e) => `${e.name} (${e.unavailable()})`);
    console.log(`[studio] up for ${studioAgents().join(", ")} · jobs in ${root} · engines on: ${on.join(", ") || "none"}${off.length ? ` · off: ${off.join("; ")}` : ""}`);
    if (engines.fixture) console.warn(`[studio] FIXTURE ENGINE — pictures from ${process.env.STUDIO_FIXTURE_DIR}. Never in production.`);
    return studio;
  } catch (err) {
    console.error("[studio] FAILED to start — gateway continues without it:", err);
    return null;
  }
}
