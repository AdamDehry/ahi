import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createBot, setupWebhook, startPolling, type BotInstance } from "./telegram.js";
import { createDashboard } from "./dashboard.js";
import {
  handleUpgrade,
  setVoiceTurnHandler,
  setVoiceTentativeHandler,
  setVoiceInterruptHandler,
  setVoiceSpecCancelHandler,
  sendTtsAudio,
  sendVoiceThinking,
  broadcast,
  broadcastEvent,
} from "./websocket.js";
import { applySavedSettings } from "./bot-settings.js";
import { watchMissionControl } from "./mission-control.js";
import { invokeAgent } from "./claude-invoke.js";
import { withBotSlot, ConcurrencyCapError } from "./concurrency.js";
import { synthesizeSpeech } from "./voice-out.js";
import { recordStartupAndCheckThrottle } from "./crash-throttle.js";
import { acquireSingletonLockOrExit } from "./singleton.js";
import {
  abortSpeculativeTurn,
  attachSpeculativeTts,
  commitSpeculativeTurn,
  getSpeculativeTurn,
  startSpeculativeTurn,
} from "./spec-state.js";
import { normalizedLevenshtein } from "./levenshtein.js";
import { isRuntimeSpeculationEnabled, logTurn } from "./turn-logger.js";

// ── OS-level singleton ───────────────────────────────────────────────────────
// BEFORE anything else: enforce that only one gateway process exists. The
// per-process concurrency cap in concurrency.ts is useless if two processes
// are both polling — each has its own cap, effective concurrency doubles.
// Lockfile at $AHI_HOME/state/logs/gateway.pid. Exits(1) loudly if another live gateway
// owns the lock; reaps stale PIDs from crashed predecessors. See singleton.ts.
acquireSingletonLockOrExit();

// ── Crash-loop throttle ──────────────────────────────────────────────────────
// First thing we do at startup: record the timestamp and check if we've been
// restarting in a hot loop. If 3+ startups within 5min, write a loud marker
// file so the operator knows on next glance. Protection #4 — see crash-throttle.ts.
const throttle = recordStartupAndCheckThrottle();
if (throttle.crashLoop) {
  console.error(
    `[gateway] CRASH LOOP DETECTED — ${throttle.recentCount} startups in last ${throttle.windowMs / 60000}min. ` +
    `See $AHI_HOME/state/logs/gateway.CRASHED-REPEATEDLY. Continuing boot but flagging loudly.`,
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

const config = loadConfig();
applySavedSettings(config.bots);
watchMissionControl();

const app = new Hono();

// Create a bot instance for each configured bot
const instances: BotInstance[] = config.bots.map((botCfg) => createBot(botCfg, config));
const activeVoiceControllers = new Map<string, AbortController>();

// Mount dashboard routes
const dashboard = createDashboard(instances, config);
app.route("/", dashboard);

// Voice upload relay — accepts base64-encoded audio from Tasker wake words
// POST /voice-upload?bot=michael&chat_id=6541121975
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

// Health check
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    bots: instances.map((i) => ({
      name: i.config.name,
      model: i.config.model,
      voice: i.config.voice,
    })),
    mode: config.mode,
    uptime: process.uptime(),
  });
});

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

