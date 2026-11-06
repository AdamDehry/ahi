interface QueuedTurn {
  run: (signal: AbortSignal) => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
}

interface TurnLane {
  active: AbortController | null;
  queue: QueuedTurn[];
}

const lanes = new Map<string, TurnLane>();

function turnKey(userId: string, botName: string): string {
  return `${userId}:${botName.toLowerCase()}`;
}

export function runDashboardTurn<T>(
  userId: string,
  botName: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const key = turnKey(userId, botName);
  const lane = lanes.get(key) ?? { active: null, queue: [] };
  lanes.set(key, lane);

  const promise = new Promise<T>((resolve, reject) => {
    lane.queue.push({ run, resolve, reject });
  });
  pumpLane(key, lane);
  return promise;
}

function pumpLane(key: string, lane: TurnLane): void {
  if (lane.active || lane.queue.length === 0) return;
  const job = lane.queue.shift()!;
  const controller = new AbortController();
  lane.active = controller;
  void job.run(controller.signal).then(job.resolve, job.reject).finally(() => {
    if (lane.active === controller) lane.active = null;
    if (!lane.active && lane.queue.length === 0) lanes.delete(key);
    else pumpLane(key, lane);
  });
}

export function stopDashboardTurn(userId: string, botName: string): boolean {
  const key = turnKey(userId, botName);
  const lane = lanes.get(key);
  if (!lane?.active) return false;
  lane.active.abort("manual_cancel");
  for (const job of lane.queue.splice(0)) job.reject(new Error("AbortError: queued turn cancelled"));
  return true;
}

export function steerDashboardTurn(userId: string, botName: string): boolean {
  const lane = lanes.get(turnKey(userId, botName));
  if (!lane?.active || lane.queue.length === 0) return false;
  lane.active.abort("steered");
  return true;
}

export function isManualTurnCancel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /AbortError|aborted by signal/i.test(message);
}
