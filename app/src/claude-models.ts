// Current catalog first (newest first), then legacy entries the owner wants to keep
// selectable. IDs verified against the Models API. Opus 5.5
// needs claude CLI >= 2.1.280 and Fable 5.1 >= 2.1.251 — see claude-bin.ts.
export const CLAUDE_MODEL_OPTIONS = [
  { value: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { value: "claude-fable-5-1", label: "Fable 5.1" },
  { value: "claude-opus-5", label: "Opus 5" },
  { value: "claude-sonnet-5", label: "Sonnet 5" },
  { value: "claude-fable-5", label: "Fable 5" },
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "claude-opus-4-7", label: "Opus 4.7" },
  { value: "claude-opus-4-6", label: "Opus 4.6" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
  { value: "claude-opus-4-5", label: "Opus 4.5 (legacy)" },
  { value: "claude-sonnet-4-5", label: "Sonnet 4.5 (legacy)" },
] as const;

export const AVAILABLE_CLAUDE_MODELS = CLAUDE_MODEL_OPTIONS.map((model) => model.value);

const AVAILABLE_CLAUDE_MODEL_SET = new Set<string>(AVAILABLE_CLAUDE_MODELS);

// Bare family aliases track the newest model in each family. A persisted bare
// alias (e.g. bot-settings.json `"model": "opus"`) therefore moves with this
// table on the next restart — pick a full ID in Settings to pin a model.
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5",
};

export function normalizeClaudeModel(model: string): string {
  return LEGACY_MODEL_ALIASES[model] ?? model;
}

export function isAvailableClaudeModel(model: string): boolean {
  return AVAILABLE_CLAUDE_MODEL_SET.has(model);
}
