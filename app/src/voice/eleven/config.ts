/* ============================================================
   eleven/config.ts — which transport a call uses, and the ElevenLabs
   Speech Engine settings the gateway reads.

   Voice step 3 (10/27): every app call is NATIVE — the gateway-owned call the
   phone already uses, where a broken socket is a door that re-attaches, not
   the end of the call (builds/voice-root-cause/REPORT.md §4). ElevenLabs
   stays intact as the one-flag rollback until step 4 deletes it, after two
   weeks of calls with no ending the owner didn't choose:

     VOICE_CALL_ROLLBACK=elevenlabs   app calls go back over the Speech Engine

   applied only to the agents in ELEVENLABS_CALL_BOTS (default "michael"),
   and only when the engine is configured (ELEVENLABS_API_KEY +
   ELEVENLABS_AGENT_ID + ELEVENLABS_LLM_SECRET, the header the engine must send
   on its upstream socket). Anything missing means native: the flag can never
   strand a call on a half-configured path, and the upstream socket is never
   open on their JWT alone (review, 10/22).

   The pre-step-3 switch, VOICE_CALL_TRANSPORT=elevenlabs, is the line in
   production's env since 10/22. It no longer decides anything — the flip ships
   with the code, not with an env edit nobody can review — and the boot log
   says so once (`staleTransportNote`). Deleting that line is tidy, not needed.

   Read per call, so the rollback is one env line plus a restart.
   ============================================================ */

export type CallTransportChoice = "elevenlabs" | "native";

/** Where ElevenLabs opens its upstream socket to us (the engine's ws_url path). */
export const ELEVEN_UPSTREAM_PATH = "/api/eleven/upstream";

/** The header the engine config sends on that socket (request_headers). */
export const ELEVEN_SECRET_HEADER = "x-ahi-eleven-secret";

/** Agents that may use the ElevenLabs transport when it is on. */
export function elevenCallBots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ELEVENLABS_CALL_BOTS ?? "michael")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** The engine is configured well enough to place a call: key, engine id, and the upstream secret. */
export function elevenEngineConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID && env.ELEVENLABS_LLM_SECRET);
}

/** VOICE_CALL_ROLLBACK=elevenlabs: the step-3 rollback lever is pulled. */
export function elevenRollbackOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.VOICE_CALL_ROLLBACK ?? "").trim().toLowerCase() === "elevenlabs";
}

/** The ElevenLabs transport can carry a call right now (rollback pulled, engine configured). */
export function elevenTransportOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return elevenRollbackOn(env) && elevenEngineConfigured(env);
}

/**
 * The boot line for an env that still carries the pre-step-3 switch: what it
 * used to do, what decides now. Null when there is nothing to say.
 */
export function staleTransportNote(env: NodeJS.ProcessEnv = process.env): string | null {
  const old = (env.VOICE_CALL_TRANSPORT ?? "").trim().toLowerCase();
  if (!old || old === "native") return null;
  return elevenRollbackOn(env)
    ? `VOICE_CALL_TRANSPORT=${old} is ignored since voice step 3; VOICE_CALL_ROLLBACK=elevenlabs is set, so app calls use ElevenLabs`
    : `VOICE_CALL_TRANSPORT=${old} is ignored since voice step 3: app calls are native (VOICE_CALL_ROLLBACK=elevenlabs puts them back)`;
}

export function callTransportFor(bot: string, env: NodeJS.ProcessEnv = process.env): CallTransportChoice {
  if (!elevenRollbackOn(env)) return "native";
  if (!elevenCallBots(env).includes(bot.toLowerCase())) return "native";
  if (!elevenEngineConfigured(env)) return "native";
  return "elevenlabs";
}

/** The subset of `bots` that call over ElevenLabs right now. */
export function elevenBotsAmong(bots: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return bots.filter((b) => callTransportFor(b, env) === "elevenlabs");
}

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Transcript arrived → when the front voice's line may be said if the answer
 * has not started. ELEVEN_FRONT_VOICE_DELAY_MS, else the native call's
 * FRONT_VOICE_DELAY_MS, else the native default (1.2 s).
 */
