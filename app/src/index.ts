import { Hono } from "hono";
import { dropMessage, dropSummary } from "./voice/call-drop.js";
import { asksToLook, estimateImageTokens, framePolicy, type ScreenFrame } from "./voice/screen-frame.js";
import { formatPick, type WatchPick } from "./voice/screen-watch.js";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { migrateLegacyAgentHome } from "./agent-rename.js";
import { AI_ROOT } from "./ai-root.js";
import { createBot, setupWebhook, startPolling, type BotInstance } from "./telegram.js";
import { appChatId, createDashboard, resolveUser, tagDashboardMessageForBot } from "./dashboard.js";
import { takeSentinelFiles } from "./chat-files/sentinel.js";
import { installReviewDesk } from "./review/index.js";
import { installSchedule } from "./schedule/index.js";
import { installVault } from "./vault/index.js";
import { installCodexLive } from "./codex-live/index.js";
import { installForemanMessages } from "./foreman-messages/index.js";
import { installChatFiles } from "./chat-files/index.js";
import { installSearch } from "./search/index.js";
import { registerFolderRoutes } from "./working-folders.js";
import { registerDocTreeRoutes } from "./doc-tree.js";
import { registerGmailRoutes } from "./gmail/gmail.js";
import { gatewayStateRoot } from "./multi-user-paths.js";
import { installStudio } from "./studio/index.js";
import { workerMessage } from "./studio/engines.js";
import { installPhone } from "./phone/install.js";
import { markVoiceCallEnded, voiceCallEnded } from "./voice/ended-calls.js";
import { beginWorkingTurn, describeWork, turnsInFlight, type WorkingTurn } from "./voice/turn-liveness.js";
import { backchannel, classifyWhileWorking, queuesWhileWorking, statusLine } from "./voice/work-gate.js";
import { BARGE_NOTE, MERGE_NOTE, QUEUED_NOTE, TurnBook, bargeNote, cutNoteMs, formatRoute, joinPieces, type RunningTurn } from "./voice/turn-taking.js";
import { CallCuts } from "./voice/heard-cut.js";
import {
  handleUpgrade,
  setVoiceTurnHandler,
  setVoiceTentativeHandler,
  setVoiceDraftHandler,
  setVoiceInterruptHandler,
  setVoiceSpecCancelHandler,
  setVoiceSessionOpenHandler,
  setVoiceSessionCloseHandler,
  setVoiceSessionRecordHandler,
  setVoiceModeEnabled,
  recordVoiceAgentTurn,
  recentVoiceLines,
  callTalking,
  trimVoiceAgentTurn,
  lastVoiceAgentLine,
  voiceAgentTurnEnded,
  setVoiceCommandHandler,
  broadcast,
  announceRestart,
  liveCallCount,
  restoreLiveCalls,
  liveCallFor,
  type VoiceSessionRecord,
} from "./websocket.js";
import type { UserConfig } from "./users.js";
import { installElevenTransport } from "./voice/eleven/install.js";
import { elevenTransportOn, staleTransportNote } from "./voice/eleven/config.js";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { resolve as resolvePath } from "path";
import { applySavedSettings } from "./bot-settings.js";
import { logClaudeBinAtStartup } from "./claude-bin.js";
import { watchMissionControl } from "./mission-control.js";
import { transcribeAudio } from "./voice-in.js";
import { invokeAgent } from "./claude-invoke.js";
import { registerGlassesRoutes } from "./glasses.js";
import { getDegradedStates, getLiveDiskFreeGb, getSelfHealedEvents } from "./degraded-notifier.js";
import { withBotSlot, ConcurrencyCapError } from "./concurrency.js";
import { synthesizeSpeech } from "./voice-out.js";
import { SpokenTextFeed, type CallTtsStream } from "./voice-tts-stream.js";
import { callTtsProviderFor, createCallTtsStream, fillerSampleRate, renderFillerPcm, streamFillerPcm, type CallTtsProvider } from "./voice/call-tts.js";
import { agentDisplayName, frontLineFor, rememberFrontLine, RacedFrontVoice, FRONT_VOICE_MODEL_DEFAULT } from "./voice/front-voice.js";
import { userEffectiveZone } from "./time-context.js";
import { FrontGate, bareBeat, bridgeOn, frontGateFor, gateClockLine, gateLine, fastAnswersNote, type GateClaim, type GateLine } from "./voice/front-gate.js";
import { HoldLineBank, holdLines, holdMs } from "./voice/hold-line.js";
import {
  AnswerLadder,
  dropSecondStall,
  holdOncePerThought,
  holdThoughtMs,
  holdWaitsForSilence,
  isBareBeat,
  isBareStall,
  ladderAskFloorMs,
  ladderAskMs,
  ladderBridgeWaitMs,
  ladderClaimMs,
  ladderGraceMs,
  queuedTurnHolds,
} from "./voice/answer-ladder.js";
import { GateDrafts, draftIsGuess, draftOneLane, gateDraftOn, type GateDraft } from "./voice/gate-draft.js";
import { loopWatch, startLoopWatch } from "./voice/loop-watch.js";
import { createAckClassifier, decideAck, echoProtection, looksLikeEcho, silentAcksEnabled } from "./voice/ack-gate.js";
import { cutPlayout, forgetPlayout, heardDuringPlayout } from "./voice/echo-window.js";
import { mouthFor } from "./voice/mouth.js";
import { ECHO_SHARE, echoShare, echoWindow, echoWords, formatEchoVerdict, oldEchoRules } from "./voice/echo-rule.js";
import type { CallTransport } from "./voice/call-transport.js";
import { TurnIntake } from "./voice/turn-intake.js";
import { TurnAudioSequencer, fillerOptions, runFrontVoiceTurn, type FrontVoiceTurnResult } from "./voice/turn-audio.js";
import { voiceTurnInvokeOptions } from "./voice/voice-invoke.js";
import { recordStartupAndCheckThrottle } from "./crash-throttle.js";
import { acquireSingletonLockOrExit } from "./singleton.js";
import { installShutdownGuard } from "./turn-journal.js";
import { installTurnResume } from "./turn-resume-install.js";
import { installLifecycle } from "./lifecycle.js";
import {
  abortSpeculativeTurn,
  attachSpeculativeTts,
  commitSpeculativeTurn,
  getSpeculativeTurn,
  startSpeculativeTurn,
} from "./spec-state.js";
import { normalizedLevenshtein } from "./levenshtein.js";
import { isRuntimeSpeculationEnabled, logTurn } from "./turn-logger.js";
import { makeTurnGate, type TurnGate } from "./voice/turn-gate.js";
import { setVoiceSttProvider } from "./voice/stt-select.js";

// ── OS-level singleton ───────────────────────────────────────────────────────
// BEFORE anything else: enforce that only one gateway process exists. The
// per-process concurrency cap in concurrency.ts is useless if two processes
// are both polling — each has its own cap, effective concurrency doubles.
// Lockfile at ~/ai/logs/gateway.pid. Exits(1) loudly if another live gateway
// owns the lock; reaps stale PIDs from crashed predecessors. See singleton.ts.
acquireSingletonLockOrExit();
// Right after the lock (whose SIGTERM/SIGINT handlers do the exiting): say how
// the last process died, start this one's heartbeat, shield it from the OOM
// killer's coin toss (lifecycle.ts).
installLifecycle({ liveCalls: allLiveCalls });
// After the lock's SIGTERM/SIGINT exit handlers exist: from the first signal
// on, a dying turn's cut-short reply never clears its in-flight marker.
installShutdownGuard();
// A planned restart (systemd sends SIGTERM) is announced to every open app
// before the singleton's exit handler runs — the header says RESTARTING, not
// RECONNECTING. Prepended so it runs first. SIGINT (a hand Ctrl-C) is not a
// restart and keeps today's behaviour.
process.prependListener("SIGTERM", () => {
  try {
    const told = announceRestart();
    if (told) console.log(`[gateway] SIGTERM — told ${told} app socket(s) we are restarting`);
  } catch (err) {
    console.error("[gateway] restart announcement failed (exiting anyway):", err);
  }
});

// ── Crash-loop throttle ──────────────────────────────────────────────────────
// First thing we do at startup: record the timestamp and check if we've been
// restarting in a hot loop. If 3+ startups within 5min, write a loud marker
// file so the owner knows on next glance. Protection #4 — see crash-throttle.ts.
const throttle = recordStartupAndCheckThrottle();
if (throttle.crashLoop) {
  console.error(
    `[gateway] CRASH LOOP DETECTED — ${throttle.recentCount} startups in last ${throttle.windowMs / 60000}min. ` +
    `See ~/ai/logs/gateway.CRASHED-REPEATEDLY. Continuing boot but flagging loudly.`,
  );
}

// ── Global crash guard ───────────────────────────────────────────────────────
// A rejected Telegram API call (e.g. message too long → 400 Bad Request) used
// to bubble up through a grammY middleware and take the whole Node process
// down. The LaunchAgent then restarted us, the same pending update was
// redelivered, and we'd crash again — an infinite crash-loop that wedged all
// five bots. Catch async errors at the process boundary so one bad reply
// never takes the gateway offline. (See H-019 Step 7 post-mortem.)
process.on("uncaughtException", (err) => {
  console.error("[gateway] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  // Benign 409 Conflict from getUpdates polling overlap during restart should
  // already be caught by the supervisor in startPolling(). If one slips past
  // (e.g. a race during startup), don't dump a full stack — it's noise that
  // makes real errors harder to spot. Log a single greppable WARN line.
  const r = reason as { error_code?: number; description?: string; message?: string } | undefined;
  const isConflict =
    !!r &&
    (r.error_code === 409 ||
      /Conflict: terminated by other getUpdates/i.test(r.description ?? "") ||
      /Conflict: terminated by other getUpdates/i.test(r.message ?? ""));
  if (isConflict) {
    console.warn("[gateway-409-suppressed] bot=? reason=getUpdates-conflict (top-level handler)");
    return;
  }
  console.error("[gateway] unhandledRejection:", reason);
});

// Before anything reads agent state: an install from before the builder's rename gets its folders and keys renamed.
migrateLegacyAgentHome(AI_ROOT, gatewayStateRoot());
const config = loadConfig();
applySavedSettings(config.bots);
watchMissionControl();
void logClaudeBinAtStartup();

// Publish each bot's voice-mode STT provider AFTER applySavedSettings, so the
// dashboard override wins over the env bootstrap — same precedence as
// ttsProvider. websocket.ts reads it when opening a voice session.
for (const bot of config.bots) {
  setVoiceSttProvider(bot.name, bot.voiceSttProvider);
  setVoiceModeEnabled(bot.name, bot.voiceModeEnabled);
}
console.log(
  `[voice] STT providers: ${config.bots.map((b) => `${b.name}=${b.voiceSttProvider}`).join(", ")}`,
);
const voiceOn = config.bots.filter((b) => b.voiceModeEnabled).map((b) => b.name);
console.log(`[voice] voice mode enabled: ${voiceOn.length ? voiceOn.join(", ") : "(none — dark)"}`);
// Voice step 3: app calls are native; ElevenLabs is the rollback (voice/eleven/config.ts).
console.log(`[voice] app call transport: ${elevenTransportOn() ? "elevenlabs (VOICE_CALL_ROLLBACK)" : "native"}`);
{
  const stale = staleTransportNote();
  if (stale) console.log(`[voice] ${stale}`);
}

const app = new Hono();
/** ElevenLabs' client SDK reaches their API from the app — allowed only while that transport is on. */
const ELEVEN_CSP_CONNECT = elevenTransportOn()
  ? " https://api.elevenlabs.io https://*.elevenlabs.io https://*.livekit.cloud"
  : "";

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=()");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // Plaid Link (vault connect) loads its script from cdn.plaid.com and opens an iframe from there.
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.plaid.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss: https://cdn.plaid.com https://production.plaid.com" + ELEVEN_CSP_CONNECT,
      "frame-src 'self' https://cdn.plaid.com",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
  );
});

// Create a bot instance for each configured bot
const instances: BotInstance[] = config.bots.map((botCfg) => createBot(botCfg, config));
const activeVoiceControllers = new Map<string, AbortController>();
/** The running turn's front-voice controller, so a barge-in can stop a filler that has not played. */
const activeFrontVoice = new Map<string, AbortController>();

/**
 * One single-flight gate per voice session — the "replies never drop"
 * guarantee, ported from the simulator (src/voice/turn-gate.ts).
 *
 * Voice turns are dispatched fire-and-forget from the socket, so before this
 * a second utterance could start a turn while the first was still generating.
 * Both then died: the first's stream chunks were dropped by the orchestrator's
 * sequence guard, and the second was rejected because the resident bridge
 * holds exactly one turn. Two utterances, zero replies, no visible cause.
 *
 * The gate serializes turns per voice session and supersedes the in-flight one
 * synchronously, reusing the same abort path as a barge-in.
 */
const voiceTurnGates = new Map<string, TurnGate<[() => Promise<void>]>>();

