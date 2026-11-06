/**
 * FM-12 build-message presentation — the gateway's wire-in surface.
 *
 * Spec: foreman/specs/fm12-presentation-patch-spec.md §§1-6.
 *
 * This file exists so the wiring is ONE import and ONE call, and so no existing
 * gateway module had to be edited to land the patch. Nothing here runs on
 * import: no side effects, no timers, no state, no registration. Until a call
 * site calls one of these functions, this module is inert.
 *
 * WHAT MICHAEL WIRES IN (one line, at the single point where a foreman-originated
 * build message is about to be handed to the surface):
 *
 *     import { gateBuildMessage } from "./fm12.js";
 *     const outbound = gateBuildMessage(text, { buildId }).text;
 *
 * `gateBuildMessage` is fail-safe by construction:
 *   - a message that is NOT one of the three declared formats is returned
 *     UNCHANGED — ordinary conversation stays natural prose (§6);
 *   - one of the three that validates is returned byte-for-byte unchanged;
 *   - one of the three that fails is replaced by the §5 safe fallback, with the
 *     complete record written to the internal log and nothing leaked.
 *
 * Sender-side appearance, origin, routing, threading and authorship are all
 * untouched: this returns a string to whoever already owned that send.
 */

export {
  // formats and contract constants
  FM12_FORMATS,
  FM12_HEADER_TEXT,
  FM12_DECISION_HEADER_PREFIX,
  FM12_CATEGORIES,
  FM12_FIELDS,
  FM12_LEGACY_INBOUND_LABELS,
  FM12_CAP_FIELD,
  FM12_CAP_FIELD_DEFAULT,
  FM12_CAP_QUESTION,
  FM12_CAP_TOTAL,
  FM12_CONTENT_RAILS,
  FM12_SAFE_FALLBACK,
  FM12_TOOL,
  // render / validate
  renderPresentation,
  validatePresentation,
  detectPresentationFormat,
  isPresentationForm,
  contentRailHits,
  visibleText,
  codePointLength,
  visibleFieldLen,
  visibleMessage,
  visibleMessageLen,
  sentenceCount,
  // failure behaviour
  safePresent,
  safeValidate,
  defaultFm12Sink,
  defaultFm12EmergencySink,
  Fm12PresentationError,
  // inbound
  parseInbound,
  stripInbound,
} from "./fm12-presentation.js";

export type {
  Fm12Format,
  Fm12RenderInput,
  Fm12FailureRecord,
  Fm12LogSink,
  Fm12GateResult,
  Fm12Inbound,
} from "./fm12-presentation.js";

import {
  detectPresentationFormat,
  safeValidate,
  type Fm12GateResult,
  type Fm12LogSink,
} from "./fm12-presentation.js";

/**
 * The single call site. Returns what should go on the surface.
 *
 * A message that does not declare itself one of the three binding formats is
 * passed through untouched and reported as accepted — the validators bind only
 * the three declared formats (§6), and an ordinary message is never bulleted,
 * never bolded and never capped.
 */
export function gateBuildMessage(
  text: string,
  opts: { buildId?: string; sink?: Fm12LogSink; emergencySink?: Fm12LogSink } = {},
): Fm12GateResult {
  const fmt = detectPresentationFormat(text);
  if (fmt === null) return { text, accepted: true, violations: [] };
  return safeValidate(text, fmt, opts);
}
