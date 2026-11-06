import { ownerUserId } from "./users.js";
import { readFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { atomicWriteJson, multiUserPaths, warnDeprecatedPath } from "./multi-user-paths.js";

export interface Clip {
  id: string;
  text: string;
  created: string;
}

interface ClipStore {
  clips: Clip[];
}

const MAX_CLIPS = 50;

function load(userId: string): ClipStore {
  const paths = multiUserPaths(userId);
  if (existsSync(paths.clipboardJson)) {
    try {
      const data = JSON.parse(readFileSync(paths.clipboardJson, "utf-8"));
      if (Array.isArray(data.clips)) return data;
    } catch {
      /* corrupted */
    }
  }
  const legacy = existsSync(paths.legacy.clipboardUserJson)
    ? paths.legacy.clipboardUserJson
    : userId === ownerUserId() && existsSync(paths.legacy.clipboardJson)
      ? paths.legacy.clipboardJson
      : null;
  if (legacy) {
    warnDeprecatedPath(`clipboard:${userId}:${legacy}`, legacy, paths.clipboardJson);
    try {
      const data = JSON.parse(readFileSync(legacy, "utf-8"));
      if (Array.isArray(data.clips)) return data;
      const clips: Clip[] = [];
      if (typeof data.current === "string" && data.current) {
        clips.push({ id: randomUUID(), text: data.current, created: new Date().toISOString() });
      }
      if (Array.isArray(data.history)) {
        for (const h of data.history) {
          if (typeof h === "string" && h) {
            clips.push({ id: randomUUID(), text: h, created: new Date().toISOString() });
          }
        }
      }
      return { clips };
    } catch {
      /* corrupted legacy */
    }
  }
  return { clips: [] };
}

function save(userId: string, store: ClipStore): void {
  atomicWriteJson(multiUserPaths(userId).clipboardJson, store);
}

export function getClips(userId: string): Clip[] {
  return load(userId).clips;
}

export function addClip(userId: string, text: string): Clip {
  const store = load(userId);
  const clip: Clip = { id: randomUUID(), text, created: new Date().toISOString() };
  store.clips.unshift(clip);
  if (store.clips.length > MAX_CLIPS) store.clips.pop();
  save(userId, store);
  return clip;
}

export function deleteClip(userId: string, id: string): boolean {
  const store = load(userId);
  const idx = store.clips.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  store.clips.splice(idx, 1);
  save(userId, store);
  return true;
}