function voiceTurnGateFor(voiceStreamId: string): TurnGate<[() => Promise<void>]> {
  const existing = voiceTurnGates.get(voiceStreamId);
  if (existing) return existing;
  const gate = makeTurnGate<[() => Promise<void>]>({
    run: (turn) => turn(),
    supersede: () => {
      // Identical to a barge-in: stop generating and stop speaking, now.
      //
      // "Stop speaking" means cancelling the Cartesia context too, not just
      // aborting the agent. Synthesis runs ahead of playback, so a superseded
      // turn that is only aborted keeps streaming the sentences it had already
      // handed to Sonic — the user hears the answer to the question they just
      // talked over, arriving on top of the new one. Same call the barge-in
      // handler makes, for the same reason.
      voiceTtsStreams.get(voiceStreamId)?.cancel();
      cutPlayout(voiceStreamId);
      activeFrontVoice.get(voiceStreamId)?.abort();
      abortSpeculativeTurn(voiceStreamId, "user_bargein");
      activeVoiceControllers.get(voiceStreamId)?.abort("superseded");
    },
    onError: (err) => {
      console.error(`[voice-turn] turn failed (${voiceStreamId}):`, err.message);
    },
  });
  voiceTurnGates.set(voiceStreamId, gate);
  return gate;
}

// ── Phone leg — Michael's Twilio line, both directions ──────────────────────
// POST /api/phone/voice + /status (Twilio-signed) · POST /api/phone/call
// (REVIEW_DESK_TOKEN; scripts/phone-call.mjs) · WS /api/phone/stream.
// Registered BEFORE the dashboard: its host middleware (legacy redirect, SPA
// fallback) must never see Twilio's requests. Dark unless PHONE_ENABLED.
const phone = installPhone(app, instances);

// ── ElevenLabs call transport (voice/eleven/) ───────────────────────────────
// POST /api/voice/eleven/session + /event (app auth) · WS /api/eleven/upstream
// (ElevenLabs' JWT + our secret). Inert unless VOICE_CALL_ROLLBACK=elevenlabs (voice step 3):
// the app only asks for it when the session names the agent in `elevenBots`.
const eleven = installElevenTransport(app, { instances, config, writeCallCard });

// Mount dashboard routes
const dashboard = createDashboard(instances, config);
app.route("/", dashboard);

// ── Glasses endpoint — Even G2 "Michael on the lens" ─────────────────────────
// POST /api/glasses/ask · bearer GLASSES_TOKEN · see src/glasses.ts.
registerGlassesRoutes(app, instances, config);

// Voice upload relay — accepts base64-encoded audio from Tasker wake words
// POST /voice-upload?bot=<agent>&chat_id=<telegram chat id>
app.post("/voice-upload", async (c) => {
  const botName = c.req.query("bot");
  const chatId = c.req.query("chat_id");

  if (!botName || !chatId) {
    return c.json({ error: "Missing bot or chat_id query param" }, 400);
  }

  const instance = instances.find((i) => i.config.name === botName);
  if (!instance) {
    return c.json({ error: `Unknown bot: ${botName}` }, 404);
  }

  try {
    const b64 = await c.req.text();
    if (!b64 || b64.length < 100) {
      return c.json({ error: "Body too short — expected base64 audio" }, 400);
    }

    const audioBuffer = Buffer.from(b64.trim(), "base64");

    // Upload to Telegram sendVoice via multipart
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("voice", new Blob([audioBuffer], { type: "audio/ogg" }), "wake_audio.3gpp");

    const tgUrl = `https://api.telegram.org/bot${instance.config.token}/sendVoice`;
    const res = await fetch(tgUrl, { method: "POST", body: form });
    const result = await res.json();

    if (!result.ok) {
      console.error(`[voice-upload] Telegram error:`, result);
      return c.json({ error: "Telegram rejected the upload", detail: result }, 502);
    }

    console.log(`[voice-upload] Sent wake audio to ${botName} for chat ${chatId}`);
    return c.json({ ok: true, message_id: result.result?.message_id });
  } catch (err) {
    console.error(`[voice-upload] Error:`, err);
    return c.json({ error: "Internal error" }, 500);
  }
});

/** The build this process runs: its git sha, read once at boot (a ship confirms "back on <sha>" against it). */
const BUILD_IDENTITY = (() => {
  let sha: string | null = null;
  let branch: string | null = null;
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd(), encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: process.cwd(), encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    /* not a checkout — identity unknown, never fatal */
  }
  return { sha, branch, started: new Date().toISOString() };
})();

/** Every live call on every transport (/health, the lifecycle heartbeat). Before the transports exist, the native calls alone. */
function allLiveCalls(): number {
  try {
    return liveCallCount() + eleven.liveCalls();
  } catch {
    return liveCallCount();
  }
}

// Which AHI home this server serves, as a short hash (never the path): AHI Setup compares it before treating a server
// already on the port as its own (onboarding/src/ahi-runtime.cjs homeId).
const HOME_ID = process.env.AHI_AI_ROOT ? createHash("sha256").update(process.env.AHI_AI_ROOT).digest("hex").slice(0, 16) : null;

function healthPayload() {
  const degraded = getDegradedStates();
  const ok = degraded.length === 0;
  return {
    ok,
    status: ok ? "ok" : "degraded",
    build: BUILD_IDENTITY,
    home: HOME_ID,
    // Calls live right now — a ship's restart waits for zero (ship-restart.sh), the app says "a call is on".
    // App calls and phone legs register in websocket.ts; ElevenLabs calls live in their own transport and
    // count too, or a check-in could ring the owner mid-call.
    calls: allLiveCalls(),
    degraded: degraded.map(({ reason, since, detail }) => ({ reason, since, detail })),
    // Fixed by the gateway itself (a bloated session cleared) — informational, never "degraded".
    self_healed: getSelfHealedEvents().map(({ reason, count, last }) => ({ reason, count, last })),
    disk_free_gb: getLiveDiskFreeGb(),
    // Worst event-loop delay lately (voice/loop-watch.ts): is the gateway itself stalling?
    loop: loopWatch()?.summary() ?? null,
    bots: instances.map((i) => ({
      name: i.config.name,
      model: i.config.model,
      voice: i.config.voice,
    })),
    mode: config.mode,
    uptime: process.uptime(),
  };
}

// Health check
app.get("/health", (c) => {
  return c.json(healthPayload());
});

app.get("/api/health", (c) => {
  return c.json(healthPayload());
});

// ── Review desk — approvals (RED by fingerprint), digest, day-close, tracks ──
// /app/review/* = the owner's existing user auth · /api/review/* = REVIEW_DESK_TOKEN.
// See src/review/ and builds/review-desk/REPORT.md. Never throws at boot.
const reviewDesk = installReviewDesk(app, instances, resolveUser);

// ── Vault — the owner's financial picture, read-only, behind his fingerprint ──
// /app/vault/* = the owner's existing user auth (404 for anyone else) · /api/vault/* = VAULT_SERVICE_TOKEN
// (scripts/vault.mjs). RED actions reuse the review desk's passkeys. See src/vault/ and
// builds/finance-vault/REPORT.md. Never throws at boot.
installVault(app, resolveUser, reviewDesk);

// ── Foreman messages — structured build status rendered in code ──
// POST /foreman/status (record → timeline; needs_operator/closed/failed → the owner's chat, once)
// POST /foreman/wake (Michael's supervision turn, off the owner's chat) · GET /foreman/{builds,timeline/:id}.
// See src/foreman-messages/ and builds/foreman-messages/REPORT.md. Never throws at boot.
const foremanDesk = installForemanMessages(app, instances, config, resolveUser);

// ── Schedule — the owner's week, live: the calendar icon in the app header ──
// /app/schedule/* (admin) — blocks, the current block's briefs, the background
// lane, and the unread badge. Week + tags are files Michael edits; decisions via
// scripts/schedule.mjs. Overrule wakes Michael on the review desk's path. Never throws.
installSchedule(app, resolveUser, {
  reviewItems: reviewDesk ? (owner) => reviewDesk.store.all().filter((it) => it.owner === owner) : null,
  wake: reviewDesk ? (owner, text) => reviewDesk.wakeMichael(owner, text) : null,
});

// ── Codex live — a foreman Codex build, watchable live on its build card ──
// GET /app/codex-live/:build (admin, read-only) tails the build's Codex rollout;
// a `codex-live` socket frame rings when it moves. See src/codex-live/. Never throws.
installCodexLive(app, resolveUser);

// ── Chat files — an agent sends a user files in the app; the media panel ──
// POST /api/chat/files (REVIEW_DESK_TOKEN; scripts/send-file.mjs) ·
// GET /app/media (+ /context) for the Media / Files / Links panel.
// See src/chat-files/. Never throws at boot.
installChatFiles(app, instances, resolveUser);

// ── Inline search — SerpApi web + image results as cards in the chat ──
// /app/search (+ /status, /img proxy, /attach) for the app · POST /api/search
// (REVIEW_DESK_TOKEN; scripts/search.mjs) · `[[search_images: …]]` in replies.
// Off (and hidden in the app) without SERPAPI_API_KEY. See src/search/. Never throws.
installSearch(app, instances, resolveUser);
registerFolderRoutes(app, { resolveUser, bots: () => instances.map((i) => i.config.name) });
// Documents → the real AHI folder tree: owner only, read-only but for "add a folder".
registerDocTreeRoutes(app, { resolveUser });
// Gmail: every connected Gmail account, read + search + drafts; Google sign-in in the browser.
registerGmailRoutes(app, { resolveUser, stateDir: gatewayStateRoot() });

// ── Live studio — Avi's background generations + decision cards ──
// `[[studio_job: {…}]]` / `[[studio_decision: {…}]]` in Avi's replies (chat or
// call) · /app/studio/status + /stop · POST /api/studio/job + /decision
// (REVIEW_DESK_TOKEN; scripts/studio.mjs). A job's card posts at once and turns
// into the decision when it lands; a live call hears one line. Never throws.
installStudio(app, resolveUser, {
  stateDir: config.sessionDir,
  // A background Avi with every tool (Higgsfield MCP, the video pipeline).
  // Ephemeral: no session, no thread, nothing resumed; not in Avi's chat slot,
  // so his chat stays free — the studio allows one at a time (it holds one of
  // the global spawn slots while it runs).
  runWorker: async (job, ctx) => {
    const instance = instances.find((i) => i.config.name === job.bot);
    if (!instance) throw new Error(`${job.bot} is not running on this gateway`);
    const tools = (process.env.STUDIO_WORKER_TOOLS ?? "mcp__claude_ai_Higgsfield,Bash,Edit").split(",").map((t) => t.trim()).filter(Boolean);
    const r = await invokeAgent({
      botName: job.bot,
      chatId: 0,
      message: workerMessage(job),
      sessionMap: instance.sessionMap,
      config,
      model: instance.config.model,
      principalUserId: job.userId,
      ephemeral: true,
      abortSignal: ctx.signal,
      extraAllowedTools: tools,
      extraAddDirs: [job.outDir],
    });
    return { text: r.response };
  },
  announce: (userId, bot, text) => {
    const call = liveCallFor(userId, bot);
    if (!call) return false;
    sayOnCall(call.voiceStreamId, bot, call.transport, text);
    return true;
  },
});

// An approval in Review STARTS the work: each one wakes Michael
// once, in his own quiet turn — the same in-process path /foreman/wake (and so
// foreman_wake.sh) uses; never the owner's chat. A failed turn makes the review
// desk's outbox retry; with no foreman desk the wakes stay queued.
if (reviewDesk && foremanDesk) {
  reviewDesk.setWaker(async (userId, text) => {
    if (!(await foremanDesk.wake(userId, text))) throw new Error("Michael's wake turn failed");
  });
  // The ship lane: his Ship tap on a card records the approval on
  // the foreman desk and wakes Michael; the ship's result closes the card.
  reviewDesk.setShipper((o) => foremanDesk.shipApprove(o));
  foremanDesk.bind({
    onShipResult: (state) => reviewDesk.shipLanded(state),
    shipCommand: (build, restart) => `${resolvePath(process.cwd(), "scripts/ship/ship.sh")} ${build}${restart === "now" ? " --now" : ""}`,
  });
}

// ── Turn resume — no reply is ever lost to a restart ──
// Chat turns leave an in-flight marker until their reply is in the thread
// (turn-journal.ts). At boot, markers the previous process left are re-run as
// normal replies in the same thread, or — if too old — get one line offering
// to pick them up (turn-resume.ts). Started after the HTTP server is up.
const turnResumer = installTurnResume(instances, config);

// Status page
app.get("/", (c) => {
  const lines = [
    "AHI Gateway v0.3.0",
    `Mode: ${config.mode}`,
    `Bots: ${instances.map((i) => i.config.name).join(", ")}`,
    `Uptime: ${Math.floor(process.uptime())}s`,
    `Dashboard: http://localhost:${config.port}/ui`,
    "",
    ...instances.map((i) => `  ${i.config.name} — model: ${i.config.model}, voice: ${i.config.voice}`),
  ];
  return c.text(lines.join("\n"));
});

