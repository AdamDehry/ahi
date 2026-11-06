// The public skills rule, shared by the installer build, the installed runtime and the release's skills bundle:
// a skill ships only if skills/MANIFEST.json lists it AND its SKILL.md frontmatter says `private: false`.
// Anything else in a checkout's skills folder (a private skill, an unlisted folder, a template) never ships.
const fs = require('node:fs');
const path = require('node:path');

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True only when the SKILL.md frontmatter carries `private: false` exactly. A missing field is private. */
function isPublic(skillMd) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  return !!front && /^private:[ \t]*false[ \t]*$/m.test(front[1]);
}

/** { manifest, skills, refused }: the manifest cut down to its public skills, and the names that were left out. */
function publicSkills(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
  const skills = [], refused = [];
  for (const s of Array.isArray(manifest.skills) ? manifest.skills : []) {
    const md = SLUG.test(s?.name) && SLUG.test(s?.category) ? path.join(dir, s.category, s.name, 'SKILL.md') : null;
    let ok = false;
    try { ok = !!md && fs.lstatSync(md).isFile() && isPublic(fs.readFileSync(md, 'utf8')); } catch { ok = false; }
    (ok ? skills : refused).push(s);
  }
  return { manifest: { ...manifest, skills }, skills, refused: refused.map((s) => `${s?.category}/${s?.name}`) };
}

/** Plain files of one skill folder: no dot-files, no __pycache__, no symlinks. */
function copySkill(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '__pycache__') continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copySkill(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

/** Build-time: write ONLY the public skills (plus the cut-down manifest and the README map) into an empty folder. */
function stagePublicSkills(dir, out) {
  const { manifest, skills, refused } = publicSkills(dir);
  if (refused.length) throw Error(`skills/MANIFEST.json lists skills that are not public (private: false): ${refused.join(', ')}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const s of skills) copySkill(path.join(dir, s.category, s.name), path.join(out, s.category, s.name));
  fs.writeFileSync(path.join(out, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (fs.existsSync(path.join(dir, 'README.md'))) fs.copyFileSync(path.join(dir, 'README.md'), path.join(out, 'README.md'));
  return skills.length;
}

module.exports = { isPublic, publicSkills, stagePublicSkills };
