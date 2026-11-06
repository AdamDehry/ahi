import { AI_ROOT } from "./ai-root.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, resolve } from "path";
import { atomicWriteFile } from "./multi-user-paths.js";

export interface TurnRecord {
  turn_id: string;
  user: string;
  ts: string;
  spec_invoked: boolean;
  spec_committed: boolean;
  spec_aborted: boolean;
  input_tokens_spec?: number;
  input_tokens_final?: number;
  output_tokens?: number;
  model?: string;
  cost_usd_spec?: number;
  cost_usd_final?: number;
  cost_usd_wasted?: number;
  /** Screen frames this turn carried (voice/screen-watch.ts), their estimated tokens and dollars. */
  screen_frames?: number;
  screen_tokens?: number;
  screen_usd?: number;
  /** "turn" (always-on) or "recording" (a record-mode review). */
  screen_kind?: string;
  /**
   * Which downlink actually served this turn's audio.
   *
   * "stream" = Cartesia WS, PCM frames as they generate (voice mode).
   * "blob"   = REST synthesis of the whole reply, delivered as one payload
   *            (the degraded fallback when the call has no TTS socket).
   *
   * Recorded because these two have latency profiles that are not remotely
   * comparable, and a read that mixes them is worse than no read at all.
   */
  tts_path?: "stream" | "blob";
  /** The TTS model that spoke each sentence (HTTP call path), or the call's one model. */
  tts_models?: string[];
  /** The utterance only acknowledged what was just said: no reply, no TTS (ack-gate.ts). */
  silent_ack?: boolean;
  /** Time the ack gate spent deciding. */
  ack_gate_ms?: number;
  /** Which streaming provider spoke the call ("elevenlabs" | "cartesia"). */
  tts_provider?: string;
  /** `--effort` the voice turn ran at. */
  effort?: string;
  /** The front voice's line, when it played (voice/front-voice.ts). */
  front_voice_line?: string | null;
  /** Why no front-voice line played (answer-first, rejected:…, turn-ended…). */
  front_voice_skipped?: string | null;
  /** Committed transcript → the front-voice line was written (ms). */
  front_voice_line_ms?: number;
  /** Committed transcript → the front-voice audio was sent (ms). */
  front_voice_played_ms?: number;
  /**
   * Committed transcript → the first audio of ANY kind (filler included).
   * `first_audio_ms` stays the answer's own first audio, comparable with
   * every record written before the front voice existed.
   */
  any_first_audio_ms?: number;
  /** Cartesia synthesis latency: context opened → first audio byte. */
  tts_ttfb_ms?: number;
  /**
   * Committed transcript → first audio byte reaching the user.
   *
   * This is the number that corresponds to what the owner actually experiences as
   * "how long before it starts talking". On the streaming path it is small by
   * construction; on the blob path it necessarily includes the whole reply
   * plus the ffmpeg transcode.
   */
  first_audio_ms?: number;
  /**
   * Committed transcript → reply fully delivered.
   *
   * NOTE: on the streaming path this is NOT the perceived latency — audio
   * started long before it. Kept under its own name so nobody reads it as
   * first-audio. `first_audio_ms` is the perceptual figure.
   */
  latency_final_to_audio_ms?: number;
  baseline_estimate_ms?: number;
  latency_saved_ms?: number;
  interim_text?: string;
  final_text?: string;
  normalized_levenshtein?: number;
  audio_route?: string;
  stt_first_interim_ms?: number;
  stt_final_ms?: number;
  spec_abort_reason?: null | "edit_distance" | "timeout" | "user_bargein" | "manual_cancel" | "other";
  barge_in_fired?: boolean;
  barge_in_was_false_positive?: boolean | null;
  operator_subjective_rating?: number | null;
  app_version?: string | null;
  git_sha?: string | null;
}

// AHI_TURN_LOG_DIR: an isolated test instance writes its turns beside its own
// state instead of into production's latency record (which every voice read
// is taken from). Unset: unchanged.
const LOG_DIR = process.env.AHI_TURN_LOG_DIR ? resolve(process.env.AHI_TURN_LOG_DIR) : resolve(AI_ROOT, "builds/gateway/logs");
const ACTIVITY_FEED = resolve(AI_ROOT, "mission-control/ACTIVITY_FEED.md");
const rollingRecords: TurnRecord[] = [];
let runtimeSpeculationEnabled = true;
let alertWritten = false;

export function isRuntimeSpeculationEnabled(): boolean {
  return runtimeSpeculationEnabled;
}

export function disableRuntimeSpeculation(reason: string): void {
  if (!runtimeSpeculationEnabled && alertWritten) return;
  runtimeSpeculationEnabled = false;
  writeAlert(reason);
}

export function logTurn(record: TurnRecord): void {
  const completed: TurnRecord = {
    ...record,
    ts: record.ts || new Date().toISOString(),
    spec_abort_reason: record.spec_abort_reason ?? null,
    barge_in_fired: record.barge_in_fired ?? false,
    barge_in_was_false_positive: record.barge_in_was_false_positive ?? null,
    operator_subjective_rating: record.operator_subjective_rating ?? null,
    app_version: record.app_version ?? process.env.AHI_APP_VERSION ?? null,
    git_sha: record.git_sha ?? process.env.GIT_SHA ?? null,
  };
  const path = resolve(LOG_DIR, `turns-${completed.ts.slice(0, 10)}.jsonl`);
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(path, `${JSON.stringify(completed)}\n`, "utf-8");
  rollingRecords.push(completed);
  pruneRolling();
  checkAutoDisable(completed);
}

function pruneRolling(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  while (rollingRecords.length > 0) {
    const ts = new Date(rollingRecords[0].ts).getTime();
    if (Number.isFinite(ts) && ts >= cutoff) break;
    rollingRecords.shift();
  }
}

function checkAutoDisable(record: TurnRecord): void {
  if (process.env.AHI_AUTODISABLE_ON_CORRUPTION === "false") return;
  if (record.spec_committed && (record.normalized_levenshtein ?? 0) > 0.4) {
    disableRuntimeSpeculation(
      `Semantic corruption risk: turn=${record.turn_id} distance=${record.normalized_levenshtein?.toFixed(3)}`,
    );
    return;
  }

  const spec = rollingRecords.filter((r) => r.spec_invoked);
  if (spec.length < 8) return;
  const aborted = spec.filter((r) => r.spec_aborted).length;
  const abortRate = aborted / spec.length;
  const threshold = readNumberEnv("AHI_SPEC_ABORT_RATE_KILL", 0.25);
  if (abortRate > threshold) {
    disableRuntimeSpeculation(
      `24h speculation abort rate ${(abortRate * 100).toFixed(1)}% > ${(threshold * 100).toFixed(0)}%`,
    );
  }
}

function readNumberEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function writeAlert(reason: string): void {
  if (alertWritten) return;
  alertWritten = true;
  const ts = new Date().toISOString();
  const line = `\n[ALERT] ${ts} — H-040 B1 auto-disabled speculation: ${reason}\n`;
  try {
    const prior = existsSync(ACTIVITY_FEED) ? readFileSync(ACTIVITY_FEED, "utf-8") : "";
    atomicWriteFile(ACTIVITY_FEED, `${line}${prior}`);
  } catch (err) {
    console.error("[turn-logger] Failed to write activity alert:", (err as Error).message);
  }
  process.env.AHI_SPECULATION = "false";
  process.env.AHI_SPECULATION_ENABLED = "false";
}
