#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const AHI_HOME = path.resolve(process.env.AHI_HOME || path.join(os.homedir(), "ahi"));
const scripts = path.join(AHI_HOME, "infra", "sessions", "scripts");
const quiet = process.argv.includes("--quiet");
const stdio = quiet ? "pipe" : "inherit";
for (const name of ["process-missing.mjs", "enrich-shaar-shoresh.mjs"]) {
  const res = spawnSync(process.execPath, [path.join(scripts, name), "--quiet"], {
    stdio,
    env: { ...process.env, AHI_HOME },
  });
  if (res.status !== 0 && !quiet) console.error(`[brain-build] ${name} exited ${res.status}`);
}
