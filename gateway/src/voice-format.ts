/**
 * Prepares a response for voice output by splitting it into:
 * - speakable: conversational text safe for TTS (no markdown, no technical noise)
 * - textSummary: structured content extracted for a text attachment
 *   (action items, numbered lists, suggestions, links, IDs, code, tables)
 */

export interface VoiceFormatted {
  speakable: string;
  textSummary: string;
}

// Patterns for technical strings
const URL_PATTERN = /https?:\/\/[^\s)>\]]+/g;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_ID_PATTERN = /\b[0-9a-f]{16,}\b/gi;
const API_KEY_PATTERN = /\b(?:sk-|pk-|key-|token-)[A-Za-z0-9_-]{10,}\b/g;
const LONG_CODE_PATTERN = /`[^`]{30,}`/g;

/**
 * Detect whether a response has structured content worth attaching as text.
 * This catches: numbered lists, bullet lists, action items, suggestions,
 * headers with lists under them, tables, code, links, IDs.
 */
function extractStructuredContent(text: string): string[] {
  const sections: string[] = [];

  // Extract code blocks
  const codeBlocks: string[] = [];
  text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code.trim());
    return "";
  });
  if (codeBlocks.length > 0) {
    sections.push(...codeBlocks.map((c) => "```\n" + c + "\n```"));
  }

  // Extract tables
  const tablePattern = /\|[^\n]+\|(\n\|[-: |]+\|)(\n\|[^\n]+\|)+/g;
  const tables = text.match(tablePattern);
  if (tables) {
    sections.push(...tables.map((t) => t.trim()));
  }

  // Extract URLs
  const urls = text.match(URL_PATTERN);
  if (urls) {
    const unique = [...new Set(urls)];
    sections.push(...unique);
  }

  // Extract UUIDs
  const uuids = text.match(UUID_PATTERN);
  if (uuids) {
    sections.push(...[...new Set(uuids)]);
  }

  // Extract hex IDs
  const hexIds = text.match(HEX_ID_PATTERN);
  if (hexIds) {
    sections.push(...[...new Set(hexIds)]);
  }

  // Extract API keys
  const apiKeys = text.match(API_KEY_PATTERN);
  if (apiKeys) {
    sections.push(...[...new Set(apiKeys)]);
  }

  // Extract numbered lists (1. item, 2. item, etc. — 2+ items in sequence)
  const numberedListPattern = /(?:^|\n)((?:\d+\.\s+.+\n?){2,})/g;
  let match;
  while ((match = numberedListPattern.exec(text)) !== null) {
    sections.push(match[1].trim());
  }

  // Extract bullet lists (- item or * item — 2+ items in sequence)
  const bulletListPattern = /(?:^|\n)((?:[-*+]\s+.+\n?){2,})/g;
  while ((match = bulletListPattern.exec(text)) !== null) {
    sections.push(match[1].trim());
  }

  // Extract sections with headers that contain actionable content
  // e.g., "## Next Steps\n- do this\n- do that"
  const headerSectionPattern = /(?:^|\n)#{1,4}\s+(.+)\n((?:[-*+\d][\s.)]+.+\n?){2,})/g;
  while ((match = headerSectionPattern.exec(text)) !== null) {
    sections.push(`${match[1]}\n${match[2].trim()}`);
  }

  return sections;
}

export function formatForVoice(text: string): VoiceFormatted {
  let speakable = text;

  // Extract structured content for text attachment
  const structured = extractStructuredContent(text);

  // Clean the speakable version

  // Remove code blocks
  speakable = speakable.replace(/```[\w]*\n?([\s\S]*?)```/g,
    "I'll include that in the text summary.");

  // Replace URLs with natural speech
  speakable = speakable.replace(URL_PATTERN, (url) => {
    try {
      const domain = new URL(url).hostname.replace("www.", "");
      return `the link to ${domain}`;
    } catch {
      return "the link";
    }
  });

  // Replace UUIDs
  speakable = speakable.replace(UUID_PATTERN, "the ID in the summary");

  // Replace hex IDs
  speakable = speakable.replace(HEX_ID_PATTERN, "the reference code");

  // Replace API keys
  speakable = speakable.replace(API_KEY_PATTERN, "the key in the summary");

  // Replace long inline code
  speakable = speakable.replace(LONG_CODE_PATTERN, (m) => {
    return "the code snippet";
  });

  // Strip markdown formatting
  speakable = speakable.replace(/^#{1,6}\s+/gm, "");
  speakable = speakable.replace(/\*\*([^*]+)\*\*/g, "$1");
  speakable = speakable.replace(/\*([^*]+)\*/g, "$1");
  speakable = speakable.replace(/__([^_]+)__/g, "$1");
  speakable = speakable.replace(/_([^_]+)_/g, "$1");
  speakable = speakable.replace(/`([^`]+)`/g, "$1");
  speakable = speakable.replace(/^---+$/gm, "");

  // Clean bullet markers for speech (keep the content, just remove the marker)
  speakable = speakable.replace(/^\s*[-*+]\s+/gm, "");
  speakable = speakable.replace(/^\s*\d+\.\s+/gm, "");

  // Replace tables with spoken reference
  const tablePattern = /\|[^\n]+\|(\n\|[-: |]+\|)?(\n\|[^\n]+\|)*/g;
  speakable = speakable.replace(tablePattern, "See the details in the summary.");

  // Clean up whitespace
  speakable = speakable.replace(/\n{3,}/g, "\n\n");
  speakable = speakable.trim();

  // Build text summary from structured content
  // Deduplicate
  const seen = new Set<string>();
  const unique = structured.filter((s) => {
    const key = s.trim().substring(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const textSummary = unique.length > 0 ? unique.join("\n\n") : "";

  return { speakable, textSummary };
}