function speculationEnvEnabled(): boolean {
  return (
    (process.env.AHI_SPECULATION === "true" || process.env.AHI_SPECULATION_ENABLED === "true") &&
    isRuntimeSpeculationEnabled()
  );
}

function specEditDistanceMax(): number {
  const n = Number(process.env.AHI_SPEC_EDIT_DISTANCE_MAX);
  return Number.isFinite(n) ? n : 0.30;
}


function isSupersededVoiceTurn(err: unknown): boolean {
  const anyErr = err as { name?: unknown; message?: unknown; cause?: unknown };
  const name = typeof anyErr?.name === "string" ? anyErr.name : "";
  const message = typeof anyErr?.message === "string" ? anyErr.message : String(err ?? "");
  const cause = typeof anyErr?.cause === "string" ? anyErr.cause : "";
  return (
    name === "AbortError" ||
    /aborted by signal/i.test(message) ||
    /superseded/i.test(message) ||
    /superseded/i.test(cause)
  );
}

function isBluetoothRoute(route: string): boolean {
  const lower = route.toLowerCase();
  return lower.includes("bluetooth") || lower.includes("airpods");
}

setVoiceTentativeHandler((opts) => {
  const instance = instances.find((i) => i.config.name === opts.botName);
  if (!instance) return;
  if (!speculationEnvEnabled()) return;
  if (!opts.speculationEnabled) return;
  if (opts.turnIndex < 1) return;
  if (isBluetoothRoute(opts.audioRoute) && !opts.forceSpeculationOnBluetooth) return;
  if (getSpeculativeTurn(opts.voiceStreamId)) return;

  const controller = new AbortController();
  const invokePromise = withBotSlot(opts.botName, () =>
    invokeAgent({
      // The SAME options as the cold path (voiceTurnInvokeOptions): model,
      // effort, principal, thread. A speculated turn answering as a different
      // agent than the turn it replaces would be visible the moment it commits.
      ...voiceTurnInvokeOptions(instance.config, opts.user, opts.voiceStreamId),
      // Tagged exactly like the cold path, so a committed speculation is the same turn.
      message: tagDashboardMessageForBot(opts.interimText, opts.botName, opts.user),
      sessionMap: instance.sessionMap,
      config,
      abortSignal: controller.signal,
    }),
  );
  const turn = startSpeculativeTurn({
    voiceStreamId: opts.voiceStreamId,
    botName: opts.botName,
    userId: opts.user.userId,
    interimText: opts.interimText,
    controller,
    invokePromise,
  });
  // NO speculative TTS pre-synth in voice mode.
  //
  // `attachSpeculativeTts` exists because audio used to be a BLOB you could
  // build early and hold until the turn committed. Streaming has no
  // equivalent: streaming IS speaking, so pre-synthesizing would read an
  // uncommitted reply out loud, and buffering it until commit would
  // reintroduce the wait-for-the-whole-reply this path exists to remove.
  //
  // Speculation still earns its keep — it hides the genuinely slow part, the
  // agent's think time. What it no longer hides is synthesis, and Sonic's
  // TTFB on an already-complete reply is far cheaper than the REST + ffmpeg
  // transcode it replaces, so a speculated turn should still land FASTER than
  // it did on the blob path.
  //
  // The machinery below (`attachSpeculativeTts`, `SpeculativeTurn.tts` /
  // `.ttsPromise`) is deliberately left INTACT and simply not populated here.
  // POST-PROVING CLEANUP: once streaming is proven on the owner's device, these
  // fields are dead for voice mode and can come out — that deletion does not
  // belong in this diff.
  void attachSpeculativeTts;
  console.log(`[voice-spec] started ${opts.voiceStreamId} bot=${opts.botName} user=${opts.user.userId}`);
});

setVoiceSpecCancelHandler(({ voiceStreamId, reason }) => {
  abortSpeculativeTurn(voiceStreamId, reason);
});

/* ── Per-call streaming TTS sockets ───────────────────────────────────────
   One Cartesia socket per CALL, not per turn. websocket.ts signals the call
   lifecycle; the Cartesia voice config lives on BotConfig, which websocket.ts
   does not know about, so ownership sits here.

   Connecting is deliberately fire-and-forget at call start: it happens while
   the user is still drawing breath, and a turn that arrives before the socket
   is up simply finds `ready === false` and falls back rather than blocking
   voice-start on a third-party handshake.                                  */
const voiceTtsStreams = new Map<string, CallTtsStream>();

/* ── Per-call front voice ─────────────────────────────────────────────────
   Two warm Haiku processes per call, raced each turn (front-voice.ts),
   opened with the call so the first turn finds them ready.
   Kill switch: FRONT_VOICE=off. Lanes: FRONT_VOICE_LANES (1–3, default 2). */
interface CallFrontVoice {
  /** The holding-line front voice (CALL_FRONT_GATE=off). */
  fv?: RacedFrontVoice;
  /** Fast OR slow (front-gate.ts), the ElevenLabs call's gate — the default since voice-speed. */
  gate?: FrontGate;
}
const callFrontVoices = new Map<string, CallFrontVoice>();

/**
 * What the fast voice answered in full on this call since the main brain
 * last finished a turn — told to the main brain on its next turn as already
 * said (front-gate.ts fastAnswersNote; the ElevenLabs call does the same).
 */
const callFastNotes = new Map<string, { heard: string; said: string }[]>();

/** Fast OR slow on the native call (app and phone). CALL_FRONT_GATE=off = the holding-line front voice, as before. */
function callFrontGateOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CALL_FRONT_GATE ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/**
 * The hold lines (voice/hold-line.ts), rendered once per voice — bot,
 * provider and the model the call is actually speaking on — and shared by
 * every call in that voice.
 */
const holdBanks = new Map<string, HoldLineBank>();
function holdBankFor(bot: BotInstance["config"], provider: CallTtsProvider, model: string | undefined): HoldLineBank {
  const lines = holdLines();
  const key = `${bot.name}:${provider}:${model ?? ""}:${lines.join("|")}`;
  let bank = holdBanks.get(key);
  if (!bank) {
    bank = new HoldLineBank((text) => renderFillerPcm(bot, provider, text, model), lines, (l) => console.warn(l));
    holdBanks.set(key, bank);
  }
  bank.warm();
  return bank;
}

/** Why the main turn was aborted when the fast voice's reply was the whole answer. */
const FRONT_FULL = "front-full";

/** Each call's gate drafts (voice/gate-draft.ts), and the do-not-repeat key its turns use (set by the first draft). */
const callGateDrafts = new Map<string, GateDrafts>();
const callUserKeys = new Map<string, string>();
/** Each call's user, for the gate's clock (his zone). */
const callUserIds = new Map<string, string>();

/** The gate's "Now:" line for this user (voice step 5, front-gate.ts): his day, date and time in his zone. */
function gateClockFor(userId: string | undefined): string {
  return gateClockLine(new Date(), userEffectiveZone(userId ?? null).zone);
}

/* ── Drafting while he talks (voice step 4) ───────────────────────────────
   At each pause the fast gate drafts its verdict (voice/gate-draft.ts). The
   main brain does NOT start early on the native doors: a speculated turn
   runs its tools before the final transcript confirms the words (Codex,
   step 4), so it waits for a side-effect-free mode — step 4 REPORT.       */
setVoiceDraftHandler((opts) => {
  callUserKeys.set(opts.voiceStreamId, `${opts.botName}:${opts.user.userId}`);
  callUserIds.set(opts.voiceStreamId, opts.user.userId);
  if (gateDraftOn()) callGateDrafts.get(opts.voiceStreamId)?.draft(opts.text, opts.why);
});

/** The front line streamed as it renders (turn-audio.ts openFiller). CALL_FILLER_STREAM=off = whole renders, as before. */
function callFillerStreamOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CALL_FILLER_STREAM ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/* ── Per-call ack gate (voice/ack-gate.ts) ────────────────────────────────
   One warm Haiku process per call that decides whether an utterance is only
   an acknowledgement. Kill switch: SILENT_ACKS=off.                       */
const callAckGates = new Map<string, ReturnType<typeof createAckClassifier>>();

