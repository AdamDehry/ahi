/**
 * `[[send_file: /abs/path]]` — an agent handing the user a file it made
 * (Miriam's PDFs, spreadsheets and booklets), delivered to the APP chat.
 *
 * Originally the sentinel was only understood on Telegram (telegram.ts
 * deliverSentinelFiles): in the app the user saw the raw marker line and no
 * file, and a file Miriam made during a Telegram turn never reached the app
 * thread at all. Here the sentinel is parsed once, the lines are stripped from
 * what the user sees, and each file is posted into the user's own app chat
 * through the same path agent file sends use (chat-files/service.ts).
 *
 * Scope: the file lands ONLY in the requesting user's chat with that agent
 * (checkRecipient). A non-admin user's agent may hand over files from its
 * output folder (~/ai/<user>-docs) or the user's own media/files — never an
 * arbitrary path on the box, so a prompt cannot pull another person's files
 * into her chat.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { multiUserPaths } from "../multi-user-paths.js";
import { sendAgentFiles, type ChatFilesDeps } from "./service.js";
import { applyBillSentinels, BILL_SENTINEL_RE } from "../bills.js";
import { takeSearchLines } from "../search/sentinel.js";
import { takeStudioLines } from "../studio/sentinel.js";

export const SEND_FILE_RE = /^[ \t]*\[\[send_file:\s*([^\]\n]+?)\s*\]\][ \t]*$/gm;

/** An older home prefix the soul files were written under (AHI_LEGACY_HOME_PREFIX); remapped to AHI_HOME. Unset = none. */
const MAC_HOME = process.env.AHI_LEGACY_HOME_PREFIX || "";

function ahiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AHI_HOME || homedir();
}

/**
 * A sentinel path as the box sees it. Miriam's soul still shows a Mac path in
 * its example; on the server that file lives under AHI_HOME instead.
 */
export function resolveSentinelPath(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  const p = raw.trim();
  if (MAC_HOME && p.startsWith(MAC_HOME) && !existsSync(p)) {
    const mapped = resolve(ahiHome(env), p.slice(MAC_HOME.length));
    if (existsSync(mapped)) return mapped;
  }
  return p;
}

export interface ParsedSentinels {
  /** The response with every sentinel line removed. */
  cleaned: string;
  /** Absolute paths that exist, in order, de-duplicated. */
  paths: string[];
  /** Sentinel paths that were relative or missing. */
  rejected: string[];
}

export function parseSendFileSentinels(response: string, env: NodeJS.ProcessEnv = process.env): ParsedSentinels {
  const paths: string[] = [];
  const rejected: string[] = [];
  const re = new RegExp(SEND_FILE_RE.source, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    const p = resolveSentinelPath(m[1], env);
    if (isAbsolute(p) && existsSync(p) && statSync(p).isFile()) {
      if (!paths.includes(p)) paths.push(p);
    } else rejected.push(m[1].trim());
  }
  if (!paths.length && !rejected.length) return { cleaned: response, paths, rejected };
  // Whole lines go, newline included, so no blank line is left where one was.
  const cleaned = response.replace(new RegExp(`${SEND_FILE_RE.source}\\r?\\n?`, "gm"), "").replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned, paths, rejected };
}

/** Folders a non-admin user's agent may hand files out of. */
export function allowedSendRoots(userId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = ahiHome(env);
  const p = multiUserPaths(userId);
  return [
    resolve(home, "ai", `${userId}-docs`), // ~/ai/family-docs — Miriam's generated files
    p.mediaRoot,
    p.filesRoot,
  ];
}

