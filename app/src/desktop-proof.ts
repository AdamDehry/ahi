import { createHmac } from "crypto";
import { loadUsers } from "./users.js";

// The desktop app's proof that a server on the port is THIS home's AHI before it sends the owner's key or opens the
// signed-in window: it asks /health?challenge=<64 hex> and expects HMAC-SHA256(owner key, label + challenge). The home
// id in /health is a path hash anyone can read; only a server that can read this home's users file can answer this.
// The key never leaves the server, and the label keeps this HMAC from meaning anything anywhere else.
export const DESKTOP_PROOF_LABEL = "ahi-desktop-proof:";

export function desktopProof(challenge: string | undefined): string | undefined {
  if (!challenge || !/^[0-9a-f]{64}$/.test(challenge)) return undefined;
  let owner;
  try {
    owner = loadUsers().find((u) => u.admin && u.token);
  } catch {
    return undefined;
  }
  return owner ? createHmac("sha256", owner.token).update(DESKTOP_PROOF_LABEL + challenge).digest("hex") : undefined;
}
