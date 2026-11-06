import { marked } from "marked";
import DOMPurify from "dompurify";

// Same options as the vanilla dashboard (public/app.js:26-33) so rendered
// output matches what the owner sees today.
marked.setOptions({ gfm: true, breaks: true });

// ── Copy button on fenced code blocks (Step 5 #1) ───────────────────
// Same glyph as icons.tsx IconCopy, as a string — this output is injected
// HTML, not JSX. The click behavior is ONE delegated document listener
// (App.tsx initCodeCopy) — nothing per-render, so the memo cache and the
// streaming stable/tail split are untouched.
const COPY_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="5" y="5" width="9" height="9" rx="1.5"></rect>' +
  '<path d="M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5"></path></svg>';

marked.use({
  renderer: {
    // marked v12: positional args, raw text (v13+ switched to a token
    // object — resync this override if the dep is ever bumped).
    code(code: string, infostring: string | undefined): string {
      const lang = (infostring || "").trim().split(/\s+/)[0];
      const cls = lang ? ` class="language-${lang}"` : "";
      const body = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return (
        `<div class="code-block"><button class="code-copy" type="button" aria-label="Copy code">${COPY_ICON_SVG}</button>` +
        `<pre><code${cls}>${body}</code></pre></div>`
      );
    },
  },
});

function parse(text: string): string {
  const html = marked.parse(text || "", { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

// Memoized parse — completed messages render once per unique text, ever.
// LRU-capped so a long session can't grow unbounded.
const cache = new Map<string, string>();
const CACHE_MAX = 2000;

export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) {
    // refresh LRU position
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  const html = parse(text);
  cache.set(text, html);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return html;
}

/**
 * Streaming render: split the buffer at the last blank-line block boundary.
 * The stable prefix hits the memo cache (parsed once, no matter how many
 * chunks follow); only the growing tail block re-parses per chunk. This is
 * what kills the O(n²) full-buffer re-parse the vanilla client does on
 * every stream-chunk (public/app.js:1992).
 *
 * The split is conservative: never inside a fenced code block (a fence
 * spanning the boundary would render broken).
 */
export function renderStreamingMarkdown(buffer: string): { stableHtml: string; tailHtml: string } {
  const cut = findStableCut(buffer);
  if (cut <= 0) return { stableHtml: "", tailHtml: parse(buffer) };
  return {
    stableHtml: renderMarkdown(buffer.slice(0, cut)),
    tailHtml: parse(buffer.slice(cut)),
  };
}

function findStableCut(buffer: string): number {
  const idx = buffer.lastIndexOf("\n\n");
  if (idx <= 0) return 0;
  // If an odd number of ``` fences precede the cut, we're inside a code
  // block — retreat to before the opening fence.
  const before = buffer.slice(0, idx);
  const fences = before.match(/^```/gm)?.length ?? 0;
  if (fences % 2 === 1) {
    const fenceStart = before.lastIndexOf("```");
    const prevBreak = before.lastIndexOf("\n\n", fenceStart);
    return prevBreak > 0 ? prevBreak + 2 : 0;
  }
  return idx + 2; // include the blank line in the stable prefix
}