export function isAllowedSendPath(path: string, user: { userId: string; admin?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (user.admin) return true;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  return allowedSendRoots(user.userId, env).some((root) => {
    let r = root;
    try {
      r = realpathSync(root);
    } catch {
      /* a root that does not exist yet matches nothing real */
    }
    return real === r || real.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

let liveDeps: ChatFilesDeps | null = null;

/** Set once by installChatFiles; null in tests and when chat-files failed to start. */
export function setSentinelDeps(deps: ChatFilesDeps | null): void {
  liveDeps = deps;
}

/**
 * Posts each file into the user's app chat with this agent. Never throws:
 * a file that can't be delivered is logged and skipped.
 */
export async function deliverFilesToApp(
  opts: { userId: string; admin?: boolean; bot: string; paths: string[] },
  deps: ChatFilesDeps | null = liveDeps,
): Promise<number> {
  if (!deps || !opts.paths.length || !opts.userId || opts.userId === "unknown") return 0;
  let sent = 0;
  for (const path of opts.paths) {
    if (!isAllowedSendPath(path, { userId: opts.userId, admin: opts.admin })) {
      console.warn(`[chat-files] send_file refused for ${opts.userId}/${opts.bot}: outside the allowed folders: ${path}`);
      continue;
    }
    try {
      const data = await readFile(path);
      const r = await sendAgentFiles(deps, { to: opts.userId, bot: opts.bot, files: [{ name: basename(path), data }] });
      if (r.ok) {
        sent++;
        console.log(`[chat-files] send_file delivered to the app: ${opts.userId}/${opts.bot} ${basename(path)}`);
      } else console.warn(`[chat-files] send_file not delivered (${r.status} ${r.error}): ${path}`);
    } catch (err) {
      console.warn(`[chat-files] send_file failed for ${path}: ${(err as Error).message}`);
    }
  }
  return sent;
}

/**
 * `[[bill: {...}]]` lines (bills.ts): applied, in the background, to the bills
 * of the user this turn belongs to; returned text has them removed.
 */
export function takeBillLines(response: string, opts: { userId: string; bot: string }): string {
  if (!new RegExp(BILL_SENTINEL_RE.source, "m").test(response)) return response;
  void applyBillSentinels(response, opts).catch((err) => console.warn(`[bills] apply failed: ${(err as Error).message}`));
  return response.replace(new RegExp(`${BILL_SENTINEL_RE.source}\\r?\\n?`, "gm"), "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The one call every reply path makes: strips the sentinels from the text the
 * thread shows and, in the background, posts the files into the app chat.
 */
export function takeSentinelFiles(
  response: string,
  opts: { userId: string; admin?: boolean; bot: string },
): string {
  // `[[search_images: …]]` / `[[search_web: …]]` (search/sentinel.ts): a results card, in the background.
  // `[[studio_job: {…}]]` / `[[studio_decision: {…}]]` (studio/sentinel.ts): Avi's live studio, in the background.
  const parsed = parseSendFileSentinels(takeStudioLines(takeSearchLines(takeBillLines(response, opts), opts), opts));
  if (parsed.rejected.length) console.warn(`[${opts.bot}] send_file sentinel ignored (not abs or missing): ${parsed.rejected.join(", ")}`);
  if (parsed.paths.length) void deliverFilesToApp({ ...opts, paths: parsed.paths });
  return parsed.cleaned;
}

/**
 * What a document-making agent (Miriam) is told each turn about files, for
 * THIS server. Her soul says what she can make and defers to this note for
 * where to save and what is installed; the route reaches the user on
 * whichever surface she is on — the app chat or Telegram.
 */
export function agentFilesHint(
  bot: string,
  userId: string | null | undefined,
  userName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if ((env.FILE_AGENTS ?? "miriam").split(",").map((s) => s.trim()).indexOf(bot) < 0) return "";
  if (!userId || userId === "unknown") return "";
  const dir = resolve(ahiHome(env), "ai", `${userId}-docs`, "generated");
  return [
    `[FILES — making and sending files to ${userName} on this server]`,
    `Save every file you make for ${userName} under ${dir}/ (absolute path).`,
    "Make PDFs with python3 and reportlab, spreadsheets with python3 and openpyxl. If one is not installed, say so plainly and give the content in the chat instead.",
    "Then put one line per file on its own line in your reply: [[send_file: <absolute path>]]. It arrives as a real attachment in the chat she is using (the AHI app or Telegram); the line itself is hidden.",
    "Never send a file from outside that folder or the files she sent you.",
  ].join("\n");
}
