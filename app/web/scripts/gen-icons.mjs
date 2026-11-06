// AHI icon set generator (cutover A1).
//
// Recreates the login brand moment — petrol radial wash, "AH" in bone
// Fraunces, italic brass "I" — as a crisp square icon set. Glyphs are
// converted to SVG paths via opentype.js (no system-font dependency for
// rasterization), then sharp renders the PNGs. favicon.ico is a 32px
// PNG-in-ICO (universally supported).
//
// Outputs → web/public/ (shipped at the web root by Vite) and mirrors the
// legacy-dashboard icon names → ../public/ (replaces the old blue 4-dot set).
//
// Run: node scripts/gen-icons.mjs   (needs network the first time — the
// pinned Fraunces instances below are cached in web/scripts/.fonts/)
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_PUBLIC = resolve(HERE, "../public");
const LEGACY_PUBLIC = resolve(HERE, "../../public");
const FONT_CACHE = join(HERE, ".fonts");

// Fraunces static instances (gstatic, pinned v38, opsz 144). The login
// wordmark is font-weight 420; gstatic instances snap to named weights —
// 400 is the closest render (verified against the wordmark + inspo).
const FONTS = {
  regular: {
    file: "fraunces-normal-400.ttf",
    url: "https://fonts.gstatic.com/s/fraunces/v38/6NUh8FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0K7iN7hzFUPJH58njr1a03gg7S2nfgRYIctxujDg.ttf",
  },
  italic: {
    file: "fraunces-italic-400.ttf",
    url: "https://fonts.gstatic.com/s/fraunces/v38/6NVf8FyLNQOQZAnv9ZwNjucMHVn85Ni7emAe9lKqZTnbB-gzTK0K1ChJdt9vIVYX9G37lod_sPEKsxx664UJf1hLTf7W.ttf",
  },
};

// Brand values — tokens.css verbatim (login wash + wordmark colors).
const BONE = "#F4F1EA";
const BRASS_BRIGHT = "#C9A24B";
const PETROL_GLOW = "#16424F";
const PETROL = "#11303A";
const PETROL_DEEP = "#0E2830";
const TRACKING = -0.015; // login wordmark letter-spacing (em)

async function loadFont(kind) {
  mkdirSync(FONT_CACHE, { recursive: true });
  const path = join(FONT_CACHE, FONTS[kind].file);
  if (!existsSync(path)) {
    const res = await fetch(FONTS[kind].url);
    if (!res.ok) throw new Error(`font fetch failed: ${res.status} ${FONTS[kind].url}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return opentype.parse(readFileSync(path).buffer.slice(0));
}

const regular = await loadFont("regular");
const italic = await loadFont("italic");

/** Path data + advance for one glyph at a given size/offset. */
function glyphPath(font, char, size, x, y) {
  const glyph = font.charToGlyph(char);
  const scale = size / font.unitsPerEm;
  return {
    d: glyph.getPath(x, y, size).toPathData(3),
    advance: glyph.advanceWidth * scale,
  };
}

/** Compose the AHI mark centered in a square of `canvas` px, with the
 *  text block scaled to `targetWidth` px. Returns inner SVG elements. */
function mark(canvas, targetWidth) {
  // Measure at a probe size, then scale to hit targetWidth exactly.
  const probe = 100;
  const track = probe * TRACKING;
  const wA = glyphPath(regular, "A", probe, 0, 0).advance;
  const wH = glyphPath(regular, "H", probe, 0, 0).advance;
  const wI = glyphPath(italic, "I", probe, 0, 0).advance;
  const widthAt = wA + track + wH + track + wI;
  const size = (probe * targetWidth) / widthAt;

  // Vertical centering on the CAP height (A/H/I are all caps).
  const capHeight = (regular.tables.os2?.sCapHeight ?? 0.7 * regular.unitsPerEm) * (size / regular.unitsPerEm);
  const baseline = canvas / 2 + capHeight / 2;

  const t = size * TRACKING;
  let x = (canvas - targetWidth) / 2;
  const a = glyphPath(regular, "A", size, x, baseline);
  x += a.advance + t;
  const h = glyphPath(regular, "H", size, x, baseline);
  x += h.advance + t;
  const i = glyphPath(italic, "I", size, x, baseline);

  return `
  <path d="${a.d}" fill="${BONE}"/>
  <path d="${h.d}" fill="${BONE}"/>
  <path d="${i.d}" fill="${BRASS_BRIGHT}"/>`;
}

/** Full square icon SVG. `safe` shrinks the mark for maskable safe zones. */
function iconSvg(canvas, { safe = false } = {}) {
  // Regular: AHI is wider than tall — side margins ~13%, generous
  // top/bottom follow from the cap height. Maskable: content must sit in
  // the central 80% circle → ~52% width block.
  const targetWidth = safe ? canvas * 0.52 : canvas * 0.74;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
  <defs>
    <radialGradient id="wash" cx="50%" cy="0%" r="120%">
      <stop offset="0%" stop-color="${PETROL_GLOW}"/>
      <stop offset="55%" stop-color="${PETROL}"/>
      <stop offset="100%" stop-color="${PETROL_DEEP}"/>
    </radialGradient>
  </defs>
  <rect width="${canvas}" height="${canvas}" fill="url(#wash)"/>${mark(canvas, targetWidth)}
</svg>`;
}

/** Minimal ICO container embedding one PNG (valid for all modern browsers). */
function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0); // width
  entry.writeUInt8(size === 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8); // bytes
  entry.writeUInt32LE(22, 12); // offset (6 + 16)
  return Buffer.concat([header, entry, png]);
}

const svg512 = iconSvg(512);
const svgMask = iconSvg(512, { safe: true });

const png = (svg, px) => sharp(Buffer.from(svg), { density: 300 }).resize(px, px).png().toBuffer();

const [p512, p192, p180, p32, pMask] = await Promise.all([
  png(svg512, 512),
  png(svg512, 192),
  png(svg512, 180),
  png(svg512, 32),
  png(svgMask, 512),
]);

mkdirSync(WEB_PUBLIC, { recursive: true });
writeFileSync(join(WEB_PUBLIC, "icon.svg"), svg512);
writeFileSync(join(WEB_PUBLIC, "icon-512.png"), p512);
writeFileSync(join(WEB_PUBLIC, "icon-192.png"), p192);
writeFileSync(join(WEB_PUBLIC, "icon-maskable-512.png"), pMask);
writeFileSync(join(WEB_PUBLIC, "apple-touch-icon.png"), p180);
writeFileSync(join(WEB_PUBLIC, "favicon.ico"), pngToIco(p32, 32));

// Replace the legacy dashboard's old blue 4-dot set with the same mark
// (same filenames its manifest.json/index.html already reference).
for (const name of ["icon.svg", "icon-512.png", "icon-192.png", "apple-touch-icon.png"]) {
  copyFileSync(join(WEB_PUBLIC, name), join(LEGACY_PUBLIC, name));
}

console.log("icon set written → web/public/ (+ legacy public/ mirrors)");
