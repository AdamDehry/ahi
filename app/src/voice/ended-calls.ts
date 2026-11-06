/**
 * Calls that have hung up (the phone leg). When a call ends, the turn in
 * flight is aborted through the interrupt path — but a turn already QUEUED
 * behind it in the call's turn gate would still start, and run tools for a
 * line nobody is on. index.ts marks the call here on hang-up and every turn
 * checks before it starts. Entries expire on their own.
 */
const ENDED_CALL_TTL_MS = 10 * 60_000;
const ended = new Map<string, number>();

export function markVoiceCallEnded(voiceStreamId: string, now: number = Date.now()): void {
  ended.set(voiceStreamId, now + ENDED_CALL_TTL_MS);
  for (const [id, until] of ended) if (until < now) ended.delete(id);
}

export function voiceCallEnded(voiceStreamId: string, now: number = Date.now()): boolean {
  const until = ended.get(voiceStreamId);
  if (until === undefined) return false;
  if (until < now) {
    ended.delete(voiceStreamId);
    return false;
  }
  return true;
}
