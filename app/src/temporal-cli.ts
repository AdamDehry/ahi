#!/usr/bin/env node
/**
 * temporal-cli.ts — operator CLI for the temporal timeline and ETA records.
 *
 *   node dist/temporal-cli.js envelope --user owner --agent michael [--now ISO] [--prompt TEXT] [--json]
 *       Read-only. Prints the enhanced block (or the envelope JSON) as the hook would
 *       build it, with the envelope flag forced on for this process only.
 *   node dist/temporal-cli.js context --user owner [--device ID]
 *       Read-only. The user's temporal-context record and the zone it resolves to.
 *   node dist/temporal-cli.js event --user owner --type builder_started --source foreman
 *       [--task ID] [--label TEXT] [--agent A] [--at ISO]
 *   node dist/temporal-cli.js eta open --category gateway-change --scope small --builder claude
 *       [--model M] [--effort E] --low 20m --high 40m
 *   node dist/temporal-cli.js eta close <id> --outcome completed [--wall 35m] [--active 30m]
 *       [--user-wait 5m] [--external 0m] [--blockers a,b]
 *   node dist/temporal-cli.js eta stats
 *
 * Writes go to <gatewayStateRoot>/temporal/ (AHI_GATEWAY_STATE_DIR moves it).
 * Timing facts only — there is no flag that accepts message text.
 */

import {
  closeEtaRecord,
  estimate,
  foremanCalibration,
  formatRange,
  openEtaRecord,
  parseDuration,
  readEtaRecords,
  type EtaOutcome,
  type ScopeSize,
} from "./eta-calibration.js";
import { formatDuration } from "./local-time.js";
import { loadTemporalContext, resolveEffectiveZone } from "./temporal-context-store.js";
import { safeLookupUser } from "./temporal-envelope.js";
import { readForemanBuilds, recordTemporalEvent, TEMPORAL_EVENT_TYPES, type TemporalEventSource, type TemporalEventType } from "./temporal-events.js";
import { buildTurnTimeContext } from "./time-context.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--")) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

function need(args: string[], name: string): string {
  const v = flag(args, name);
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

function optDuration(args: string[], name: string): number | undefined {
  const v = flag(args, name);
  return v === undefined ? undefined : parseDuration(v);
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "envelope": {
      process.env.AHI_TEMPORAL_ENVELOPE = process.env.AHI_TEMPORAL_ENVELOPE || "all";
      const nowArg = flag(rest, "now");
      const now = nowArg ? new Date(nowArg) : new Date();
      if (Number.isNaN(now.getTime())) throw new Error(`invalid --now ${nowArg}`);
      const ctx = buildTurnTimeContext({
        userId: flag(rest, "user") ?? null,
        agent: flag(rest, "agent") ?? "michael",
        now,
        prompt: flag(rest, "prompt") ?? null,
        transcriptPath: flag(rest, "transcript") ?? null,
      });
      if (rest.includes("--json")) console.log(JSON.stringify(ctx.envelope ?? null, null, 2));
      else console.log(ctx.text);
      return 0;
    }
    case "context": {
      const userId = need(rest, "user");
      const user = safeLookupUser(userId);
      const rec = loadTemporalContext(userId, { zone: user?.timezone, label: user?.locationLabel });
      console.log(JSON.stringify({ record: rec, effective: resolveEffectiveZone(rec, { deviceId: flag(rest, "device") }) }, null, 2));
      return 0;
    }
    case "event": {
      const type = need(rest, "type") as TemporalEventType;
      if (!TEMPORAL_EVENT_TYPES.includes(type)) throw new Error(`--type must be one of ${TEMPORAL_EVENT_TYPES.join(", ")}`);
      const ev = recordTemporalEvent({
        userId: need(rest, "user"),
        type,
        source: (flag(rest, "source") ?? "system") as TemporalEventSource,
        taskId: flag(rest, "task"),
        label: flag(rest, "label"),
        agent: flag(rest, "agent"),
        occurredAt: flag(rest, "at"),
      });
      if (!ev) throw new Error("event not recorded (see stderr / permissions)");
      console.log(JSON.stringify(ev));
      return 0;
    }
    case "eta": {
      const [sub, ...a] = rest;
      if (sub === "open") {
        const rec = openEtaRecord({
          taskCategory: need(a, "category"),
          scopeSize: need(a, "scope") as ScopeSize,
          builder: need(a, "builder"),
          model: flag(a, "model"),
          effort: flag(a, "effort"),
          predictedLowMs: parseDuration(need(a, "low")),
          predictedHighMs: parseDuration(need(a, "high")),
        });
        console.log(JSON.stringify(rec));
        return 0;
      }
      if (sub === "close") {
        const id = a[0];
        if (!id || id.startsWith("--")) throw new Error("usage: eta close <id> --outcome completed ...");
        const rec = closeEtaRecord(id, {
          outcome: need(a, "outcome") as EtaOutcome,
          wallClockMs: optDuration(a, "wall"),
          activeRuntimeMs: optDuration(a, "active"),
          userWaitMs: optDuration(a, "user-wait"),
          externalWaitMs: optDuration(a, "external"),
          blockerCodes: flag(a, "blockers")?.split(",").filter(Boolean),
        });
        console.log(JSON.stringify(rec));
        return 0;
      }
      if (sub === "stats") {
        const records = readEtaRecords();
        const builds = readForemanBuilds();
        const completed = builds.filter((b) => b.outcome === "completed").length;
        console.log(`Foreman builds read: ${builds.length} (completed ${completed})`);
        for (const s of foremanCalibration(builds)) {
          console.log(`  ${s.key.padEnd(44)} median ${formatDuration(s.medianMs).padEnd(7)} p25–p75 ${formatRange(s.p25Ms, s.p75Ms).padEnd(14)} n=${s.n}`);
        }
        console.log(`ETA records: ${records.length} (closed ${records.filter((r) => r.outcome).length})`);
        for (const r of records) {
          const actual = r.wallClockMs !== undefined ? formatDuration(r.wallClockMs) : "open";
          console.log(`  ${r.id.slice(0, 8)} ${r.taskCategory}/${r.scopeSize} ${r.builder} predicted ${formatRange(r.predictedLowMs, r.predictedHighMs)} actual ${actual} ${r.outcome ?? ""}`);
        }
        const est = estimate({ scopeSize: "small", builder: "claude" }, records);
        console.log(`Default small-change estimate now: ${formatRange(est.lowMs, est.highMs)} (${est.basis}, ${est.samples} comparable records)`);
        return 0;
      }
      throw new Error("usage: eta open|close|stats");
    }
    default:
      console.error("usage: temporal-cli envelope|context|event|eta …  (see file header)");
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`[temporal-cli] ${(err as Error).message}`);
  process.exitCode = 1;
}