function frontVoiceEnabled(botName: string): boolean {
  const v = (process.env[`${botName.toUpperCase()}_FRONT_VOICE`] ?? process.env.FRONT_VOICE ?? "on").toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/** End of user speech → when the filler may play if the answer is silent. */
function frontVoiceDeadlineMs(): number {
  const n = Number(process.env.FRONT_VOICE_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1_200;
}

function connectCallTts(voiceStreamId: string, bot: BotInstance["config"], provider: CallTtsProvider): void {
  const stream = createCallTtsStream(bot, provider, voiceStreamId);
  voiceTtsStreams.set(voiceStreamId, stream);
  stream.on({
    onError: (err) => console.warn(`[voice-tts] ${voiceStreamId}:`, err.message),
  });
  stream.connect().then(
    () => console.log(`[voice-tts] ${voiceStreamId}: ${stream.provider} ${stream.activeModel} ready (${stream.sampleRate} Hz)`),
    (err) => {
      console.warn(`[voice-tts] ${provider} connect failed for ${voiceStreamId}:`, (err as Error).message);
      if (voiceTtsStreams.get(voiceStreamId) !== stream) return;
      voiceTtsStreams.delete(voiceStreamId);
      stream.close();
      // The note voice could not stream: keep the call SPEAKING in the
      // previous call voice rather than dropping to the blob path.
      if (provider !== "cartesia") connectCallTts(voiceStreamId, bot, "cartesia");
    },
  );
}

/**
 * How long to wait for Cartesia's `done` after we close a turn's context.
 *
 * Only reached when `done` never comes — a barge-in cancels the context, and
 * a cancelled context is never "done". Without this bound the durable-record
 * write would hang forever on an interrupted turn, and the partially spoken
 * reply would never reach the thread.
 */
const SYNTH_SETTLE_TIMEOUT_MS = 5_000;

setVoiceSessionOpenHandler(({ botName, voiceStreamId, userName }) => {
  const instance = instances.find((i) => i.config.name === botName);
  if (!instance) return;
  if (voiceTtsStreams.has(voiceStreamId)) return;

  // Same voice as the voice notes (call-tts.ts), separate plumbing.
  connectCallTts(voiceStreamId, instance.config, callTtsProviderFor(instance.config));
  // The hold lines in the call's voice, before the first turn needs one.
  if (holdMs() > 0) {
    const tts = voiceTtsStreams.get(voiceStreamId);
    if (tts) holdBankFor(instance.config, tts.provider as CallTtsProvider, tts.activeModel);
  }

  if (frontVoiceEnabled(botName) && !callFrontVoices.has(voiceStreamId)) {
    const lanes = Number(process.env.FRONT_VOICE_LANES);
    const laneCount = Number.isInteger(lanes) && lanes >= 1 && lanes <= 3 ? lanes : 2;
    // The front voice speaks AS this call's agent TO this caller (Miriam to
    // a family member), never as Michael to the owner.
    const persona = { agent: agentDisplayName(botName), user: userName || "the owner" };
    const model = process.env.FRONT_VOICE_MODEL || FRONT_VOICE_MODEL_DEFAULT;
    if (callFrontGateOn()) {
      // The same lanes the front voice held, now with the gate's prompt: no more processes per call.
      // The native calls' gate gives QUICK a bridge (voice step 6); the ElevenLabs call's gate does not.
      const gate = new FrontGate(model, persona, laneCount, undefined, { bridge: bridgeOn() });
      gate.warm();
      callFrontVoices.set(voiceStreamId, { gate });
      // The gate drafts at each pause while he talks (voice/gate-draft.ts); the turn takes the draft with its words.
      callGateDrafts.set(
        voiceStreamId,
        new GateDrafts(
          (text, signal, onClaim, why) =>
            frontGateFor(
              gate.ask,
              callUserKeys.get(voiceStreamId) ?? botName,
              text,
              recentVoiceLines(voiceStreamId, 6),
              signal,
              Date.now,
              gate.persona,
              // A guess on his partial words takes one lane: the turn's real ask finds the other free (voice step 6).
              draftOneLane() && draftIsGuess(why) ? gate.askOne : gate.askEach,
              { onClaim, clock: gateClockFor(callUserIds.get(voiceStreamId)), bridge: gate.bridge },
            ),
          Date.now,
          (l) => console.log(`${l.replace("]", `] ${voiceStreamId}`)}`),
        ),
      );
    } else {
      const fv = new RacedFrontVoice(model, laneCount, undefined, undefined, persona);
      fv.warm();
      callFrontVoices.set(voiceStreamId, { fv });
    }
  }

  if (silentAcksEnabled(botName) && !callAckGates.has(voiceStreamId)) {
    const gate = createAckClassifier(undefined, { agent: agentDisplayName(botName), user: userName || "the owner" });
    gate.warm();
    callAckGates.set(voiceStreamId, gate);
  }
});

/**
 * The call log (frame 3F) — one centered card per call, in the chat thread.
 *
 * Written HERE, in the service process, through `broadcast` → `storeMessage`.
 * That is the whole point: gateway state files are read through an in-process
 * cache and rewritten whole, so a card written from anywhere else survives
 * only until the next save from this process erases it.
 *
 * It rides as a normal text message with the record under `meta.voiceSession`.
 * A new contentType would have to be understood by every existing reader —
 * Telegram bridge, retrieval corpus, exports — where a card is meaningless.
 * Clients that don't know about `meta.voiceSession` show a plain, true line.
 */
setVoiceSessionRecordHandler((opts) => writeCallCard(opts));

function writeCallCard({ botName, user, record }: { botName: string; user: UserConfig; record: VoiceSessionRecord }): void {
  const instance = instances.find((i) => i.config.name === botName);
  if (!instance) return;
  // A phone call's card says so (and which way it went); an app call's is unchanged.
  const title =
    record.channel === "phone"
      ? `PHONE CALL${record.direction === "outbound" ? " · MICHAEL CALLED" : record.direction === "inbound" ? " · YOU CALLED" : ""}`
      : "ENTERED VOICE MODE";
  broadcast({
    type: "message",
    bot: botName,
    direction: "in",
    contentType: "text",
    text: `${title} · ${formatCallDuration(record.durationSec)} · ${record.turns} turn${record.turns === 1 ? "" : "s"}`,
    timestamp: new Date().toISOString(),
    chatId: appChatId(user),
    userId: user.userId,
    senderName: user.name,
    source: "app",
    meta: { voiceSession: record },
  });
}

function formatCallDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

setVoiceSessionCloseHandler(({ voiceStreamId }) => {
  callSayers.delete(voiceStreamId);
  callTurnBooks.delete(voiceStreamId);
  callCuts.delete(voiceStreamId);
  callSequencers.get(voiceStreamId)?.stopFiller();
  callSequencers.delete(voiceStreamId);
  lastBackchannels.delete(voiceStreamId);
  callFrontVoices.get(voiceStreamId)?.fv?.close();
  callFrontVoices.get(voiceStreamId)?.gate?.close();
  callFrontVoices.delete(voiceStreamId);
  callGateDrafts.get(voiceStreamId)?.drop();
  callGateDrafts.delete(voiceStreamId);
  callUserKeys.delete(voiceStreamId);
  callUserIds.delete(voiceStreamId);
  callFastNotes.delete(voiceStreamId);
  callAckGates.get(voiceStreamId)?.close();
  callAckGates.delete(voiceStreamId);
  callTurnIntakes.get(voiceStreamId)?.close();
  callTurnIntakes.delete(voiceStreamId);
  forgetPlayout(voiceStreamId);
  const stream = voiceTtsStreams.get(voiceStreamId);
  if (!stream) return;
  voiceTtsStreams.delete(voiceStreamId);
  stream.close();
});

setVoiceInterruptHandler(({ voiceStreamId, reason, heardSec }) => {
  // The call is over: queued turns must not start either (voice/ended-calls.ts).
  if (reason === "hangup") {
    markVoiceCallEnded(voiceStreamId);
    // Pending ack verdicts die with the call (S1).
    callTurnIntakes.get(voiceStreamId)?.close();
  }
  // A confirmed barge-in against the running turn (voice/turn-taking.ts): his
  // words that commit next go straight to supersede, never the work gate —
  // the aborted turn is still "in flight" until its process exits.
  if (reason !== "hangup") callTurnBooks.get(voiceStreamId)?.barge();
  // What he actually heard of the reply he cut (voice-streaming-bargein): the
  // record keeps only that, and his next turn tells the model so. Works the
  // same whether the reply was still generating or long finished — the app
  // plays seconds behind synthesis, and its cut position is the truth.
  if (reason !== "hangup" && heardSec !== undefined) noteCut(voiceStreamId, heardSec);
  abortSpeculativeTurn(voiceStreamId, "user_bargein");
  // Cancel synthesis BEFORE aborting the agent. Cartesia is generating ahead
  // of playback, so anything still queued there is speech the user has
  // already talked over — cancelling the context is what stops the reply from
  // continuing to arrive after they interrupted it.
  voiceTtsStreams.get(voiceStreamId)?.cancel();
  // A paced filler stops sending words he has already cut off (turn-audio.ts).
  callSequencers.get(voiceStreamId)?.stopFiller();
  // The app cut its speaker: nothing after now can be our echo (B2).
  cutPlayout(voiceStreamId);
  // A filler that has not played yet must not play after he started talking.
  activeFrontVoice.get(voiceStreamId)?.abort();
  activeVoiceControllers.get(voiceStreamId)?.abort(reason === "hangup" ? "call_ended" : "user_bargein");
});

// ── Always-on, slice 1: fixed lines and the work gate ───────────────────────

/**
 * The live spoken turn of each call, as "say one line into it" — set while a
 * turn runs with a voice, cleared with it. A status answer or a queued-ack
 * rides the running turn's own downlink, no model call (work-gate.ts).
 */
const callSayers = new Map<string, (text: string) => boolean>();

/** Each call's last backchannel for a queued remark ("Mm-hm."): the next is never the same. */
const lastBackchannels = new Map<string, string>();
/**
 * Each call's running turn and last barge-in (voice/turn-taking.ts): what a
 * new utterance does to the turn in flight — merge, supersede, or the work gate.
 */
const callTurnBooks = new Map<string, TurnBook>();

function turnBookFor(voiceStreamId: string): TurnBook {
  let book = callTurnBooks.get(voiceStreamId);
  if (!book) {
    book = new TurnBook();
    callTurnBooks.set(voiceStreamId, book);
  }
  return book;
}

/**
 * Each call's last spoken turn and the last barge-in cut on it
 * (voice/heard-cut.ts): what he actually heard, for the record and the note.
 */
const callCuts = new Map<string, CallCuts>();
function callCutsFor(voiceStreamId: string): CallCuts {
  let c = callCuts.get(voiceStreamId);
  if (!c) {
    c = new CallCuts();
    callCuts.set(voiceStreamId, c);
  }
  return c;
}

/** Each call's newest spoken turn's sequencer: a cut or a new turn stops its paced filler. */
const callSequencers = new Map<string, TurnAudioSequencer>();

/** A barge-in cut the last spoken turn at `heardSec` on its clock. */
function noteCut(voiceStreamId: string, heardSec: number): void {
  const { heard, action } = callCutsFor(voiceStreamId).cut(heardSec);
  if (heard === null) return;
  if (action.kind === "trim") trimVoiceAgentTurn(voiceStreamId, action.at, action.text);
  else if (action.kind === "record") callCutsFor(voiceStreamId).recordedCut(recordVoiceAgentTurn(voiceStreamId, action.text));
  // `while=finished`: the reply was done generating when he cut it — the case
  // that used to play on over him (content-free: a count, never the words).
  const phase = turnsInFlight(voiceStreamId) > 0 ? "generating" : "finished";
  console.log(`[voice-cut] ${voiceStreamId} heard ${heardSec.toFixed(2)}s · ${heard ? heard.split(/\s+/).length : 0} word(s) kept while=${phase}`);
}

/** A fixed line for a standing call's commands; none for a word-perfect echo of the floor. */
const COMMAND_LINES: Record<"sleep" | "wake" | "quiet" | "name" | "watch" | "watch-dropped" | "watch-share-first", string> = {
  sleep: "Going to sleep. Say my name when you need me.",
  wake: "I'm here.",
  quiet: "Going quiet.",
  name: "Yes?",
  // Record mode (voice/screen-watch.ts): one word to say it started, then silence until he stops it.
  watch: "Watching.",
  "watch-dropped": "Dropped it.",
  "watch-share-first": "Share your screen first, then say watch this.",
};

/** Fixed lines' own ids on the mouth (each its own lane). */
let fixedLineSeq = 0;
/** Each spoken turn's id on the call's mouth: a barge-in or the next turn retires it by id. */
let voiceTurnSeq = 0;

/**
 * Speak one fixed line on a call with NO model turn: rendered in the call's
 * voice over the filler path (call-tts.ts), sent as text and audio through
 * the call's own downlink. Runs through the call's turn gate so it never
 * overlaps a reply — queued behind the running turn, never cutting it.
 */
function speakFixedLine(voiceStreamId: string, botName: string, transport: CallTransport, text: string): Promise<void> {
  const instance = instances.find((i) => i.config.name === botName);
  if (!instance) return Promise.resolve();
  const run = async (): Promise<void> => {
    if (voiceCallEnded(voiceStreamId)) return;
    const provider = callTtsProviderFor(instance.config);
    const sampleRate = fillerSampleRate(instance.config, provider);
    transport.event({ type: "stream-chunk", streamId: voiceStreamId, botName, userId: "", chunk: `${text} `, voiceCall: voiceStreamId });
    recordVoiceAgentTurn(voiceStreamId, text);
    // No word timings on a fixed line: a cut on it must not trim the reply before it.
    callCutsFor(voiceStreamId).spoken(null);
    let pcm: Buffer;
    try {
      pcm = await renderFillerPcm(instance.config, provider, text, voiceTtsStreams.get(voiceStreamId)?.activeModel);
    } catch (err) {
      console.warn(`[voice-line] ${voiceStreamId} could not render "${text}": ${(err as Error).message}`);
      transport.event({ type: "voice-tts", voiceStreamId, bot: botName, audioBase64: "", mimeType: "", text });
      return;
    }
    // A lane of the call's mouth (voice/mouth.ts): on air when nothing else is audible.
    const out = transport.audioOut({ voiceStreamId, bot: botName, turnId: `line:${++fixedLineSeq}`, priority: "line", label: "fixed-line", text });
    out.start(sampleRate);
    const step = (sampleRate * 2) / 10; // 100 ms frames
    for (let off = 0; off < pcm.length; off += step) out.frame(pcm.subarray(off, Math.min(pcm.length, off + step)));
    out.done();
  };
  const gate = voiceTurnGateFor(voiceStreamId);
  return gate.queue(run).then(() => {
    // Same retirement rule as a turn: only when nothing is running or queued.
    if (gate.idle && voiceTurnGates.get(voiceStreamId) === gate) voiceTurnGates.delete(voiceStreamId);
  });
}

/**
 * Say one line into the call now. Through the running turn's voice if there is
 * one (the only way to speak INTO work without stopping it); otherwise as a
 * fixed line behind whatever is queued. Returns whether it was spoken live.
 */
function sayOnCall(voiceStreamId: string, botName: string, transport: CallTransport, text: string): boolean {
  const live = callSayers.get(voiceStreamId);
  if (live && live(text)) return true;
  if (turnsInFlight(voiceStreamId) > 0) {
    // Work is running without a live voice (degraded path, or before its
    // first sentence): the screen carries the line, not spoken.
    transport.event({ type: "voice-work", voiceStreamId, bot: botName, text, voiceCall: voiceStreamId });
    return false;
  }
  void speakFixedLine(voiceStreamId, botName, transport, text);
  return false;
}

setVoiceCommandHandler(({ botName, voiceStreamId, command, transport }) => {
  void speakFixedLine(voiceStreamId, botName, transport, COMMAND_LINES[command]);
});

// ── Voice Mode turn handler (H-026 Phase 7 + H-040 B1) ──────────────────────
type VoiceTurnArgs = Parameters<Parameters<typeof setVoiceTurnHandler>[0]>[0];

/**
 * Silent acks (voice/ack-gate.ts): an utterance that only acknowledges what
 * Michael just said gets no reply, no TTS and no model turn. Decided BEFORE
 * the turn gate, and an ack is never submitted to it — an "okay" while
 * Michael is working must not supersede and abort that work. Anything not
 * plainly an ack goes straight through (the lexical check is instant).
 *
 * Every utterance goes through the call's TurnIntake (voice/turn-intake.ts),
 * numbered in the order it was said: a late verdict on an older "Okay." never
 * supersedes a newer real turn, and nothing is dispatched after hang-up (S1).
 */
const callTurnIntakes = new Map<string, TurnIntake<VoiceTurnArgs>>();

function turnIntakeFor(voiceStreamId: string): TurnIntake<VoiceTurnArgs> {
  const existing = callTurnIntakes.get(voiceStreamId);
  if (existing) return existing;
  const intake = new TurnIntake<VoiceTurnArgs>({
    dispatch: (args, ms) => handleVoiceTurn(args, ms),
    ended: () => voiceCallEnded(voiceStreamId),
    // Part six: a turn carrying something he dropped in is always a real
    // turn — never an ack, never echo.
    immediate: (args) => Boolean(args.drops?.length),
    // Michael's own voice coming back through the mic — the one echo rule
    // (voice/echo-rule.ts, voice step 3): most of his words are words that
    // were PLAYING while he spoke. The old rule (B2: began during
    // playout, ≥80% of the whole last reply, never a question or directive)
    // is the CALL_ECHO_RULE=old lever, and is logged where the two disagree.
    isEcho: (args) => {
      const old = looksLikeEcho(args.transcript, lastVoiceAgentLine(voiceStreamId), {
        duringPlayout: heardDuringPlayout(voiceStreamId, args.utteranceStartedAt),
      });
      const mouth = mouthFor(voiceStreamId);
      if (!mouth || oldEchoRules() || args.utteranceStartedAt == null) return old;
      const spokeSec = args.speechEndedAt ? Math.max(0, args.speechEndedAt - args.utteranceStartedAt) / 1000 : 0;
      const w = echoWindow(spokeSec);
      const played =
        mouth.playedNear(args.utteranceStartedAt, w.backSec, w.aheadSec) +
        (mouth.untimedSpeechNear(args.utteranceStartedAt, w.backSec, w.aheadSec) ? ` ${lastVoiceAgentLine(voiceStreamId) ?? ""}` : "");
      const share = echoShare(args.transcript, played);
      // Dropping a whole turn costs more than declining a barge-in, so the intake
      // keeps two guards around the one rule (Codex, step 3): his speech began
      // while Michael was audible, and a question, a directive or an answer to
      // an offer is never echo.
      const one =
        share >= ECHO_SHARE &&
        heardDuringPlayout(voiceStreamId, args.utteranceStartedAt) &&
        echoProtection(args.transcript, lastVoiceAgentLine(voiceStreamId)) === null;
      if (one || old) console.log(formatEchoVerdict(voiceStreamId, "intake", one, old, share, echoWords(args.transcript).length));
      return one;
    },
    echo: (args) => {
      console.log(`[voice-turn] ${voiceStreamId} ECHO dropped ${JSON.stringify(args.transcript.slice(0, 60))}`);
      args.transport.event({ type: "voice-ack", voiceStreamId, bot: args.botName, echo: true });
    },
    decide: (args, signal) => {
      const gate = callAckGates.get(voiceStreamId);
      if (!gate || !silentAcksEnabled(args.botName)) return null;
      return decideAck({
        heard: args.transcript,
        lastAgentLine: lastVoiceAgentLine(voiceStreamId),
        ask: gate.ask,
        names: { agent: agentDisplayName(args.botName), user: args.user.name },
        signal,
      }).then((d) => {
        if (!d.silent && d.reason.startsWith("model")) console.log(`[ack-gate] ${voiceStreamId} TURN (${d.reason}) ${d.ms}ms`);
        return d;
      });
    },
    silent: (args, d) => {
      console.log(`[ack-gate] ${voiceStreamId} SILENT ack ${JSON.stringify(args.transcript.slice(0, 60))} (${d.reason}) ${d.ms}ms`);
      // Informational for the client (unknown types are ignored); the call
      // stays where it was — listening, or waiting on work in flight.
      args.transport.event({ type: "voice-ack", voiceStreamId, bot: args.botName });
      logTurn({
        turn_id: voiceStreamId,
        user: args.user.userId,
        ts: new Date().toISOString(),
        final_text: args.transcript,
        audio_route: args.audioRoute,
        spec_invoked: false,
        spec_committed: false,
        spec_aborted: false,
        silent_ack: true,
        ack_gate_ms: d.ms,
      });
    },
    log: (line) => console.log(`[voice-turn] ${voiceStreamId} ${line}`),
  });
  callTurnIntakes.set(voiceStreamId, intake);
  return intake;
}

setVoiceTurnHandler((args) => turnIntakeFor(args.voiceStreamId).submit(args));

function handleVoiceTurn(
  args: VoiceTurnArgs,
  /** Time already spent deciding it was not an ack — counted in its latency. */
  ackGateMs: number,
  /**
   * `submit` (default) supersedes a running turn, as always. `queue` is an
   * addition said into running work, delivered after it. `classified` skips
   * the work gate — this utterance was already judged (his "yes" to the ask).
   */
  how: { mode?: "submit" | "queue"; classified?: boolean } = {},
): void {
  const { botName, transcript: heardText, voiceStreamId, transport, user, audioRoute, voiceStartedAt, screenFrame, drops = [], speechEndedAt = null } = args;
  /** What this turn answers: what he just said, or — merged — the whole thought. */
  let said = heardText;
  const instance = instances.find((i) => i.config.name === botName);
  if (!instance) {
    console.warn(`[voice-turn] unknown bot: ${botName}`);
    return;
  }
  const mode = how.mode ?? "submit";
  const book = turnBookFor(voiceStreamId);
  const turnId = `turn:${++voiceTurnSeq}`;

  /* ── Turn-taking (voice/turn-taking.ts): what this does to the turn running ──
     barge  a barge-in was just confirmed against it → supersede, never the gate
     merge  the rest of the thought he paused in (≤8 s, no tool yet) → one turn
     talk   the running turn is a reply, not real work → supersede
     gate   real work → the work gate below
     A drop is always a real turn (he put something in front of Michael on
     purpose) and supersedes, as before.                                     */
  let pieces = 1;
  let turnNote = "";
  let route: ReturnType<TurnBook["route"]> = { kind: "idle" };
  if (mode === "submit" && !how.classified && !drops.length && said) {
    route = book.route(turnsInFlight(voiceStreamId) > 0);
    if (route.kind !== "idle") console.log(formatRoute(voiceStreamId, route));
    if (route.kind === "merge") {
      said = joinPieces(route.prior.transcript, said);
      pieces = route.prior.pieces + 1;
      turnNote = MERGE_NOTE;
      transport.event({ type: "voice-gate", voiceStreamId, bot: botName, verdict: "merged", text: heardText });
    } else if (route.kind === "barge") {
      turnNote = BARGE_NOTE;
    } else if (route.kind === "talk" && route.spokenLines > 0) {
      turnNote = BARGE_NOTE;
    }
    // He cut the last reply off — while it was generating or long after: the
    // model hears how far he got, not just that he cut in.
    const cuts = callCuts.get(voiceStreamId);
    if (route.kind === "merge" || route.kind === "gate") cuts?.dropNote();
    else {
      const heard = cuts?.takeHeard(cutNoteMs());
      if (heard != null) turnNote = bargeNote(heard);
    }
  }

  /* ── The work gate (voice/work-gate.ts): a remark does not abort work ──
     Only for REAL work now (turn-taking.ts): an addressed utterance that is
     not an ack is classified before it can touch the turn gate.             */
  if (route.kind === "gate") {
    const verdict = classifyWhileWorking(said);
    console.log(`[gate] ${voiceStreamId} ${verdict} while working ${JSON.stringify(said.slice(0, 60))}`);
    if (verdict !== "stop") transport.event({ type: "voice-gate", voiceStreamId, bot: botName, verdict, text: said });
    if (verdict === "status") {
      const beat = describeWork(voiceStreamId);
      const line = statusLine(beat ?? { sinceMs: 0, tools: 0, lastWork: null });
      sayOnCall(voiceStreamId, botName, transport, line);
      return;
    }
    if (queuesWhileWorking(verdict)) {
      // Queued, never asked back: a listener's sound, rotated.
      handleVoiceTurn(args, ackGateMs, { mode: "queue" });
      const sound = backchannel(lastBackchannels.get(voiceStreamId) ?? null);
      lastBackchannels.set(voiceStreamId, sound);
      sayOnCall(voiceStreamId, botName, transport, sound);
      return;
    }
    // stop: supersede, as today — straight through to the gate below.
  }

  const finalAt = Date.now() - ackGateMs;
  // Part six: what he dropped in rides this turn. `transcript` (what the
  // front voice, logs and speculation read) names the drop when he said
  // nothing; the model's message spells the drop out.
  const transcript = said || (drops.length ? dropSummary(drops) : said);
  // "Look at my screen" (voice/screen-watch.ts). A record-mode review carries
  // its clip. Otherwise, while sharing, the frames on screen while he said
  // this — a merged turn's from where its first piece began — aligned to his
  // words (every turn by default; CALL_SCREEN_FRAMES=ask limits it to turns
  // that ask to look). CALL_SCREEN_WATCH=off: the latest frame, as before.
  let screenPick: WatchPick | null = args.screenReview ?? null;
  if (!screenPick && args.takeScreen) {
    const pick = args.takeScreen(route.kind === "merge");
    if (pick && (framePolicy() === "every" || asksToLook(said))) screenPick = pick;
  }
  const turnFrame =
    !screenPick && !args.takeScreen && !args.screenReview && screenFrame && (framePolicy() === "every" || asksToLook(said)) ? screenFrame : null;
  const screenImages: ScreenFrame[] = screenPick ? screenPick.frames : turnFrame ? [turnFrame] : [];
  if (screenPick) console.log(formatPick(voiceStreamId, screenPick, args.screenReview ? "recording" : "turn"));
  if (turnFrame) {
    console.log(
      `[voice-screen] ${voiceStreamId} frame attached ${turnFrame.width}x${turnFrame.height} ` +
        `${Math.round(turnFrame.data.length / 1024)} kB ~${estimateImageTokens(turnFrame.width, turnFrame.height)} tokens ` +
        `age=${Date.now() - turnFrame.capturedAt}ms`,
    );
  }
  // A door broke mid-reply and the mouth could not re-say it: he is told what reached the owner (voice/mouth.ts).
  const doorNote = mouthFor(voiceStreamId)?.takeDoorNote() ?? null;
  const agentMessage =
    (drops.length ? dropMessage(said, drops, user.name) : said) +
    (screenPick?.note ? `\n\n${screenPick.note}` : "") +
    (mode === "queue" ? `\n\n${QUEUED_NOTE}` : turnNote ? `\n\n${turnNote}` : "") +
    (doorNote ? `\n\n${doorNote}` : "");
  // This turn's record for turn-taking: a dispatched turn supersedes what ran,
  // so it is the running one from now; a queued turn becomes it when it starts.
  let rt: RunningTurn | null = mode === "submit" ? book.begin(transcript, finalAt, pieces) : null;
  const dropImages = drops.flatMap((d) => (d.kind === "image" ? [d.frame] : []));
  const spec = getSpeculativeTurn(voiceStreamId);
  const distance = spec ? normalizedLevenshtein(spec.interimText, transcript) : undefined;
  const baseLog = {
    turn_id: voiceStreamId,
    user: user.userId,
    ts: new Date().toISOString(),
    // Telemetry must name the model that actually answered, not the agent's
    // text model — otherwise a voice latency read is attributed to the wrong
    // model the moment these two differ.
    model: voiceTurnInvokeOptions(instance.config, user, voiceStreamId).model,
    effort: instance.config.voiceModeEffort,
    final_text: transcript,
    audio_route: audioRoute,
    stt_final_ms: finalAt - voiceStartedAt,
    ...(screenImages.length
      ? {
          screen_frames: screenImages.length,
          screen_tokens: screenPick?.tokens ?? screenImages.reduce((n, f) => n + estimateImageTokens(f.width, f.height), 0),
          screen_usd: screenPick ? Number(screenPick.usd.toFixed(4)) : undefined,
          screen_kind: args.screenReview ? "recording" : "turn",
        }
      : {}),
  };
  transport.event({ type: "voice-thinking", voiceStreamId, bot: botName });
  // What this surface adds to every turn (the phone: its rules, its denials).
  const hints = transport.turnHints?.() ?? null;

  /* ── One spoken turn over the call's Cartesia socket ──────────────────
     Owns the per-turn context: forwards PCM frames and word timings to the
     client as they arrive, accumulates the same PCM for the durable record,
     and resolves when synthesis finishes.

     Handlers are re-bound per turn rather than per socket. That is safe
     because the turn gate guarantees one turn at a time, and every callback
     re-checks the context id anyway — a frame from a cancelled turn is
     dropped, not spoken over the live one.                                */
  interface SpokenTurn {
    /** Feed generated text. Buffers to a clause before synthesizing. */
    push(text: string): void;
    /**
     * An assistant message just ended (the agent moved on to a tool call).
     * Whatever it wrote is complete: speak it now, as its own sentence.
     */
    boundary(): void;
    /** No more text — flush the tail and close the context. */
    finish(): void;
    /**
     * A working turn's own check-in line (voice/turn-liveness.ts): shown and
     * spoken as part of this reply, and recorded so the echo guard knows the
     * voice said it. Bypasses the sentence feed — it is already a sentence.
     */
    say(text: string): void;
    /** Resolves with the full PCM once synthesis ends (or is cut). */
    done: Promise<Buffer>;
    /** Synthesis latency: context open → first audio byte. */
    ttfbMs(): number;
    /** Absolute ms timestamp of the ANSWER's first audio, or 0 if none arrived. */
    firstAudioAt(): number;
    /** Characters actually sent to synthesis — the billing figure. */
    chars(): number;
    /** Characters shown as work lines and kept OUT of synthesis. */
    workChars(): number;
    /** The model that spoke each sentence (HTTP path), else the call's model. */
    models(): string[];
    /** This turn's downlink — the filler and the answer, in order. */
    seq: TurnAudioSequencer;
    provider: string;
    /**
     * The turn will say nothing more (the fast voice's reply was the whole
     * answer): tell the listener synthesis is over, once, whether or not the
     * voice ever reports done for an empty turn.
     */
    closeDownlink(): void;
  }

  /** This turn's liveness toward the listener, while it runs (voice/turn-liveness.ts). */
  let live: WorkingTurn | null = null;
  /** The spoken turn in progress, for the check-in line; null on the degraded path. */
  let currentSpoken: SpokenTurn | null = null;
  /** The fast gate's verdict this turn, for the logs. */
  let gateSeen: import("./voice/front-gate.js").GateVerdict | null = null;
  /** The fast voice's reply that was the whole answer (front-gate.ts "full"); the main turn was cancelled for it. */
  let fastTook: string | null = null;
  /** The cold path's main-turn controller, so a full reply can cancel it. */
  let mainController: AbortController | null = null;
  /** The hold line this turn said, and when (ms after the final), if one played (voice/hold-line.ts). */
  let holdPlayed: { text: string; atMs: number } | null = null;
  /**
   * An earlier piece of this thought already played its holding sound (voice
   * step 5, answer-ladder.ts): this turn plays none, and the main answer's
   * own stall is not said either. Read once, as the turn is dispatched.
   */
  const thoughtHeld = mode === "submit" && holdOncePerThought() && book.thoughtHeld(holdThoughtMs());
  if (thoughtHeld) console.log(`[ladder] ${voiceStreamId} the thought already had its holding sound — none this turn`);
  /** The turn's arbiter, once it exists (runCold): the answer's feed asks it whether a bridge is waiting. */
  let turnLadder: AnswerLadder | null = null;
  /** The bridge this turn said, if one played (voice step 6): the answer's own bare beat after it is not said. */
  let bridgeSaid: string | null = null;

  const beginSpokenTurn = (): SpokenTurn | null => {
    const tts = voiceTtsStreams.get(voiceStreamId);
    if (!tts?.ready) return null;

    const contextId = tts.beginTurn();
    const openedAt = Date.now();
    const frames: Buffer[] = [];
    // Everything this turn says goes out through ONE sequencer, so a filler
    // and the answer can never overlap (voice/turn-audio.ts).
    // On the call's playout clock, so the echo filter knows when he was audible (B2).
    const seq = new TurnAudioSequencer(
      // This turn's lane of the call's one mouth (voice/mouth.ts), on the call's playout clock.
      transport.audioOut({ voiceStreamId, bot: botName, turnId, priority: "turn", label: "turn" }),
      tts.sampleRate,
      Date.now,
      {
        ...fillerOptions(),
        // A filler already playing when the answer arrived ends at its next word break.
        onFillerCut: (sent, total) =>
          console.log(`[front-voice] ${voiceStreamId} cut at ${sent.toFixed(2)}s of ${total.toFixed(2)}s — the answer was ready`),
      },
    );
    // The last spoken turn of the call, for a barge-in that lands after it
    // finished generating: what he heard is read off its words.
    callCutsFor(voiceStreamId).spoken(seq);
    // The turn before this one says nothing more, filler included.
    callSequencers.get(voiceStreamId)?.stopFiller();
    callSequencers.set(voiceStreamId, seq);
    // Re-emissions, sentence buffering, message boundaries and the spoken/work
    // split — see its docs. On a call with a live voice the SCREEN is fed from
    // here too (not from raw tokens), so each line shows exactly once and in
    // its kind: spoken lines as the reply, work lines as "not spoken".
    /** The answer has said something real: stalls after that are part of it, not holding sounds. */
    let spokeSubstance = false;
    /** The answer's own stall was this turn's holding sound (nothing played before it). */
    let saidStall = false;
    const feed = new SpokenTextFeed(
      (piece, why) => {
        // After "One sec." or the fast line, a stall before the answer says anything real would
        // be a second holding sound on this turn — the opener, and one after a tool
        // call alike (Codex, step 4): shown, not said (voice/answer-ladder.ts).
        if (!spokeSubstance && dropSecondStall() && isBareStall(piece)) {
          // A bridge waiting for the answer is this turn's holding sound too (voice step 6): the stall would jump it.
          if (seq.filler || saidStall || thoughtHeld || turnLadder?.bridgePending) {
            console.log(`[ladder] ${voiceStreamId} a stall before the answer is not said (a holding sound already played)`);
            return;
          }
          saidStall = true;
          // The answer opens with its own holding sound: a bridge not yet on air must not stack on it (Codex, step 6).
          turnLadder?.answerOpened("stall");
        } else if (!spokeSubstance && bridgeSaid && dropSecondStall() && isBareBeat(piece)) {
          console.log(`[ladder] ${voiceStreamId} the answer's own beat is not said (the bridge gave it)`);
          return;
        } else {
          // The answer opens with a bare beat of its own ("Good question."): no bridge before it either (Codex, step 6).
          if (!spokeSubstance && !bridgeSaid && isBareBeat(piece)) turnLadder?.answerOpened("beat");
          spokeSubstance = true;
        }
        // The answer's first sentence is in the voice's hands: a filler that
        // has not started yet would only make it wait (turn-audio.ts).
        seq.answerReady();
        tts.speakPiece(piece, why);
      },
      (kind, text) => {
        if (kind === "work") {
          workChars += text.length;
          live?.note("work", text);
          transport.event({ type: "voice-work", voiceStreamId, bot: botName, text, voiceCall: voiceStreamId });
          return;
        }
        // A reply line handed to the voice: this turn is talking, not working (turn-taking.ts).
        if (rt) rt.spokenLines++;
        transport.event({
          type: "stream-chunk",
          streamId: voiceStreamId,
          botName,
          userId: user.userId,
          chunk: text,
          voiceCall: voiceStreamId,
        });
      },
    );
    let workChars = 0;
    let ttfb = 0;
    let firstAudio = 0;
    let settled = false;
    let downlinkClosed = false;
    let resolveDone!: (pcm: Buffer) => void;
    const done = new Promise<Buffer>((r) => (resolveDone = r));
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolveDone(Buffer.concat(frames));
    };
    tts.on({
      onAudio: (pcm, ctx) => {
        if (ctx !== contextId) return;
        live?.note("audio");
        if (!firstAudio) {
          firstAudio = Date.now();
          ttfb = firstAudio - openedAt;
          // He is being answered: the thought's holding sound is spent (answer-ladder.ts).
          book.answered();
        }
        frames.push(pcm);
        seq.answerAudio(pcm);
      },
      onTimestamps: (wt, ctx) => {
        if (ctx !== contextId) return;
        seq.answerWords(wt);
      },
      onDone: (ctx) => {
        if (ctx !== contextId) return;
        if (!downlinkClosed) {
          downlinkClosed = true;
          seq.answerDone();
        }
        settle();
      },
      onError: (err) => {
        console.warn(`[voice-tts] ${voiceStreamId}:`, err.message);
        if (err.name === "TtsVoiceLost") {
          // B3: both voices failed mid-answer. Its words are already on
          // screen; say so there rather than leave the call quietly short.
          // Not a voice-error: that would cut the audio still playing.
          transport.event({
            type: "voice-work",
            voiceStreamId,
            bot: botName,
            text: "(My voice dropped for the rest of that answer. It's all on screen.)",
            voiceCall: voiceStreamId,
          });
        }
        settle();
      },
    });

    const turn: SpokenTurn = {
      push(text) {
        feed.push(text);
      },
      boundary() {
        feed.boundary();
      },
      say(text) {
        if (settled) return;
        transport.event({
          type: "stream-chunk",
          streamId: voiceStreamId,
          botName,
          userId: user.userId,
          chunk: `${text} `,
          voiceCall: voiceStreamId,
        });
        tts.speakPiece(text, "checkin");
        recordVoiceAgentTurn(voiceStreamId, text);
      },
      finish() {
        feed.finish();
        tts.endTurn();
        // A barged-in turn is cancelled, so `done` would never arrive and the
        // durable record would never be written. Bound the wait so whatever
        // was actually spoken still reaches the thread.
        setTimeout(settle, SYNTH_SETTLE_TIMEOUT_MS).unref();
      },
      done,
      ttfbMs: () => ttfb,
      firstAudioAt: () => firstAudio,
      chars: () => tts.charsSent,
      workChars: () => workChars,
      models: () => (tts.lastTurnModels?.length ? tts.lastTurnModels.filter(Boolean) : [tts.activeModel]),
      seq,
      provider: tts.provider,
      closeDownlink() {
        if (downlinkClosed) return;
        downlinkClosed = true;
        // End the voice's turn WITHOUT flushing the sentence feed: a half
        // sentence the cancelled answer had buffered must never be spoken.
        // (No text reached the voice — the full reply only plays while the
        // answer has handed it nothing.) This also stops the HTTP voice's
        // keep-warm timer for the turn.
        tts.endTurn();
        seq.answerDone();
        settle();
      },
    };
    currentSpoken = turn;
    return turn;
  };

  /**
   * The front voice for this turn (voice/front-voice.ts): a fresh line
   * reacting to what he said, spoken only if the answer is still silent at
   * the deadline. Runs beside the answer and never delays it.
   */
  const startFrontVoice = (
    spoken: SpokenTurn | null,
    /** A full reply may BE the answer (the cold path); false where the answer is already complete. */
    mayAnswer = false,
    /** The turn's arbiter (voice/answer-ladder.ts): hears the gate's claim, admits its line. */
    ladder?: AnswerLadder,
  ): { controller: AbortController; result: Promise<FrontVoiceTurnResult> } | null => {
    const call = callFrontVoices.get(voiceStreamId);
    // The draft is this turn's or nobody's: taken (or dropped) whether or not the gate is used.
    const draft: GateDraft | null = callGateDrafts.get(voiceStreamId)?.take(transcript) ?? null;
    if (!spoken || !call || (!call.gate && !call.fv)) {
      draft?.cancel();
      return null;
    }
    const controller = new AbortController();
    activeFrontVoice.get(voiceStreamId)?.abort();
    activeFrontVoice.set(voiceStreamId, controller);
    const userKey = `${botName}:${user.userId}`;
    const provider = spoken.provider as CallTtsProvider;
    let line: Promise<GateLine | { line: string | null; reason?: string }>;
    if (call.gate) {
      const g = call.gate;
      const claim = (c: GateClaim): void => {
        if (!controller.signal.aborted) ladder?.claimTurn(c);
      };
      // The gate is asked (or its draft still out): the hold waits a moment for its first word.
      if (!draft?.settled && !draft?.claim) ladder?.asking(draft ? draft.startedAt : Date.now());
      let verdict: ReturnType<typeof frontGateFor>;
      if (draft) {
        // Drafted while he talked (voice/gate-draft.ts): often decided already.
        controller.signal.addEventListener("abort", () => draft.cancel(), { once: true });
        draft.onClaim(claim);
        verdict = draft.verdict.then((v) => ({ ...v, reason: `${v.reason},draft`, ms: Math.max(0, v.ms - (finalAt - draft.startedAt)) }));
      } else {
        // The call so far, without the line being answered (the gate gets that on its own) — as the ElevenLabs call does.
        const recentCall = recentVoiceLines(voiceStreamId, 7).slice(0, -1);
        verdict = frontGateFor(g.ask, userKey, transcript, recentCall, controller.signal, Date.now, g.persona, g.askEach, {
          onClaim: claim,
          clock: gateClockFor(user.userId),
          bridge: g.bridge,
        });
      }
      line = gateLine(verdict, mayAnswer).then((r) => {
        // The line that won may be another lane's kind than the first tag streamed: the claim follows the line (Codex, step 6).
        if (r.line && !r.answer && !controller.signal.aborted) ladder?.claimTurn(r.bridge ? "bridge" : "filler");
        if (r.verdict) {
          gateSeen = r.verdict;
          console.log(`[front-gate] ${voiceStreamId} ${r.verdict.kind} reason=${r.verdict.reason} ${r.verdict.ms}ms`);
        }
        return r;
      });
    } else {
      draft?.cancel();
      line = frontLineFor(call.fv!.generate, userKey, transcript, controller.signal, Date.now, call.fv!.persona);
    }
    const result = runFrontVoiceTurn({
      seq: spoken.seq,
      line,
      // The line IS the answer: the main turn stops before it says a word (front-gate.ts "full").
      onPlayed: (said, answer, bridge) => {
        // A WORK line or a bridge is this thought's holding sound; a FULL answers it (answer-ladder.ts).
        if (!answer) {
          if (bridge) bridgeSaid = said;
          book.held();
          return;
        }
        book.answered();
        fastTook = said;
        mainController?.abort(FRONT_FULL);
      },
      // Same model the answer is speaking on, read per turn: if the socket
      // refused the configured one mid-call, the filler follows the fallback.
      render: (text) => renderFillerPcm(instance.config, provider, text, voiceTtsStreams.get(voiceStreamId)?.activeModel),
      // Streamed: the line's first word plays without waiting for the rest (voice-speed). CALL_FILLER_STREAM=off = whole renders.
      ...(callFillerStreamOn()
        ? { stream: (text: string, onPcm: (pcm: Buffer) => void, signal: AbortSignal) => streamFillerPcm(instance.config, provider, text, voiceTtsStreams.get(voiceStreamId)?.activeModel, onPcm, signal) }
        : {}),
      // With the arbiter, a line plays the moment it is ready and admitted (a WORK line means the answer is 10 s+ away).
      deadlineMs: ladder ? 0 : frontVoiceDeadlineMs(),
      signal: controller.signal,
      startedAt: finalAt,
      ...(ladder ? { ladder } : {}),
    }).then((r) => {
      // A full reply is an answer, not a holding line: it does not go on the do-not-repeat list.
      if (r.played && !r.answer) rememberFrontLine(userKey, r.played);
      console.log(
        `[front-voice] ${voiceStreamId} ${r.played ? `${r.answer ? "answered" : "played"} at ${r.playedAtMs}ms` : `skipped (${r.skipped})`}` +
          (r.lineMs !== undefined ? ` line=${r.lineMs}ms` : ""),
      );
      return r;
    });
    return { controller, result };
  };

  const finishFrontVoice = async (
    front: ReturnType<typeof startFrontVoice>,
  ): Promise<FrontVoiceTurnResult | null> => {
    if (!front) return null;
    // The answer is fully synthesized: a filler that has not played by now
    // never will. Stop waiting on it.
    front.controller.abort();
    if (activeFrontVoice.get(voiceStreamId) === front.controller) activeFrontVoice.delete(voiceStreamId);
    return front.result;
  };

  const frontLog = (r: FrontVoiceTurnResult | null, spoken: SpokenTurn | null) => ({
    tts_provider: spoken?.provider,
    // Part five: what was shown as work lines and never synthesized.
    tts_chars: spoken?.chars(),
    work_chars: spoken?.workChars(),
    front_voice_line: r?.played ?? null,
    front_voice_skipped: r && !r.played ? r.skipped ?? null : null,
    front_voice_line_ms: r?.lineMs,
    front_voice_played_ms: r?.playedAtMs,
    any_first_audio_ms: spoken?.seq.firstAudioAt ? spoken.seq.firstAudioAt - finalAt : undefined,
    ...firstSound(spoken),
  });

  /**
   * Step 0's clock (voice-speed): his speech ended → the first sound of any
   * kind this turn sent toward him, per door. One line per turn, and the same
   * numbers in the turn log. The end is the first end-of-speech signal, so it
   * runs late by that signal's silence window (the report states it).
   */
  const firstSound = (spoken: SpokenTurn | null) => {
    const first = spoken?.seq.firstAudioAt ?? 0;
    const fromEnd = first && speechEndedAt ? first - speechEndedAt : undefined;
    const fromFinal = first ? first - finalAt : undefined;
    // The hold first: "One sec." then the fast answer is a hold turn by its first sound.
    const by = !first
      ? "none"
      : spoken!.seq.answerFirstAudioAt === first
        ? "answer"
        : holdPlayed
          ? "hold"
          : fastTook !== null
            ? "front-full"
            : bridgeSaid !== null
              ? "bridge"
              : "front-line";
    // A bridge's seam (voice step 6): silence on his side between its last word and the answer's first (0 = straight on).
    const answerAt = spoken?.seq.answerFirstAudioAt ?? 0;
    const bridgeGap = by === "bridge" && answerAt ? Math.max(0, Math.round(answerAt - first - (spoken!.seq.filler?.seconds ?? 0) * 1000)) : undefined;
    console.log(
      `[first-sound] ${new Date().toISOString()} ${voiceStreamId} door=${transport.kind} by=${by}` +
        ` speech-end+${fromEnd ?? "?"}ms final+${fromFinal ?? "?"}ms` +
        (gateSeen ? ` gate=${gateSeen.kind}/${gateSeen.ms}ms` : "") +
        (bridgeGap !== undefined ? ` bridge-gap=${bridgeGap}ms` : ""),
    );
    return {
      door: transport.kind,
      first_sound_by: by,
      hold_line_ms: holdPlayed?.atMs,
      speech_end_to_first_audio_ms: fromEnd,
      front_gate: gateSeen?.kind,
      front_gate_reason: gateSeen?.reason,
      front_gate_ms: gateSeen?.ms,
    };
  };

  const deliver = async (
    result: Awaited<ReturnType<typeof invokeAgent>>,
    spoken: SpokenTurn | null,
  ): Promise<void> => {
    // The agent's half of the server's own call record (R4-1).
    //
    // A voice reply is no longer written to the thread as a message at all —
    // the call's transcript IS its record — so this is the only place the
    // agent's words are captured for the card the server writes when the
    // client cannot report one.
    // Work lines (part five) were shown, not said; the record marks them.
    // Files and bills the agent handed over on the call land in the chat / the
    // Bills tab of the caller, exactly as in text (chat-files/sentinel.ts).
    result.response = takeSentinelFiles(result.response, { userId: user.userId, admin: user.admin, bot: botName });
    // Cut off before it got here (a barge-in mid-generation that did not
    // abort in time): the record already holds what he heard, and keeps it.
    const cuts = callCutsFor(voiceStreamId);
    if (cuts.mayRecordFull(spoken?.seq ?? null)) {
      cuts.recorded(spoken?.seq ?? null, recordVoiceAgentTurn(voiceStreamId, result.response.replace(/^(\s*)» ?/gm, "$1(on screen) ")));
    }

    try {
      if (spoken) {
        // The live path already spoke this turn frame by frame. Voice-mode
        // replies stay in the call transcript, so there is no chat message or
        // durable voice-note artifact to upsert here.
        await spoken.done;
      } else {
        // DEGRADED PATH — availability, not design.
        //
        // Reached only when the call has no usable Cartesia socket (handshake
        // failed, or it dropped mid-call). The streamed downlink is the one
        // designed experience; this exists so a third-party blip costs the
        // user audio quality rather than the reply itself. It is logged loudly
        // because a call quietly served this way looks like a latency
        // regression with no cause.
        console.warn(
          `[voice-turn] ${voiceStreamId}: no TTS stream — falling back to blob synthesis`,
        );
        if (transport.kind === "phone") {
          // The phone cannot play a file: it says the reply itself, in the
          // call's voice and spoken lines only (phone/stream.ts). Synthesizing
          // a blob here too would pay for the same words twice.
          transport.event({ type: "voice-tts", voiceStreamId, bot: botName, audioBase64: "", mimeType: "", text: result.response });
          return;
        }
        let audioBuffer: Buffer | null = null;
        let mimeType = "";
        const tts = await synthesizeSpeech({
          text: result.response,
          voice: instance.config.voice,
          provider: instance.config.ttsProvider,
          googleVoice: instance.config.googleVoice,
          geminiVoice: instance.config.geminiVoice,
          styleInstructions: instance.config.styleInstructions,
          agentName: instance.config.name,
          eleven: instance.config.eleven,
          cartesia: instance.config.cartesia,
        });
        if (tts?.audioBuffer?.length) {
          audioBuffer = tts.audioBuffer;
          mimeType = tts.mimeType ?? "";
        }
        transport.event({
          type: "voice-tts",
          voiceStreamId,
          bot: botName,
          audioBase64: audioBuffer ? audioBuffer.toString("base64") : "",
          mimeType,
          text: result.response,
        });
      }
    } catch (err) {
      console.error("[voice-turn] TTS error:", (err as Error).message);
    }
  };

  const runCold = async (abortReason: "edit_distance" | "timeout" | "user_bargein" | "manual_cancel" | "other" | null): Promise<void> => {
    const controller = new AbortController();
    activeVoiceControllers.set(voiceStreamId, controller);
    mainController = controller;
    const coldStarted = Date.now();
    let front: ReturnType<typeof startFrontVoice> = null;
    let spokenTurn: SpokenTurn | null = null;
    let ladder: AnswerLadder | null = null;
    // What the fast voice settled alone since the main brain last finished: said, not to be said again.
    const fastBefore = [...(callFastNotes.get(voiceStreamId) ?? [])];
    /** The fast voice's reply was the whole answer: close the turn with nothing more said. */
    const finishFast = async (spoken: SpokenTurn | null): Promise<void> => {
      const said = fastTook ?? "";
      const frontResult = await finishFrontVoice(front);
      front = null;
      // The downlink ends behind the line: once all of its audio is out (streamed), bounded.
      if (frontResult?.audioDone) await Promise.race([frontResult.audioDone, new Promise((r) => setTimeout(r, 10_000).unref())]);
      spoken?.closeDownlink();
      recordVoiceAgentTurn(voiceStreamId, said);
      const notes = callFastNotes.get(voiceStreamId) ?? [];
      notes.push({ heard: transcript, said });
      if (notes.length > 6) notes.shift();
      callFastNotes.set(voiceStreamId, notes);
      console.log(`[voice-turn] ${voiceStreamId} answered by the fast voice in ${Date.now() - finalAt}ms — main turn cancelled`);
      logTurn({
        ...baseLog,
        ...frontLog(frontResult, spoken),
        spec_invoked: !!spec,
        spec_committed: false,
        spec_aborted: !!spec,
        cost_usd_final: 0,
        tts_path: spoken ? "stream" : "blob",
        first_audio_ms: undefined,
        latency_final_to_audio_ms: Date.now() - finalAt,
        spec_abort_reason: abortReason,
      });
    };
    try {
      // Open the TTS context BEFORE invoking. This is the whole point of the
      // cold path: text is spoken as it generates, so the reply starts coming
      // out of the speaker while the agent is still writing the end of it.
      const spoken = beginSpokenTurn();
      spokenTurn = spoken;
      // One arbiter owns what he hears first this turn (voice/answer-ladder.ts): the fast
      // layer's instant answer, its WORK line, or "One sec." at 1.4 s after his speech
      // ended — never two holding sounds. No hold on a bare greeting, yes/no or thanks.
      if (spoken) {
        const hold = holdMs();
        const bank = hold > 0 ? holdBankFor(instance.config, spoken.provider as CallTtsProvider, voiceTtsStreams.get(voiceStreamId)?.activeModel) : null;
        const seq = spoken.seq;
        const startedAt = Date.now();
        ladder = new AnswerLadder({
          seq,
          // A queued addition runs after the turn before it: its silence starts now, not when he spoke.
          anchorAt: mode === "queue" ? startedAt : speechEndedAt && speechEndedAt <= finalAt ? speechEndedAt : finalAt,
          startedAt,
          // No hold on a bare beat; none on a turn queued behind work (it ran long after he spoke, voice step 5).
          holdMs: bank && bareBeat(transcript) !== null && (mode !== "queue" || queuedTurnHolds()) ? hold : 0,
          claimMs: ladderClaimMs(),
          askMs: ladderAskMs(),
          askFloorMs: ladderAskFloorMs(),
          graceMs: ladderGraceMs(),
          bridgeWaitMs: ladderBridgeWaitMs(),
          thoughtHeld,
          ...(holdWaitsForSilence() ? { talking: () => callTalking(voiceStreamId) } : {}),
          playHold: () => {
            const line = bank?.next();
            if (!line || !seq.offerFiller(line.text, line.pcm)) return null;
            book.held();
            holdPlayed = { text: line.text, atMs: Date.now() - finalAt };
            console.log(`[hold] ${voiceStreamId} played at ${holdPlayed.atMs}ms`);
            return line.text;
          },
          signal: controller.signal,
          log: (l) => console.log(l.replace("[ladder]", `[ladder] ${voiceStreamId}`)),
        });
      }
      turnLadder = ladder;
      // The front voice starts with the answer, not after it: its line is
      // being written while the main model is still reading the prompt.
      front = startFrontVoice(spoken, true, ladder ?? undefined);
      let streamedChars = 0;
      let result: Awaited<ReturnType<typeof invokeAgent>>;
      const onStreamEvent = (e: Parameters<NonNullable<Parameters<typeof invokeAgent>[0]["onStreamEvent"]>>[0]): void => {
        // The fast voice's reply was the whole answer: nothing of this turn may follow it.
        if (controller.signal.reason === FRONT_FULL) return;
        // `voiceCall` tells the PWA these tokens belong to a call. The
        // voice screen needs them — the karaoke line takes its words from
        // what the agent actually wrote — but the chat thread must not
        // raise a streaming bubble for a reply being spoken on another
        // surface. Nothing would ever clear that bubble either: a voice
        // reply is no longer written to the thread as a message, so the
        // out-message that used to consume the stream card never arrives.
        // It would just sit in the thread after the call (R4-2).
        // With a live voice, text reaches the screen through the spoken
        // feed (split into spoken and work lines); raw tokens are not
        // forwarded, or every line would show twice.
        if (e.type === "stream-chunk") {
          live?.note("text");
          // No live voice: the reply is shown, not spoken — still a reply line.
          if (!spoken && e.chunk && rt) rt.spokenLines++;
        } else if (e.type === "stream-tool-use") {
          live?.note("tool");
          if (rt) rt.toolStarted = true;
        }
        if (!(spoken && e.type === "stream-chunk")) transport.event({ ...e, voiceCall: voiceStreamId });
        if (spoken && e.type === "stream-chunk" && e.chunk) {
          streamedChars += e.chunk.length;
          spoken.push(e.chunk);
        }
        // The message before a tool call is complete: say it while the
        // tool runs, not after the whole turn.
        if (spoken && e.type === "stream-tool-use") spoken.boundary();
      };
      try {
        result = await withBotSlot(botName, () =>
          invokeAgent({
            // Same brain, same memory as chat — see voice/voice-invoke.ts.
            ...voiceTurnInvokeOptions(instance.config, user, voiceStreamId),
            // Miriam serves two people: the call tells her who is on it, as Telegram does.
            message: tagDashboardMessageForBot(fastAnswersNote(fastBefore) + agentMessage, botName, user),
            ...(hints?.extraSystemHint ? { extraSystemHint: hints.extraSystemHint } : {}),
            ...(hints?.disallowedTools?.length ? { disallowedTools: hints.disallowedTools } : {}),
            ...(screenImages.length || dropImages.length ? { images: [...screenImages, ...dropImages] } : {}),
            sessionMap: instance.sessionMap,
            config,
            onStreamEvent,
            abortSignal: controller.signal,
          }),
        );
      } catch (err) {
        // Cancelled for the fast voice's full reply: that line was the turn.
        if (fastTook !== null && controller.signal.reason === FRONT_FULL) return await finishFast(spoken);
        throw err;
      }
      if (fastTook !== null && controller.signal.reason === FRONT_FULL) return await finishFast(spoken);
      // The main brain has these in its session now.
      if (fastBefore.length) callFastNotes.get(voiceStreamId)?.splice(0, fastBefore.length);
      // Short replies sometimes arrive whole with no deltas at all. Without
      // this they would be silent — text in the thread, nothing spoken.
      if (spoken && streamedChars === 0 && result.response) spoken.push(result.response);
      spoken?.finish();
      await deliver(result, spoken);
      // The turn ran to its end: whatever it said answered him (a new thought starts next).
      if (!controller.signal.aborted) book.answered();
      const frontResult = await finishFrontVoice(front);
      front = null;
      logTurn({
        ...baseLog,
        ...frontLog(frontResult, spoken),
        spec_invoked: !!spec,
        spec_committed: false,
        spec_aborted: !!spec,
        input_tokens_spec: spec?.result?.inputTokens ?? 0,
        input_tokens_final: result.inputTokens ?? 0,
        output_tokens: result.outputTokens ?? 0,
        cost_usd_spec: spec?.result?.cost ?? 0,
        cost_usd_final: result.cost ?? 0,
        cost_usd_wasted: spec?.result?.cost ?? 0,
        tts_path: spoken ? "stream" : "blob",
        tts_models: spoken?.models(),
        tts_ttfb_ms: spoken?.ttfbMs(),
        first_audio_ms: spoken?.firstAudioAt() ? spoken.firstAudioAt() - finalAt : undefined,
        latency_final_to_audio_ms: Date.now() - finalAt,
        baseline_estimate_ms: Date.now() - coldStarted,
        latency_saved_ms: 0,
        interim_text: spec?.interimText,
        normalized_levenshtein: distance,
        spec_abort_reason: abortReason,
      });
    } finally {
      ladder?.close();
      if (front) void finishFrontVoice(front);
      // Superseded or barged: a paced filler still going out is speech nobody asked for.
      // (A full reply is the answer and went out whole: nothing of it is left to stop.)
      if (controller.signal.aborted && controller.signal.reason !== FRONT_FULL) spokenTurn?.seq.stopFiller();
      if (mainController === controller) mainController = null;
      activeVoiceControllers.delete(voiceStreamId);
    }
  };

  // Everything below is ONE turn. It runs through the session's gate, which
  // guarantees it is never entered while a previous turn is still generating
  // — that turn is superseded first.
  const runTurn = async (): Promise<void> => {
    // The call hung up while this turn was queued (or deciding it was an ack).
    if (voiceCallEnded(voiceStreamId)) {
      console.log(`[voice-turn] ${voiceStreamId} dropped — the call has ended`);
      return;
    }
    // For as long as this turn runs, the listener is told it is alive — one
    // content-free `voice-working` every few seconds — and after a long
    // silence hears one calm line. The app's watchdog counts the beats as
    // life; without them, 45 s of honest tool work ended the call
    // (voice-call-drop). Ends with the turn, however it ends.
    // A queued turn is the running one from the moment it starts.
    rt ??= book.begin(transcript, finalAt, pieces);
    live = beginWorkingTurn({
      voiceStreamId,
      bot: botName,
      send: (msg) => transport.event(msg),
      say: (text) => currentSpoken?.say(text),
    });
    // A status question or an addition heard mid-turn is answered INTO this
    // turn's voice (work-gate.ts) — the only way to speak without stopping it.
    callSayers.set(voiceStreamId, (text) => {
      if (!currentSpoken) return false;
      currentSpoken.say(text);
      return true;
    });
    try {
      await runTurnBody();
    } finally {
      live.end();
      live = null;
      currentSpoken = null;
      callSayers.delete(voiceStreamId);
      // Nothing more of this turn will be said: its lane never holds the air past it (voice/mouth.ts).
      mouthFor(voiceStreamId)?.turnOver(turnId);
      if (rt) book.end(rt);
      // The floor stays open for a while after his last line (voice/floor.ts).
      voiceAgentTurnEnded(voiceStreamId);
    }
  };

  const runTurnBody = async (): Promise<void> => {
    // A speculative answer was written without the fast voice's "already answered" note:
    // while one is pending, the turn runs cold so the note reaches it.
    const fastPending = (callFastNotes.get(voiceStreamId)?.length ?? 0) > 0;
    if (spec && !fastPending && !screenImages.length && !drops.length && distance !== undefined && distance <= specEditDistanceMax()) {
      await Promise.race([
        spec.invokePromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
      ])
        .then(async (result) => {
          if (!result) {
            abortSpeculativeTurn(voiceStreamId, "timeout");
            await runCold("timeout");
            return;
          }
          commitSpeculativeTurn(voiceStreamId);
          // A committed speculative reply is already COMPLETE, so there is
          // nothing left to stream progressively — the text goes into the
          // same Cartesia context the cold path uses and starts speaking at
          // Sonic's TTFB. One downlink behaviour for every turn in the call:
          // the client cannot tell a speculated turn from a cold one, which
          // is the point.
          const spoken = beginSpokenTurn();
          const front = startFrontVoice(spoken);
          if (result.response) {
            // The speculative invoke runs without an `onStreamEvent`, so the
            // client never saw a token of this reply — and the karaoke line
            // takes its TIMING from Cartesia but its words from the agent's
            // own text. With nothing to match against, a committed turn
            // rendered the synthesiser's bare tokens: lowercase, unpunctuated,
            // numbers spelled out. Visibly a different class of reply from a
            // cold turn, which is exactly what committing is supposed to be
            // indistinguishable from. The reply is already complete here, so
            // it goes out as one chunk.
            // With a live voice the feed shows it (spoken and work lines);
            // without one it goes out whole, as before.
            if (spoken) spoken.push(result.response);
            else
              transport.event({
                type: "stream-chunk",
                streamId: voiceStreamId,
                botName,
                userId: user.userId,
                chunk: result.response,
                voiceCall: voiceStreamId,
              });
          }
          spoken?.finish();
          await deliver(result, spoken);
          book.answered();
          const frontResult = await finishFrontVoice(front);
          const latency = Date.now() - finalAt;
          logTurn({
            ...baseLog,
            ...frontLog(frontResult, spoken),
            spec_invoked: true,
            spec_committed: true,
            spec_aborted: false,
            input_tokens_spec: result.inputTokens ?? 0,
            input_tokens_final: 0,
            output_tokens: result.outputTokens ?? 0,
            cost_usd_spec: result.cost ?? 0,
            cost_usd_final: 0,
            cost_usd_wasted: 0,
            tts_path: spoken ? "stream" : "blob",
            tts_models: spoken?.models(),
            tts_ttfb_ms: spoken?.ttfbMs(),
            first_audio_ms: spoken?.firstAudioAt() ? spoken.firstAudioAt() - finalAt : undefined,
            latency_final_to_audio_ms: latency,
            baseline_estimate_ms: result.durationMs,
            latency_saved_ms: Math.max(0, (result.durationMs ?? latency) - latency),
            interim_text: spec.interimText,
            normalized_levenshtein: distance,
            spec_abort_reason: null,
          });
          console.log(`[voice-spec] committed ${voiceStreamId} distance=${distance.toFixed(3)}`);
        })
        .catch(async (err) => {
          if ((err as Error)?.name === "AbortError") return;
          console.warn("[voice-spec] failed, cold fallback:", (err as Error).message);
          await runCold("other");
        });
      return;
    }

    if (spec) abortSpeculativeTurn(voiceStreamId, "edit_distance");

    await runCold(spec ? "edit_distance" : null).catch(coldFailed);
  };

  /** A turn that failed or was superseded: said and logged once, the same for every path. */
  const coldFailed = (err: unknown): void => {
    if (isSupersededVoiceTurn(err)) {
      console.log(`[voice-turn] superseded ${voiceStreamId}`);
      return;
    }
    if (err instanceof ConcurrencyCapError) {
      console.warn("[voice-turn] dropped — cap hit:", err.message);
      const msg = "I'm handling another message right now. One sec.";
      transport.event({ type: "voice-error", voiceStreamId, bot: botName, error: msg });
      transport.event({
        type: "voice-tts",
        voiceStreamId,
        bot: botName,
        audioBase64: "",
        mimeType: "",
        text: msg,
      });
      logTurn({
        ...baseLog,
        spec_invoked: !!spec,
        spec_committed: false,
        spec_aborted: !!spec,
        interim_text: spec?.interimText,
        normalized_levenshtein: distance,
        spec_abort_reason: spec ? "edit_distance" : null,
      });
      return;
    }
    console.error("[voice-turn] invokeAgent failed:", err);
    const msg = "Error processing voice turn. Try again.";
    transport.event({ type: "voice-error", voiceStreamId, bot: botName, error: msg });
    transport.event({
      type: "voice-tts",
      voiceStreamId,
      bot: botName,
      audioBase64: "",
      mimeType: "",
      text: msg,
    });
  };

  const gate = voiceTurnGateFor(voiceStreamId);
  void (mode === "queue" ? gate.queue(runTurn) : gate.submit(runTurn)).then(() => {
    // Retire the gate only when NOTHING is left — running or queued.
    //
    // Checking `busy` here was a real bug: between a settling turn and the
    // queued one behind it, `busy` is false while work is still pending. The
    // gate got dropped mid-session, the next utterance built a FRESH gate,
    // and that gate superseded nothing — so two turns ran side by side and
    // killed each other. That is precisely the two-utterances-zero-replies
    // failure the gate exists to prevent, resurrected by its own cleanup.
    if (gate.idle && voiceTurnGates.get(voiceStreamId) === gate) {
      voiceTurnGates.delete(voiceStreamId);
    }
  });
}

