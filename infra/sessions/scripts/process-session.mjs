#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { deriveAddress } from "./shaar_shoresh_address_book.mjs";

const AHI_HOME = path.resolve(process.env.AHI_HOME || path.join(os.homedir(), "ahi"));
const sessionsDir = path.join(AHI_HOME, "state", "primary", "sessions");
const indexPath = process.env.AHI_SESSIONS_INDEX || path.join(sessionsDir, "index.json");
const transcriptsRoot = path.join(sessionsDir, "transcripts");

const VALID_CATEGORIES = new Set(["ahi-infrastructure", "personal", "voice-work", "general"]);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function safeSlug(text) {
  return String(text || "session")
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "session";
}

function deriveGatewayProjectDir() {
  const gatewayCwd = path.join(AHI_HOME, "gateway");
  const slug = gatewayCwd.replace(/[\\/]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug);
}

function findJsonl(sessionId) {
  const direct = arg("--jsonl") || "";
  if (direct && fs.existsSync(direct)) return path.resolve(direct);
  const candidates = [
    path.join(deriveGatewayProjectDir(), `${sessionId}.jsonl`),
  ];
  const projects = path.join(os.homedir(), ".claude", "projects");
  if (fs.existsSync(projects)) {
    for (const dir of fs.readdirSync(projects)) {
      candidates.push(path.join(projects, dir, `${sessionId}.jsonl`));
    }
  }
  return candidates.find((p) => fs.existsSync(p)) || "";
}

function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((x) => x && typeof x === "object" && x.type === "text" && typeof x.text === "string")
    .map((x) => x.text.trim())
    .filter(Boolean)
    .join("\n");
}

function extractTurns(jsonlPath) {
  const turns = [];
  const seen = new Set();
  const lines = fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "queue-operation" && obj.operation === "enqueue") {
      const text = String(obj.content || "").trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        turns.push({ role: "human", text, timestamp: obj.timestamp || "" });
      }
      continue;
    }
    if (obj.type === "user" && obj.parentUuid == null) {
      const text = textFromContent(obj.message?.content);
      if (text && !seen.has(text)) {
        seen.add(text);
        turns.push({ role: "human", text, timestamp: obj.timestamp || "" });
      }
      continue;
    }
    if (obj.type === "assistant") {
      const text = textFromContent(obj.message?.content);
      if (text) turns.push({ role: "agent", text, timestamp: obj.timestamp || "" });
    }
  }
  return turns;
}

function categoryFor(text) {
  const t = text.toLowerCase();
  if (/gateway|agent|session|hook|claude|skill|memory|install|repo|build|deploy|typescript|node|browser|github/.test(t)) return "ahi-infrastructure";
  if (/voice|audio|tts|stt|speech|transcri/.test(t)) return "voice-work";
  if (/family|personal|relationship|home|schedule|health|feeling/.test(t)) return "personal";
  return "general";
}

function titleFor(turns, category) {
  const firstHuman = turns.find((t) => t.role === "human")?.text || category;
  const words = firstHuman
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 7);
  if (!words.length) return "The One About a New Session";
  return "The One About " + words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function summarize(turns) {
  const human = turns.filter((t) => t.role === "human").map((t) => t.text).join(" ").slice(0, 500);
  const agent = turns.filter((t) => t.role === "agent").map((t) => t.text).join(" ").slice(0, 700);
  const bullets = [];
  if (human) bullets.push(`- User focus: ${human.replace(/\s+/g, " ").slice(0, 220)}`);
  if (agent) bullets.push(`- Agent work: ${agent.replace(/\s+/g, " ").slice(0, 260)}`);
  bullets.push(`- Turn count: ${turns.length} captured turns.`);
  return bullets.join("\n");
}

function writeTranscript(entry, turns, episodeName, category) {
  const started = entry.started_at || turns[0]?.timestamp || new Date().toISOString();
  const date = started.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const slug = safeSlug(episodeName);
  const out = path.join(transcriptsRoot, category, `${date}--${slug}.md`);
  ensureDir(path.dirname(out));
  const agent = entry.agent || "agent";
  const userName = entry.telegram_user || process.env.AHI_USER_NAME || "User";
  const lines = [
    `# ${episodeName}`,
    `**Session:** ${entry.session_id}`,
    `**Agent:** ${agent}`,
    `**Date:** ${date}`,
    `**Channel:** ${entry.channel || "claude-code"}`,
    `**Category:** ${category}`,
    "",
    "---",
    "",
  ];
  for (const turn of turns) {
    const speaker = turn.role === "human" ? userName : agent;
    lines.push(`**${speaker}:** ${turn.text}`, "");
  }
  fs.writeFileSync(out, lines.join("\n"));
  return out;
}

function main() {
  const sessionId = arg("--session-id") || arg("--session") || "";
  const jsonlArg = arg("--jsonl") || "";
  const quiet = process.argv.includes("--quiet");
  if (!sessionId && !jsonlArg) {
    console.error("usage: process-session.mjs --session-id <id> [--jsonl path] [--quiet]");
    process.exit(2);
  }
  const sid = sessionId || path.basename(jsonlArg, ".jsonl");
  const jsonl = jsonlArg ? path.resolve(jsonlArg) : findJsonl(sid);
  if (!jsonl || !fs.existsSync(jsonl)) {
    if (!quiet) console.error(`[process-session] jsonl not found for ${sid}`);
    process.exit(1);
  }
  const index = readJson(indexPath, []);
  let entry = index.find((e) => e.session_id === sid);
  if (!entry) {
    entry = {
      session_id: sid,
      agent: process.env.AHI_AGENT || "unknown",
      channel: "claude-code",
      telegram_chat_id: null,
      telegram_user: null,
      started_at: new Date(fs.statSync(jsonl).mtimeMs).toISOString(),
      episode_name: null,
      category: null,
      transcript_path: jsonl,
    };
    index.push(entry);
  }
  entry.transcript_path = jsonl;
  const turns = extractTurns(jsonl);
  if (!turns.length) {
    if (!quiet) console.error(`[process-session] no turns extracted from ${jsonl}`);
    process.exit(1);
  }
  const preview = turns.slice(0, 8).map((t) => t.text).join("\n");
  const category = VALID_CATEGORIES.has(entry.category) ? entry.category : categoryFor(preview);
  const episodeName = entry.episode_name || titleFor(turns, category);
  const summary = summarize(turns);
  const transcript = writeTranscript(entry, turns, episodeName, category);
  const address = deriveAddress({ category, episode_name: episodeName, summary });
  Object.assign(entry, {
    episode_name: episodeName,
    category,
    transcript_path_md: transcript,
    summary,
    shaar: address.shaar,
    shoresh: address.shoresh,
    last_processed_at: new Date().toISOString(),
  });
  writeJson(indexPath, index);
  if (!quiet) console.log(`[process-session] processed ${sid} -> ${path.relative(AHI_HOME, transcript)}`);
}

main();
