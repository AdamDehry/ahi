/**
 * `[[search_images: <query>]]` / `[[search_web: <query>]]` — Michael showing
 * The owner real results, from any reply: a chat turn or a live call ("show me the
 * Sapphire Blue BRZ tS" → the pictures land in the thread behind the call).
 *
 * Same contract as `[[send_file:]]` (chat-files/sentinel.ts, which calls this
 * from takeSentinelFiles — the one call every reply path makes): the lines are
 * stripped from what the user sees, and the search runs in the background and
 * posts its card into the requesting user's chat with that agent. On a call
 * the line never reaches the voice: a bracketed line is an on-screen "work"
 * line (voice-tts-stream.ts looksTechnical).
 *
 * The existing WebSearch tool is untouched; this is the picture-capable route.
 */
import type { MessageEvent } from "../websocket.js";
import { buildCardEvent, type SearchService } from "./service.js";
import type { SearchKind } from "./providers.js";

export const SEARCH_SENTINEL_RE = /^[ \t]*\[\[search_(web|images):\s*([^\]\n]+?)\s*\]\][ \t]*$/gm;
/** A reply can put up at most this many cards; the rest are dropped (logged). */
export const MAX_PER_REPLY = 2;
/** Let the reply's own text land first, so the card sits under it. */
const POST_DELAY_MS = 400;

export interface SearchSentinelDeps {
  service: SearchService;
  user(userId: string): { userId: string; name: string; agents: string[]; telegramChatId: number | null } | null;
  broadcast(event: MessageEvent): void;
  botLabel(bot: string): string;
}

let live: SearchSentinelDeps | null = null;

/** Set once by installSearch; null in tests and when search is off. */
export function setSearchSentinelDeps(deps: SearchSentinelDeps | null): void {
  live = deps;
}

export function parseSearchLines(response: string): { cleaned: string; asks: Array<{ kind: SearchKind; query: string }> } {
  const asks: Array<{ kind: SearchKind; query: string }> = [];
  const re = new RegExp(SEARCH_SENTINEL_RE.source, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    asks.push({ kind: m[1] === "web" ? "web" : "images", query: m[2].trim() });
  }
  if (!asks.length) return { cleaned: response, asks };
  const cleaned = response.replace(new RegExp(`${SEARCH_SENTINEL_RE.source}\\r?\\n?`, "gm"), "").replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned, asks };
}

/** Run the asks and post their cards. Never throws. Returns cards posted. */
export async function runSearchAsks(
  opts: { userId: string; bot: string; asks: Array<{ kind: SearchKind; query: string }> },
  deps: SearchSentinelDeps | null = live,
  delayMs = POST_DELAY_MS,
): Promise<number> {
  if (!deps || !opts.asks.length || !opts.userId || opts.userId === "unknown") return 0;
  const user = deps.user(opts.userId);
  if (!user || !user.agents.includes(opts.bot)) return 0;
  if (opts.asks.length > MAX_PER_REPLY) console.warn(`[search] ${opts.bot} asked for ${opts.asks.length} searches in one reply; running the first ${MAX_PER_REPLY}`);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  let posted = 0;
  for (const ask of opts.asks.slice(0, MAX_PER_REPLY)) {
    try {
      const outcome = await deps.service.search(user.userId, ask.kind, ask.query, opts.bot);
      if (!outcome.ok) {
        console.warn(`[search] ${opts.bot}'s ${ask.kind} search not run: ${outcome.error}`);
        continue;
      }
      deps.broadcast(buildCardEvent({ bot: opts.bot, user, by: opts.bot, byName: deps.botLabel(opts.bot), outcome }));
      posted++;
    } catch (err) {
      console.warn(`[search] ${opts.bot}'s search failed: ${(err as Error).message}`);
    }
  }
  return posted;
}

/** Strip the lines; run their searches in the background. */
export function takeSearchLines(response: string, opts: { userId: string; bot: string }): string {
  if (!response.includes("[[search_")) return response;
  const { cleaned, asks } = parseSearchLines(response);
  if (asks.length) void runSearchAsks({ ...opts, asks });
  return cleaned;
}

/**
 * What a search-capable agent is told each turn (only when search is on and
 * the agent is in SEARCH_AGENTS, default "michael").
 */
export function searchAgentHint(
  bot: string,
  userId: string | null | undefined,
  userName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!live || !live.service.enabled()) return "";
  if ((env.SEARCH_AGENTS ?? "michael").split(",").map((s) => s.trim()).indexOf(bot) < 0) return "";
  if (!userId || userId === "unknown") return "";
  const { used, limit } = live.service.usage();
  const { perHour, cacheHours } = live.service.limits();
  return [
    `[INLINE SEARCH — real pictures and links in ${userName}'s chat]`,
    `When ${userName} should SEE results (pictures of a car, a product, a place; a set of links), put one line on its own in your reply:`,
    "[[search_images: <query>]]   or   [[search_web: <query>]]",
    "The line is hidden; a results card (picture grid or link list) lands in the chat a moment later, during a call too. At most two per reply. Write a short line of your own around it; don't describe the pictures before they arrive.",
    `To read results yourself first: node ${process.cwd()}/scripts/search.mjs --to ${userId} --images "<query>" (prints JSON and posts the card; add --no-post to only read).`,
    `Budget: ${used}${limit ? ` of ${limit}` : ""} searches used this month, ${perHour} an hour; repeats within ${cacheHours} hours are free. Your WebSearch tool is unchanged and is still the one for research.`,
  ].join("\n");
}
