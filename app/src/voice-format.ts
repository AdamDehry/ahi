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
// Every inline code span, paired left-to-right. Matching only the LONG ones directly
// (/`[^`]{30,}`/) mis-pairs: it can start at a CLOSING backtick and swallow all the prose
// up to the next opening one, which is how whole paragraphs went missing from voice notes.
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const LONG_CODE_MIN = 30;

// Spoken stand-in for anything that can't be read aloud (code, commands, tables).
// Never name the formatting out loud ("code snippet", "fenced block") — the owner's rule.
const IN_TEXT = "that's in the text";
// Collapses runs of the stand-in, so a message full of commands doesn't become a chant.
const IN_TEXT_RUN = new RegExp(`(?:${IN_TEXT}[.,;:\\s]*){2,}`, "gi");

// ── Links and sources ─────────────────────────────────────────────────
// The text copy keeps every link; the voice note shouldn't read them. A
// sources list used to come out as "Times of Israel, the link to
// timesofisrael.com" once per source.

const LINKS_LEFT = "I left you the links below.";
const MD_LINK_PATTERN = /!?\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g;
const SOURCES_WORDS = "sources?|references?|links?|citations?|further reading|read more|useful links|מקורות|קישורים";
// "Sources", "## Sources", "**Sources:**", "Sources: [a](..), [b](..)". The
// optional tail is only honoured after a colon (see isSourcesHeader), so a
// sentence like "Links are below" is not mistaken for a header.
const SOURCES_HEADER = new RegExp(
  `^\\s*(?:#{1,6}\\s+)?(?:\\*\\*|__)?\\s*(?:${SOURCES_WORDS})\\s*(?:\\*\\*|__)?\\s*(:)?\\s*(?:\\*\\*|__)?\\s*(.*)$`,
  "i",
);
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;
// Prose that already points at the list: "I left the sources below", "links are in the text".
const ALREADY_POINTED = new RegExp(
  `\\b(?:${SOURCES_WORDS})\\b[^\\n.!?]{0,60}\\b(?:below|underneath|in the text)\\b|\\b(?:below|underneath)\\b[^\\n.!?]{0,30}\\b(?:${SOURCES_WORDS})\\b`,
  "i",
);

function hasLink(line: string): boolean {
  URL_PATTERN.lastIndex = 0;
  return URL_PATTERN.test(line);
}

/** What's left of a line once its links and list marker are gone. */
function nonLinkWords(line: string): number {
  return line
    .replace(LIST_ITEM, "")
    .replace(MD_LINK_PATTERN, " ")
    .replace(URL_PATTERN, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** A line that is (nearly) nothing but a link: "- Times of Israel — https://…". */
function isLinkItem(line: string): boolean {
  return hasLink(line) && nonLinkWords(line) <= 12;
}

function isSourcesHeader(line: string): boolean {
  const m = SOURCES_HEADER.exec(line);
  if (!m) return false;
  const [, colon, rest] = m;
  if (!rest.trim()) return true;
  return !!colon && isLinkItem(rest);
}

/**
 * Drop sources/links sections from the spoken text, leaving one
 * "I left you the links below." in place of the first one. A headed section
 * ("Sources", "References", "Links"…) loses its header and the list under it
 * — when that list is mostly links, or when nothing but blank lines follows
 * it. With no header, a final list of two or more items that are mostly links
 * (one short closing line may follow it) goes the same way.
 */
function dropSourcesSections(text: string): string {
  const lines = text.split("\n");
  const drop = new Set<number>();
  let firstDropped = -1;
  const isItem = (l: string) => LIST_ITEM.test(l) || isLinkItem(l);
  const mostlyLinks = (idx: number[]) =>
    idx.length > 0 && idx.filter((k) => isLinkItem(lines[k])).length * 2 > idx.length;
  const trailingAfter = (j: number) => lines.slice(j).every((l) => !l.trim());

  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i) || !isSourcesHeader(lines[i])) continue;
    // The block under the header: items, with blank lines allowed between them.
    const items: number[] = [];
    let j = i + 1;
    while (j < lines.length) {
      if (isItem(lines[j])) { items.push(j); j++; continue; }
      if (!lines[j].trim()) {
        let k = j;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k < lines.length && isItem(lines[k])) { j = k; continue; }
      }
      break;
    }
    const inlineLinks = hasLink(lines[i]);
    if (!inlineLinks && items.length === 0) continue;
    if (items.length > 0 && !mostlyLinks(items) && !trailingAfter(j)) continue;
    for (let k = i; k < j; k++) drop.add(k);
    if (firstDropped === -1) firstDropped = i;
    i = j - 1;
  }

  {
    // No header: a trailing list (ignoring trailing blanks) of link items.
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    // One short closing line after the list ("Want more?") still leaves it final.
    if (end > 0 && !isItem(lines[end - 1]) && lines[end - 1].length <= 200) {
      let k = end - 1;
      while (k > 0 && !lines[k - 1].trim()) k--;
      if (k > 0 && isItem(lines[k - 1])) end = k;
    }
    let start = end;
    while (start > 0 && (isItem(lines[start - 1]) || (!lines[start - 1].trim() && start - 1 > 0 && isItem(lines[start - 2])))) start--;
    const items = [];
    for (let k = start; k < end; k++) if (lines[k].trim()) items.push(k);
    if (items.length >= 2 && !items.some((k) => drop.has(k)) && mostlyLinks(items)) {
      for (let k = start; k < end; k++) drop.add(k);
      if (firstDropped === -1) firstDropped = start;
    }
  }

  if (firstDropped === -1) return text;
  // If the prose already says so ("I left the sources below"), don't say it twice.
  const kept = lines.filter((_l, k) => !drop.has(k)).join("\n");
  const alreadySaid = ALREADY_POINTED.test(kept);
  const out: string[] = [];
  lines.forEach((l, k) => {
    if (k === firstDropped && !alreadySaid) out.push("", LINKS_LEFT, "");
    if (!drop.has(k)) out.push(l);
  });
  return out.join("\n");
}

