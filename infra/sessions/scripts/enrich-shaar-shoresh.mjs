#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { deriveAddress } from "./shaar_shoresh_address_book.mjs";

const AHI_HOME = path.resolve(process.env.AHI_HOME || path.join(os.homedir(), "ahi"));
const indexPath = process.env.AHI_SESSIONS_INDEX || path.join(AHI_HOME, "state", "primary", "sessions", "index.json");

const entries = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : [];
let changed = 0;
for (const entry of entries) {
  const addr = deriveAddress(entry);
  if (entry.shaar !== addr.shaar || entry.shoresh !== addr.shoresh) {
    entry.shaar = addr.shaar;
    entry.shoresh = addr.shoresh;
    changed++;
  }
}
fs.mkdirSync(path.dirname(indexPath), { recursive: true });
fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2) + "\n");
console.log(`[enrich-shaar-shoresh] enriched ${changed} entries`);
