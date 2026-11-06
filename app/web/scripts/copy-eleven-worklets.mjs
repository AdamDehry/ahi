#!/usr/bin/env node
/* Copy ElevenLabs' AudioWorklet files into public/ so calls load them from
   our own origin (lib/elevencall.ts). The SDK's default is a blob: URL and the
   CSP (script-src 'self') refuses it; Vite would inline a `?url` import as a
   data: URL, refused the same way. Runs before every build (prebuild), so an
   SDK upgrade brings its own worklets with it. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const out = join(here, "..", "public", "eleven-worklets");
mkdirSync(out, { recursive: true });
// The package exports "./worklets/*" (not its package.json).
// Written fresh, not copied: node_modules here can be hard links into a shared
// read-only cache, and copyFile kept that 0444 mode, so the NEXT build's copy
// over it failed with EACCES (10/22). Remove, then write the bytes (mode 0644).
for (const f of ["rawAudioProcessor.js", "audioConcatProcessor.js"]) {
  const dest = join(out, f);
  rmSync(dest, { force: true });
  writeFileSync(dest, readFileSync(require.resolve(`@elevenlabs/client/worklets/${f}`)), { mode: 0o644 });
}
console.log(`[eleven] worklets → ${out}`);