function voiceChatId(user: { telegramChatId: number | null }, instance: BotInstance): number {
  return user.telegramChatId ?? instance.lastChatId ?? 0;
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
  const chatId = voiceChatId(opts.user, instance);
  const invokePromise = withBotSlot(opts.botName, () =>
    invokeAgent({
      chatId,
      botName: opts.botName,
      message: opts.interimText,
      sessionMap: instance.sessionMap,
      config,
      model: instance.config.model,
      abortSignal: controller.signal,
      telegramUser: opts.user.userId,
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
  attachSpeculativeTts(
    turn.voiceStreamId,
    invokePromise.then((result) =>
      synthesizeSpeech({
        text: result.response,
        voice: instance.config.voice,
        provider: instance.config.ttsProvider,
        googleVoice: instance.config.googleVoice,
        geminiVoice: instance.config.geminiVoice,
        styleInstructions: instance.config.styleInstructions,
      }),
    ),
  );
  console.log(`[voice-spec] started ${opts.voiceStreamId} bot=${opts.botName} user=${opts.user.userId}`);
});

setVoiceSpecCancelHandler(({ voiceStreamId, reason }) => {
  abortSpeculativeTurn(voiceStreamId, reason);
});

setVoiceInterruptHandler(({ voiceStreamId }) => {
  abortSpeculativeTurn(voiceStreamId, "user_bargein");
  activeVoiceControllers.get(voiceStreamId)?.abort("user_bargein");
});

// ── Voice Mode turn handler (H-026 Phase 7 + H-040 B1) ──────────────────────
setVoiceTurnHandler(({ botName, transcript, voiceStreamId, ws, user, audioRoute, voiceStartedAt }) => {
  const instance = instances.find((i) => i.config.name === botName);
  if (!instance) {
    console.warn(`[voice-turn] unknown bot: ${botName}`);
    return;
  }

  // Echo the user's transcribed turn into the persistent feed as a PWA
  // message so the Text Chat view reflects it when the user swipes down
  // from voice mode back into chat. Same source tag ("app") as
  // /app/send so it lands in the retrieval corpus.
  const chatId = voiceChatId(user, instance);
  const finalAt = Date.now();
  const spec = getSpeculativeTurn(voiceStreamId);
  const distance = spec ? normalizedLevenshtein(spec.interimText, transcript) : undefined;
  const baseLog = {
    turn_id: voiceStreamId,
    user: user.userId,
    ts: new Date().toISOString(),
    model: instance.config.model,
    final_text: transcript,
    audio_route: audioRoute,
    stt_final_ms: finalAt - voiceStartedAt,
  };
  broadcast({
    type: "message",
    bot: botName,
    direction: "in",
    contentType: "voice",
    text: transcript,
    timestamp: new Date().toISOString(),
    chatId,
    userId: user.userId,
    senderName: user.name,
    source: "app",
  });

  sendVoiceThinking(ws, { voiceStreamId, bot: botName });

  const deliver = async (
    result: Awaited<ReturnType<typeof invokeAgent>>,
    prebuiltTts?: Awaited<ReturnType<typeof synthesizeSpeech>>,
  ): Promise<void> => {
    broadcast({
      type: "message",
      bot: botName,
      direction: "out",
      contentType: "text",
      text: result.response,
      timestamp: new Date().toISOString(),
      chatId,
      userId: user.userId,
      senderName: user.name,
      source: "app",
    });
    try {
      const tts = prebuiltTts ?? await synthesizeSpeech({
        text: result.response,
        voice: instance.config.voice,
        provider: instance.config.ttsProvider,
        googleVoice: instance.config.googleVoice,
        geminiVoice: instance.config.geminiVoice,
        styleInstructions: instance.config.styleInstructions,
      });
      sendTtsAudio(ws, {
        voiceStreamId,
        bot: botName,
        audioBase64: tts ? tts.audioBuffer.toString("base64") : "",
        mimeType: tts?.mimeType ?? "",
        text: result.response,
      });
    } catch (err) {
      console.error("[voice-turn] TTS error:", (err as Error).message);
      sendTtsAudio(ws, {
        voiceStreamId,
        bot: botName,
        audioBase64: "",
        mimeType: "",
        text: result.response,
      });
    }
  };

  const runCold = async (abortReason: "edit_distance" | "timeout" | "user_bargein" | "manual_cancel" | "other" | null): Promise<void> => {
    const controller = new AbortController();
    activeVoiceControllers.set(voiceStreamId, controller);
    const coldStarted = Date.now();
    try {
      const result = await withBotSlot(botName, () =>
        invokeAgent({
          chatId,
          botName,
          message: transcript,
          sessionMap: instance.sessionMap,
          config,
          model: instance.config.model,
          onStreamEvent: (e) => broadcastEvent(e),
          abortSignal: controller.signal,
          telegramUser: user.userId,
        }),
      );
      await deliver(result);
      logTurn({
        ...baseLog,
        spec_invoked: !!spec,
        spec_committed: false,
        spec_aborted: !!spec,
        input_tokens_spec: spec?.result?.inputTokens ?? 0,
        input_tokens_final: result.inputTokens ?? 0,
        output_tokens: result.outputTokens ?? 0,
        cost_usd_spec: spec?.result?.cost ?? 0,
        cost_usd_final: result.cost ?? 0,
        cost_usd_wasted: spec?.result?.cost ?? 0,
        latency_final_to_audio_ms: Date.now() - finalAt,
        baseline_estimate_ms: Date.now() - coldStarted,
        latency_saved_ms: 0,
        interim_text: spec?.interimText,
        normalized_levenshtein: distance,
        spec_abort_reason: abortReason,
      });
    } finally {
      activeVoiceControllers.delete(voiceStreamId);
    }
  };

  if (spec && distance !== undefined && distance <= specEditDistanceMax()) {
    Promise.race([
      spec.invokePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ])
      .then(async (result) => {
        if (!result) {
          abortSpeculativeTurn(voiceStreamId, "timeout");
          await runCold("timeout");
          return;
        }
        const committed = commitSpeculativeTurn(voiceStreamId);
        const tts = committed?.tts ?? await Promise.race([
          committed?.ttsPromise ?? Promise.resolve(null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200)),
        ]);
        await deliver(result, tts ?? undefined);
        const latency = Date.now() - finalAt;
        logTurn({
          ...baseLog,
          spec_invoked: true,
          spec_committed: true,
          spec_aborted: false,
          input_tokens_spec: result.inputTokens ?? 0,
          input_tokens_final: 0,
          output_tokens: result.outputTokens ?? 0,
          cost_usd_spec: result.cost ?? 0,
          cost_usd_final: 0,
          cost_usd_wasted: 0,
          latency_final_to_audio_ms: latency,
          baseline_estimate_ms: result.durationMs,
          latency_saved_ms: Math.max(0, (result.durationMs ?? latency) - latency),
          interim_text: spec.interimText,
          normalized_levenshtein: distance,
          spec_abort_reason: null,
        });
        console.log(`[voice-spec] committed ${voiceStreamId} distance=${distance.toFixed(3)}`);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError") return;
        console.warn("[voice-spec] failed, cold fallback:", (err as Error).message);
        void runCold("other");
      });
    return;
  }

  if (spec) abortSpeculativeTurn(voiceStreamId, "edit_distance");

  runCold(spec ? "edit_distance" : null).catch((err) => {
      if ((err as Error)?.name === "AbortError") {
        console.log(`[voice-turn] aborted ${voiceStreamId}`);
        return;
      }
      if (err instanceof ConcurrencyCapError) {
        console.warn("[voice-turn] dropped — cap hit:", err.message);
        const msg = "I'm handling another message right now. One sec.";
        broadcast({
          type: "message",
          bot: botName,
          direction: "out",
          contentType: "text",
          text: msg,
          timestamp: new Date().toISOString(),
          chatId,
          userId: user.userId,
          senderName: user.name,
          source: "app",
        });
        sendTtsAudio(ws, {
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
      broadcast({
        type: "message",
        bot: botName,
        direction: "out",
        contentType: "text",
        text: "Error processing voice turn. Try again.",
        timestamp: new Date().toISOString(),
        chatId,
        userId: user.userId,
        senderName: user.name,
        source: "app",
      });
      sendTtsAudio(ws, {
        voiceStreamId,
        bot: botName,
        audioBase64: "",
        mimeType: "",
        text: "Error processing voice turn. Try again.",
      });
    });
});

if (config.mode === "webhook") {
  const basePath = `/webhook`;
  for (const instance of instances) {
    setupWebhook(app, instance, basePath);
  }
} else {
  // Start all bots in polling mode concurrently
  for (const instance of instances) {
    startPolling(instance);
  }
}

// Start HTTP server
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[gateway] AHI Gateway listening on port ${info.port}`);
  console.log(`[gateway] Dashboard: http://localhost:${info.port}/ui`);
  console.log(`[gateway] Health: http://localhost:${info.port}/health`);
  console.log(`[gateway] Bots: ${instances.map((i) => i.config.name).join(", ")}`);
});

// Handle WebSocket upgrades for /ui/ws
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (url.startsWith("/ui/ws")) {
    handleUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});
