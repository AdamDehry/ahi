#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const AHI_HOME = path.resolve(process.env.AHI_HOME || path.join(os.homedir(), "ahi"));
const indexPath = path.join(AHI_HOME, "state", "primary", "sessions", "index.json");
const script = path.join(AHI_HOME, "infra", "sessions", "scripts", "process-session.mjs");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function candidateJsonls() {
  const out = [];
  const projects = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projects)) return out;
  for (const dir of fs.readdirSync(projects)) {
    const full = path.join(projects, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (file.endsWith(".jsonl")) out.push(path.join(full, file));
    }
  }
  return out;
}

const quiet = process.argv.includes("--quiet");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
const index = readJson(indexPath, []);
const indexed = new Set(index.map((e) => e.session_id));
const needs = [];
for (const entry of index) {
  if (!entry.summary || !entry.transcript_path_md || !entry.shaar || !entry.shoresh) {
    if (entry.transcript_path && fs.existsSync(entry.transcript_path)) needs.push(entry.transcript_path);
  }
}
for (const jsonl of candidateJsonls()) {
  const sid = path.basename(jsonl, ".jsonl");
  if (!indexed.has(sid)) needs.push(jsonl);
}

let processed = 0;
for (const jsonl of needs.slice(0, limit)) {
  const res = spawnSync(process.execPath, [script, "--jsonl", jsonl, "--quiet"], {
    stdio: quiet ? "pipe" : "inherit",
    env: { ...process.env, AHI_HOME },
  });
  if (res.status === 0) processed++;
}
if (!quiet) console.log(`[process-missing] processed ${processed}/${Math.min(needs.length, limit)}`);