/** "bbc.co.uk" → "bbc", "www.timesofisrael.com" → "timesofisrael". */
function siteName(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/^www\./, "").split(".");
  labels.pop();
  return labels.reduce((a, b) => (b.length > a.length ? b : a), "");
}

const DROPPED = "\u0000";
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Bare URLs mid-prose. With no anchor text the listener still gets a short
 * "the link to <site>" — unless the words right next to it already name that
 * site ("Times of Israel, https://timesofisrael.com/…"), in which case the
 * URL just goes, along with the parentheses or dash that framed it.
 */
function speakBareUrls(text: string): string {
  return text.replace(
    /(\s*[(\[—–-]?\s*)(https?:\/\/[^\s)>\]]+)(\s*[)\]]?)/g,
    (whole, lead: string, rawUrl: string, trail: string, offset: number, all: string) => {
      // Sentence punctuation stuck to the URL stays in the sentence.
      const punct = /[.,;:!?]+$/.exec(rawUrl)?.[0] ?? "";
      const url = rawUrl.slice(0, rawUrl.length - punct.length);
      trail = punct + trail;
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return `${lead}the link${trail}`;
      }
      const name = siteName(host);
      const before = squash(all.slice(Math.max(0, offset - 60), offset));
      const after = squash(all.slice(offset + whole.length, offset + whole.length + 40));
      if (name.length >= 3 && (before.includes(name) || after.startsWith(name))) {
        return (/\n/.test(lead) ? lead.replace(/[^\n]/g, "") : DROPPED) + punct;
      }
      return `${lead}the link to ${host.replace(/^www\./, "")}${trail}`;
    },
  // "Times of Israel: <url>." loses the colon that introduced the URL too.
  ).replace(/\s*[:—–-]?\s*\u0000/g, "");
}

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
  speakable = speakable.replace(/```[\w]*\n?([\s\S]*?)```/g, IN_TEXT);

  // Sources sections go; inline [text](url) speaks only its text; a bare
  // URL gets a short stand-in unless a neighbouring name already says it.
  speakable = dropSourcesSections(speakable);
  speakable = speakable.replace(MD_LINK_PATTERN, (_m, label: string, url: string) =>
    label.trim() && !/^https?:\/\//.test(label.trim()) ? label : url);
  speakable = speakBareUrls(speakable);

  // Replace UUIDs
  speakable = speakable.replace(UUID_PATTERN, "the ID in the summary");

  // Replace hex IDs
  speakable = speakable.replace(HEX_ID_PATTERN, "the reference code");

  // Replace API keys
  speakable = speakable.replace(API_KEY_PATTERN, "the key in the summary");

  // Replace long inline code
  speakable = speakable.replace(INLINE_CODE_PATTERN, (_m, code: string) =>
    code.length >= LONG_CODE_MIN ? IN_TEXT : code);

  // Strip markdown formatting
  speakable = speakable.replace(/^#{1,6}\s+/gm, "");
  speakable = speakable.replace(/\*\*([^*]+)\*\*/g, "$1");
  speakable = speakable.replace(/\*([^*]+)\*/g, "$1");
  speakable = speakable.replace(/__([^_]+)__/g, "$1");
  // Word-boundary guarded so identifiers like AHI_GATEWAY_URL keep their underscores
  speakable = speakable.replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, "$1");
  speakable = speakable.replace(/`([^`]+)`/g, "$1");
  speakable = speakable.replace(/^---+$/gm, "");

  // Clean bullet markers for speech (keep the content, just remove the marker)
  speakable = speakable.replace(/^\s*[-*+]\s+/gm, "");
  speakable = speakable.replace(/^\s*\d+\.\s+/gm, "");

  // Replace tables with spoken reference
  const tablePattern = /\|[^\n]+\|(\n\|[-: |]+\|)?(\n\|[^\n]+\|)*/g;
  speakable = speakable.replace(tablePattern, IN_TEXT);

  // One stand-in per run, however many things got swapped out
  speakable = speakable.replace(IN_TEXT_RUN, `${IN_TEXT}. `);

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
