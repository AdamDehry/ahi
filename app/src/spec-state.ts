import type { InvokeResult } from "./claude-invoke.js";
import type { TTSResult } from "./voice-out.js";

export type SpecAbortReason =
  | "edit_distance"
  | "timeout"
  | "user_bargein"
  | "manual_cancel"
  | "other";

export interface SpeculativeTurn {
  voiceStreamId: string;
  botName: string;
  userId: string;
  interimText: string;
  startedAt: number;
  controller: AbortController;
  invokePromise: Promise<InvokeResult>;
  ttsPromise?: Promise<TTSResult | null>;
  result?: InvokeResult;
  tts?: TTSResult | null;
  abortReason?: SpecAbortReason;
}

const turns = new Map<string, SpeculativeTurn>();
const outcomes: Array<{ ts: number; aborted: boolean }> = [];

export function startSpeculativeTurn(
  turn: Omit<SpeculativeTurn, "startedAt">,
): SpeculativeTurn {
  const existing = turns.get(turn.voiceStreamId);
  if (existing) return existing;
  const full: SpeculativeTurn = { ...turn, startedAt: Date.now() };
  turns.set(turn.voiceStreamId, full);
  turn.invokePromise
    .then((result) => {
      full.result = result;
      return result;
    })
    .catch((err) => {
      if (!full.abortReason) full.abortReason = classifyAbort(err);
    });
  turn.ttsPromise
    ?.then((tts) => {
      full.tts = tts;
      return tts;
    })
    .catch(() => {
      full.tts = null;
    });
  return full;
}

export function attachSpeculativeTts(
  voiceStreamId: string,
  ttsPromise: Promise<TTSResult | null>,
): void {
  const turn = turns.get(voiceStreamId);
  if (!turn) return;
  turn.ttsPromise = ttsPromise;
  ttsPromise
    .then((tts) => {
      turn.tts = tts;
    })
    .catch(() => {
      turn.tts = null;
    });
}

export function getSpeculativeTurn(voiceStreamId: string): SpeculativeTurn | null {
  return turns.get(voiceStreamId) ?? null;
}

export function abortSpeculativeTurn(
  voiceStreamId: string,
  reason: SpecAbortReason,
): SpeculativeTurn | null {
  const turn = turns.get(voiceStreamId);
  if (!turn) return null;
  turn.abortReason = reason;
  try {
    turn.controller.abort(reason);
  } catch {
    /* noop */
  }
  turns.delete(voiceStreamId);
  recordOutcome(true);
  return turn;
}

export function commitSpeculativeTurn(voiceStreamId: string): SpeculativeTurn | null {
  const turn = turns.get(voiceStreamId);
  if (!turn) return null;
  turns.delete(voiceStreamId);
  recordOutcome(false);
  return turn;
}

export function clearSpeculativeTurn(voiceStreamId: string): void {
  turns.delete(voiceStreamId);
}

export function rollingAbortRate(windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  const recent = outcomes.filter((o) => o.ts >= cutoff);
  if (recent.length === 0) return 0;
  return recent.filter((o) => o.aborted).length / recent.length;
}

function recordOutcome(aborted: boolean): void {
  const now = Date.now();
  outcomes.push({ ts: now, aborted });
  const cutoff = now - 24 * 60 * 60 * 1000;
  while (outcomes.length > 0 && outcomes[0].ts < cutoff) outcomes.shift();
}

function classifyAbort(err: unknown): SpecAbortReason {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.toLowerCase().includes("abort")) return "manual_cancel";
  if (msg.toLowerCase().includes("timeout")) return "timeout";
  return "other";
}