export function elevenFrontDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  return num(env.ELEVEN_FRONT_VOICE_DELAY_MS, num(env.FRONT_VOICE_DELAY_MS, 1_200));
}

/**
 * Nothing has been said this long after a transcript and no front line is
 * coming: say the shortest neutral holding line, so the engine's upstream
 * timeout (cascade_timeout_seconds, ≤ 15 s) never abandons the turn and
 * retries it. 0 disables.
 */
export function elevenHoldMs(env: NodeJS.ProcessEnv = process.env): number {
  return num(env.ELEVEN_HOLD_MS, 4_000);
}

/**
 * While a response is open and silent, a non-final chunk this often. 0 disables.
 *
 * Measured (eleven-call-stability, scripted upstream on the preview
 * engine): an EMPTY chunk does not reset the engine's 15 s retry; a space or
 * a lone period does — but no payload gets past the engine's ceiling on one
 * response: "Generating the LLM response took too long" ~45 s after the
 * transcript, whatever is sent. So a keepalive cannot hold a response open
 * through real work; responses end early instead (elevenMaxOpenMs) and the
 * rest of the turn is owed. The knob stays for experiments, off.
 */
export function elevenKeepaliveMs(env: NodeJS.ProcessEnv = process.env): number {
  return num(env.ELEVEN_KEEPALIVE_MS, 0);
}

/**
 * No response stays open longer than this without real spoken text: past it
 * the event is ended (what is held goes out first) and the rest of the turn
 * is owed to the next event. Well inside the engine's 15 s retry, so a silent
 * stretch of work never earns a retry, and never its TimeoutError (an event held open
 * 56 s through tool work ended a test call).
 */
export function elevenMaxOpenMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1_000, num(env.ELEVEN_MAX_OPEN_MS, 10_000));
}

/** However much text flows, a response ends this long after its transcript (the engine's own ceiling is ~45 s). */
export function elevenMaxResponseMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(5_000, num(env.ELEVEN_MAX_RESPONSE_MS, 30_000));
}

/**
 * Owed speech and no open event: ask the app to open one (it sends a "..."
 * user message — the same shape as the engine's own re-engage). Measured:
 * after an empty answer the engine sends nothing on its own for 70 s+
 * (pings only), so "the next re-engage" never comes; the app's "..." opened
 * an event at once and the owed line was audible ~150 ms later.
 * ELEVEN_NUDGE=off falls back to "said when he next speaks".
 */
export function elevenNudgeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ELEVEN_NUDGE ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/**
 * A grown line of his is a revision only while the turn answering the shorter
 * version is still running and nothing of it has been said; after that the
 * added words are a fresh line (eleven-revision-merge: his new
 * sentences were read as revisions and restarted the turn, 3-6 s lost each).
 * ELEVEN_REVISION_STRICT=off restores the earlier rule: every grown line is a
 * revision.
 */
export function elevenRevisionStrictOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ELEVEN_REVISION_STRICT ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/** An owed answer paid on his new words counts as said for that turn (already-said.ts). ELEVEN_ALREADY_SAID=off = the earlier behaviour. */
export function elevenAlreadySaidOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ELEVEN_ALREADY_SAID ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/**
 * The talk lane (eleven-talk-while-working): a question or conversation
 * heard while real work runs is answered at once by a tool-free companion
 * turn, beside the work. ELEVEN_TALK_LANE=off restores the earlier rule: it is
 * queued behind the work with a backchannel. Michael's knob.
 */
export function elevenTalkLaneOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ELEVEN_TALK_LANE ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/** How often a live call asks ElevenLabs whether the conversation is still going (when its socket is quiet). 0 disables. */
export function elevenStatusPollMs(env: NodeJS.ProcessEnv = process.env): number {
  return num(env.ELEVEN_STATUS_POLL_MS, 10_000);
}

/** The line said at `elevenHoldMs` when nothing else has been. */
export const ELEVEN_HOLD_LINE = "One sec.";
