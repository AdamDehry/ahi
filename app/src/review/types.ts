/**
 * Review desk — shared types. See STANDING-MANDATES.md (v1):
 * GREEN just runs and is logged; YELLOW waits in the batch for a yes; RED
 * gets a full brief and a fingerprint (passkey) before it can be approved.
 */

export type Lane = "GREEN" | "YELLOW" | "RED";
export type ItemStatus = "waiting" | "approved" | "denied" | "held" | "done";
export type Decision = "approve" | "deny" | "hold";
/**
 * How a decision reached the desk. "fingerprint" is never claimed by a
 * client: the server assigns it only after verifying a WebAuthn assertion.
 */
export type Channel = "tap" | "chat" | "fingerprint";

export const LANES: readonly Lane[] = ["GREEN", "YELLOW", "RED"];

export interface PasskeyEvidence {
  credential_id: string;
  verified: boolean;
  user_verified: boolean;
  new_counter: number;
  origin: string;
  rp_id: string;
}

export interface ReviewItem {
  id: string;
  lane: Lane;
  desk: string;
  /** One line. */
  title: string;
  /** Plain-English brief, markdown. */
  brief: string;
  /** One line: what it costs / what can go wrong. */
  cost_risk: string;
  created: string;
  created_by: string;
  /** userId this item is addressed to (the person who decides). */
  owner: string;
  status: ItemStatus;
  decided_at: string | null;
  decided_how: string | null;
  /** Optional pointer back to the work (foreman build id, path, URL). */
  ref: string | null;
  done_at: string | null;
  done_note: string | null;
  /** The card was announced in the owner's chat (message + voice note — its push) at… */
  notified_at: string | null;
  /** The announcement was held back, and why (Shabbat / Yom Tov — the motzei message carries it; "failed"). */
  notify_deferred: string | null;
  /** RED: the ONE end-of-day reminder went out at… (then the item holds). */
  reminded_at: string | null;
  /** RED: evidence of the fingerprint that approved it. */
  passkey: PasskeyEvidence | null;
  /** B4: the open track this item belongs to (trk-… / bld-…) — it then shows in Builds → Needs you. */
  track?: string | null;
}

export interface NewItemInput {
  lane: Lane;
  desk: string;
  title: string;
  brief: string;
  cost_risk?: string;
  owner?: string;
  ref?: string | null;
  track?: string | null;
}

/** One line of the append-only decision log. */
export interface LogRecord {
  at: string;
  kind:
    | "created"
    | "decision"
    | "refused"
    | "done"
    | "reminded"
    | "auto-hold"
    | "passkey-added"
    | "passkey-removed"
    | "enrollment-opened"
    | "scheduled"
    | "track-added"
    | "track-updated"
    | "track-filed"
    | "track-closed"
    | "ship-approved"
    | "wake-queued"
    | "wake-deferred"
    | "wake-sent"
    | "wake-failed"
    | "wake-skipped"
    | "announced"
    | "alert-started"
    | "alert-resolved"
    | "alert-acked"
    | "alert-wake"
    | "alert-pushed"
    | "feed-launch-requested"
    | "feed-launch-started"
    | "feed-launch-failed"
    | "feed-brief-asked"
    | "feed-row-left"
    | "feed-row-closed"
    | "feed-row-filed";
  item_id?: string;
  track_id?: string;
  /** Feed rows (trk-/bld-/idea-/brief-…). */
  row_id?: string;
  lane?: Lane;
  actor: string;
  from?: ItemStatus;
  to?: ItemStatus;
  decision?: Decision;
  channel?: Channel;
  how?: string;
  reason?: string;
  /** sha256 of the brief the decision was made against. */
  brief_sha256?: string;
  passkey?: PasskeyEvidence;
  credential_id?: string;
  note?: string;
}
