// skills-bundle.mjs <skills dir> <out.json> — pack the release's skills shelf into ahi-skills.json, the
// asset the app's Updates page installs from (src/updates.ts). The skill list, categories and versions come
// from skills/MANIFEST.json (written by the shelf export from validated frontmatter); each listed folder goes
// in with every file's sha256. __pycache__ and dot-files stay out. Exits 1 if a listed skill has no SKILL.md or is
// not public (private: false — the same rule the installers use, onboarding/src/public-skills.cjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const { publicSkills } = createRequire(import.meta.url)('../onboarding/src/public-skills.cjs');

const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error('usage: skills-bundle.mjs <skills dir> <out.json>'); process.exit(2); }
const files = (root, rel = '') => fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
  if (e.name.startsWith('.') || e.name === '__pycache__') return [];
  const p = path.posix.join(rel, e.name);
  if (e.isDirectory()) return files(root, p);
  if (!e.isFile()) return [];
  const full = path.join(root, p), buf = fs.readFileSync(full);
  return [{ path: p, sha256: crypto.createHash('sha256').update(buf).digest('hex'), executable: !!(fs.statSync(full).mode & 0o111), content: buf.toString('base64') }];
});

const { manifest, refused } = publicSkills(dir);
if (refused.length) { console.error(`listed in MANIFEST.json but missing or not public (private: false): ${refused.join(', ')}`); process.exit(1); }
const skills = manifest.skills.map(({ name, category, version }) => {
  const root = path.join(dir, category, name);
  return { name, category, version, files: files(root) };
});
fs.writeFileSync(out, JSON.stringify({ format: 'ahi-skills/1', release: manifest.release, skills }));
console.log(`${skills.length} skills, release ${manifest.release} -> ${out}`);
