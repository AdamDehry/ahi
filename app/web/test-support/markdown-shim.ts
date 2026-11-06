/**
 * DOMPurify, reached from the ROOT test suite — same reason renderer.ts
 * exists: resolution has to start inside `web/` to get the instance the app's
 * markdown module holds.
 *
 * Outside a browser DOMPurify builds itself WITHOUT `sanitize` (it needs a
 * real DOM to parse into), so any root test that renders message markdown
 * dies in renderMarkdown, not in the code under test. A test that only cares
 * what surrounds the markdown installs a pass-through.
 */
import DOMPurify from "dompurify";

export function installSanitizePassthrough(): void {
  const p = DOMPurify as unknown as { sanitize?: (html: string) => string };
  if (typeof p.sanitize !== "function") p.sanitize = (html: string) => html;
}
