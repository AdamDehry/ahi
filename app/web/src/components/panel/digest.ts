/**
 * The day-close's Builds block (gateway: buildsDigestLines), recognized in
 * the message text so the thread can render it as the DigestCard (B8). The
 * text form stays the record — Telegram and every other reader get the same
 * two lines — and the card is drawn from exactly those words, so chat and
 * card can't disagree.
 *
 *   **Builds** — 20 open · 3 need you · 9 to close · oldest 69d → https://your-address/#builds
 *   - Finance vault — your step
 *   - +1 more
 */
export interface DigestBlock {
  open: number;
  needYou: number;
  toClose: number;
  oldestDays: number | null;
  names: string[];
  more: number;
}

const HEAD = /^\*\*Builds\*\* — (?:(nothing open)\.|(\d+) open · (\d+) needs? you(?: · (\d+) to close)?(?: · oldest (\d+)d| · oldest today)?\s*→\s*\S+#builds)\s*$/;

export function splitBuildsBlock(text: string): { before: string; block: DigestBlock; after: string } | null {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => HEAD.test(l));
  if (i === -1) return null;
  const m = HEAD.exec(lines[i])!;
  const block: DigestBlock = m[1]
    ? { open: 0, needYou: 0, toClose: 0, oldestDays: null, names: [], more: 0 }
    : { open: Number(m[2]), needYou: Number(m[3]), toClose: Number(m[4] ?? 0), oldestDays: m[5] !== undefined ? Number(m[5]) : /oldest today/.test(lines[i]) ? 0 : null, names: [], more: 0 };
  let j = i + 1;
  for (; j < lines.length && lines[j].startsWith("- "); j++) {
    const more = /^- \+(\d+) more$/.exec(lines[j]);
    if (more) block.more = Number(more[1]);
    else block.names.push(lines[j].slice(2));
  }
  return { before: lines.slice(0, i).join("\n").trim(), block, after: lines.slice(j).join("\n").trim() };
}
