/** Voice-mode turns must never resume the ordinary text-chat Claude session. */
export function voiceScopedChatId(userId: string, voiceStreamId: string): number {
  const key = `${userId}:${voiceStreamId}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  // SessionMap only accepts numeric chat ids. Negative ids cannot collide with
  // Telegram chat ids, and the +1 avoids the unusable -0 edge.
  return -1 * (1 + (hash % 2_000_000_000));
}

export function isVoiceScopedChatId(chatId: number): boolean {
  return Number.isInteger(chatId) && chatId < 0;
}