if (config.mode === "webhook") {
  const basePath = `/webhook`;
  for (const instance of instances) {
    if (instance.config.token) setupWebhook(app, instance, basePath);
  }
} else {
  // Start the bots that have a Telegram token in polling mode concurrently; the rest live in the app only.
  for (const instance of instances) {
    if (instance.config.token) startPolling(instance);
  }
}

// Is the gateway itself stalling? One histogram, a line per bad second (voice/loop-watch.ts).
startLoopWatch();

// Start HTTP server
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[gateway] AHI Gateway listening on port ${info.port}`);
  console.log(`[gateway] Dashboard: http://localhost:${info.port}/ui`);
  console.log(`[gateway] Health: http://localhost:${info.port}/health`);
  console.log(`[gateway] Bots: ${instances.map((i) => i.config.name).join(", ")}`);
  // Calls the last process died under: held for the app to resume, else carded.
  restoreLiveCalls();
  if (turnResumer) {
    const delay = Number(process.env.TURN_RESUME_BOOT_DELAY_MS ?? 5_000);
    setTimeout(() => {
      turnResumer
        .boot()
        .then((r) => {
          if (r.resumed + r.noticed + r.deferred + r.failed + r.gaveUp + r.skipped > 0) console.log(`[turn-resume] boot drain: ${JSON.stringify(r)}`);
        })
        .catch((err) => console.error("[turn-resume] boot drain failed:", err));
    }, Number.isFinite(delay) && delay >= 0 ? delay : 5_000).unref();
  }
});

// Handle WebSocket upgrades for /ui/ws (the app) and /api/phone/stream (Twilio)
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (url.startsWith("/ui/ws")) {
    handleUpgrade(req, socket, head);
  } else if (phone && (url === "/api/phone/stream" || url.startsWith("/api/phone/stream?"))) {
    phone.handleUpgrade(req, socket as import("node:net").Socket, head);
  } else if (eleven.handleUpgrade(req, socket as import("node:net").Socket, head)) {
    // ElevenLabs' upstream socket (voice/eleven/upstream.ts) — handled or refused there.
  } else {
    socket.destroy();
  }
});
