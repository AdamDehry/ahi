/**
 * `claude --effort` levels. Its own module so claude-invoke can use it without
 * a value import of config.ts, which loads .env as a side effect.
 */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** A valid level, lower-cased — or null, so a typo never reaches the CLI. */
export function normalizeEffort(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(v) ? v : null;
}
