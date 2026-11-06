import { useEffect, useRef, useState } from "react";
import { BOT_LABELS } from "../lib/types";
import { actions, getState, useAppState } from "../store";
import { flushOutbox } from "../lib/outbox";
import { IconPlus } from "./icons";
import Recorder from "./Recorder";
import SendSlot from "./SendSlot";
import FolderControl from "../redesign/FolderControl";
import AttachmentShelf from "./AttachmentShelf";
import VoiceOutbox from "./VoiceOutbox";
import { primeElevenEar } from "../lib/elevenear";
import { primeVoiceAudio } from "../lib/voicemode";
import { steerMessage, stopMessage } from "../lib/api";
import { composerLock } from "../lib/ship";
import { showToast } from "../lib/toast";
import { onStageRequest, parseSlash, runSearch, searchStatus, type SearchKind } from "../lib/search";
import {
  ATTACHMENT_CAP,
  makeStagedItem,
  readyMediaIds,
  releaseStaged,
  reorder,
  uploadStaged,
  type StagedItem,
} from "../lib/staging";

/**
 * The composer, in the design grammar: a centered surface field (max
 * 760px, matching the thread column), hairline border that turns brass
 * with a halo on focus, mic beside a 36px brass send circle. All 3a
 * behavior preserved: optimistic enqueue → outbox flush; drafts per bot
 * survive switches and reloads; Enter=send, Shift+Enter=newline.
 */
/** Touch-first devices get Enter = newline (send is the button only);
 *  fine-pointer devices keep Enter = send, Shift+Enter = newline (3d2#10). */
const COARSE_POINTER = window.matchMedia("(pointer: coarse)").matches;

export default function Composer({ bot }: { bot: string }) {
  const { drafts, voiceBots, streams, awaiting, connection, restartingAt, call } = useAppState();
  // A planned restart: sending and voice entry wait, typing does not — the draft is kept.
  const lock = composerLock(connection, restartingAt, Date.now());
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  // The call is the APP's, not this composer's (call-minimize-pill):
  // it lives in the store and is mounted by CallHost in the shell, so this
  // row can unmount — a view change, a pushed screen, a past call opened
  // over the thread — without touching it. Here it is only a light on the
  // voice button.
  const voiceLive = call?.bot === bot;
  const [cargo, setCargo] = useState<StagedItem[]>([]);
  const [dropState, setDropState] = useState<"" | "drop-active" | "drop-declined">("");
  const [queuedPreview, setQueuedPreview] = useState("");
  const [steering, setSteering] = useState(false);
  const queuedAgainst = useRef<Set<string>>(new Set());
  // Inline search. Hidden entirely when the gateway has no key.
  // `searchMode` set = the field is a search box: send runs the search.
  const [searchOn, setSearchOn] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchKind | null>(null);
  const [searching, setSearching] = useState(false);
  const text = drafts[bot] ?? "";
  const hasText = text.trim().length > 0;
  // The send slot flips to send as soon as there is CARGO, even with an empty
  // caption — a file with no words is still a message. Last removal flips back.
  const hasCargo = cargo.length > 0;
  // Voice mode ships dark. Until it is switched on for this agent the
  // composer behaves exactly as it did before voice mode existed: no voice
  // button, and the send slot appears only once there is something to send.
  const voiceAvailable = voiceBots.includes(bot);
  // Cargo still uploading. Sending now would quietly leave those files
  // behind — readyMediaIds skips them and the shelf is cleared regardless.
  const cargoBusy = cargo.some((c) => c.state === "reading");
  const atCap = cargo.length >= ATTACHMENT_CAP;
  const running = Boolean(awaiting[bot]) || Object.values(streams).some((s) => s.bot === bot && !s.done);

  useEffect(() => {
    let live = true;
    void searchStatus().then((st) => {
      if (live) setSearchOn(st.enabled);
    });
    return () => {
      live = false;
    };
  }, []);

  // A picture picked on a search card arrives here as staged cargo — already
  // saved on the gateway (save-only), so it is ready the moment it lands.
  // Decided against the cargo as rendered: a full shelf says no, and the
  // card then tells him it went to Files instead.
  const cargoNow = useRef(cargo);
  cargoNow.current = cargo;
  useEffect(
    () =>
      onStageRequest((req) => {
        if (req.bot !== bot) return false;
        const now = cargoNow.current;
        if (now.some((c) => c.mediaId === req.mediaId)) return true;
        if (now.length >= ATTACHMENT_CAP) return false;
        const item: StagedItem = {
          localId: `stage-search-${req.mediaId}`,
          name: req.name,
          mime: req.mime,
          size: req.size,
          kind: "image",
          state: "ready",
          previewUrl: req.previewUrl,
          mediaId: req.mediaId,
        };
        cargoNow.current = [...now, item];
        setCargo((prev) => (prev.some((c) => c.mediaId === req.mediaId) ? prev : [...prev, item]));
        return true;
      }),
    [bot],
  );

  async function runSearchFrom(kind: SearchKind, q: string, submitted: string) {
    if (searching) return;
    setSearching(true);
    const r = await runSearch(bot, kind, q);
    setSearching(false);
    if (!r.ok) {
      showToast(r.error, 3200);
      return;
    }
    // The card arrives over the socket. Clear the field only if it still holds
    // what was searched: words typed while waiting are his, and stay.
    if ((getState().drafts[bot] ?? "") === submitted) {
      actions.setDraft(bot, "");
      setSearchMode(null);
    }
  }

  async function stop() {
    actions.clearAwaiting(bot);
    setQueuedPreview("");
    setSteering(false);
    await stopMessage(bot);
  }

  async function steer() {
    if (steering) return;
    setSteering(true);
    const accepted = await steerMessage(bot);
    if (!accepted) setSteering(false);
  }

  useEffect(() => {
    if (!queuedPreview) return;
    const promoted = Object.values(streams).some(
      (s) => s.bot === bot && !s.done && !queuedAgainst.current.has(s.streamId),
    );
    if (promoted) {
      setQueuedPreview("");
      setSteering(false);
    }
  }, [bot, queuedPreview, streams]);

  /**
   * Attach = STAGE. The bytes go up immediately so the tile can show its
   * reading state and the file is ready the instant the user hits send, but
   * nothing is broadcast and no agent turn runs until send — words and cargo
   * travel as one message.
   */
  async function stageFiles(list: FileList | File[] | null) {
    if (!list) return;
    const incoming = Array.from(list);
    if (!incoming.length) return;

    // Cap 10 per message: take what fits and decline the rest inline. The
    // shelf's count row carries the note; there is never a toast or a dialog.
    const room = ATTACHMENT_CAP - cargo.length;
    const accepted = incoming.slice(0, Math.max(0, room));
    if (!accepted.length) return;

    const staged = accepted.map(makeStagedItem);
    setCargo((prev) => [...prev, ...staged]);

    await Promise.all(
      staged.map(async (item, i) => {
        const result = await uploadStaged(accepted[i]);
        setCargo((prev) =>
          prev.map((c) =>
            c.localId !== item.localId
              ? c
              : result.ok
                ? { ...c, state: "ready", mediaId: result.mediaId }
                : { ...c, state: "failed", error: result.error },
          ),
        );
      }),
    );
  }

  function removeStaged(localId: string) {
    setCargo((prev) => {
      const hit = prev.find((c) => c.localId === localId);
      if (hit) releaseStaged(hit);
      return prev.filter((c) => c.localId !== localId);
    });
  }

  function resize() {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = parseFloat(getComputedStyle(el).maxHeight) || el.scrollHeight;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    // Same rule as the legacy composer (public/app.js:1033): the scroll
    // wheel exists ONLY once the field is pinned at max height.
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  useEffect(() => {
    resize();
  }, [bot, text]);

  function send() {
    if (lock) return;
    const value = text.trim();
    const user = getState().user;
    if (!user) return;
    // Cargo alone is a valid message; words alone still are too.
    if (!value && !hasCargo) return;
    // Search: the field in search mode, or a typed `/search …` / `/images …`
    // (only when search is on — otherwise those go to the agent as words).
    if (searchOn && value && !hasCargo) {
      const slash = parseSlash(value);
      if (searchMode || slash) {
        void runSearchFrom(slash?.kind ?? (searchMode as SearchKind), slash?.q ?? value, text);
        return;
      }
    }
    // Never send out from under an upload — the file would be dropped
    // silently and the shelf cleared with it. The slot is dimmed meanwhile.
    if (cargoBusy) return;

    const attachmentIds = readyMediaIds(cargo);
    if (running) {
      setQueuedPreview(value || `${attachmentIds.length} attachment${attachmentIds.length === 1 ? "" : "s"}`);
      queuedAgainst.current = new Set(
        Object.values(streams).filter((s) => s.bot === bot && !s.done).map((s) => s.streamId),
      );
    }
    actions.enqueueSend(bot, value, user, attachmentIds); // one message, one turn
    flushOutbox();

    // The crossing: the field clears and the cargo leaves with it. Object URLs
    // are released here — the sent bubble renders from server media.
    cargo.forEach(releaseStaged);
    setCargo([]);
  }

  // v4: TAP enters voice mode — no long-press, no push-to-talk.
  //
  // Tapping opens the voice LAYER, which is its own mode (in essence its own
  // session, like a call). The layer owns the microphone from there: it has
  // to, because it is what renders the connecting state, the permission
  // refusal and the ending. The composer's job ends at opening it — and the
  // layer is mounted by the app shell (CallHost), not here, so leaving this
  // thread no longer ends the call. The unmount cleanup that used to close
  // the mic here went with it: the mic belongs to the call screen, which
  // closes it on END, on a server ending, and on its own unmount (sign-out).
  // A second tap while this agent's call is minimized brings it back.
  //
  // The one thing it does with audio is prime it, here, inside the tap: iOS
  // only starts audio from a gesture, and only lets a page capture while it
  // has declared "play-and-record" (lib/audiosession.ts).
  function enterVoiceMode() {
    if (!voiceAvailable || lock) return;
    primeVoiceAudio();
    // The ElevenLabs side ear's context too: on iOS it only runs if born here.
    primeElevenEar();
    actions.startCall(bot);
  }

  return (
    <div className="composer-row">
      <div
        className={`composer${recording ? " recording" : ""}${dropState ? ` ${dropState}` : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDropState(atCap ? "drop-declined" : "drop-active");
        }}
        onDragLeave={() => setDropState("")}
        onDrop={(e) => {
          e.preventDefault();
          setDropState("");
          // The veil DECLINES the 11th rather than accepting it and complaining.
          if (!atCap) void stageFiles(e.dataTransfer?.files ?? null);
        }}
      >
        {!recording && (
          <AttachmentShelf
            items={cargo}
            onRemove={removeStaged}
            onReorder={(from, to) => setCargo((prev) => reorder(prev, from, to))}
          />
        )}
        {/* Unsent voice notes. Hidden while recording (the strip replaces the
            whole composer then) but otherwise always visible — a note the
            gateway has not confirmed must be somewhere the user can see it. */}
        {!recording && <VoiceOutbox bot={bot} />}
        {!recording && lock && (
          <div className="composer-lock" role="status">
            <span className="status-dot restarting" />
            <span>{lock}</span>
          </div>
        )}
        {!recording && searchMode && (
          <div className="composer-search" role="group" aria-label="Search">
            <span className="composer-search-label mono-label">{searching ? "Searching…" : "Search"}</span>
            <div className="composer-search-kinds" role="radiogroup" aria-label="What to search">
              {(["web", "images"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={searchMode === k}
                  className={`composer-search-kind${searchMode === k ? " is-on" : ""}`}
                  onClick={() => {
                    setSearchMode(k);
                    areaRef.current?.focus();
                  }}
                >
                  {k === "web" ? "Web" : "Pictures"}
                </button>
              ))}
            </div>
            <button type="button" className="composer-search-close" aria-label="Close search" onClick={() => setSearchMode(null)}>
              ✕
            </button>
          </div>
        )}
        {!recording && queuedPreview && (
          <div className="steer-preview" role="status">
            <span className="steer-preview-text">{queuedPreview}</span>
            <button type="button" className="steer-action" disabled={steering} onClick={() => void steer()}>
              {steering ? "Steering" : "Steer"}
            </button>
          </div>
        )}
        <div className={`composer-pill${searchMode ? " is-search" : ""}`}>
          {!recording && (
            <>
              <FolderControl bot={bot} agentLabel={BOT_LABELS[bot] ?? bot} busy={running || voiceLive} hasDraft={!!drafts[bot]?.trim() || cargo.length > 0} />
              <button
                type="button"
                className={`composer-icon attach${atCap ? " at-cap" : ""}`}
                title="Attach files or images"
                aria-label="Attach"
                onClick={() => attachRef.current?.click()}
              >
                <IconPlus />
              </button>
              {/* No search button in the composer (FINAL): Web and Images live in the top search and run
                  in its panel. A typed /search or /images still runs here when search is on. */}
              <input
                ref={attachRef}
                type="file"
                multiple
                accept="image/*,application/pdf,.doc,.docx,.txt,.md,.csv,.xlsx,audio/*,.mp3,.m4a,.ogg,.wav,video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                hidden
                onChange={(e) => {
                  void stageFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <textarea
                ref={areaRef}
                rows={1}
                placeholder={searchMode === "web" ? "Search the web…" : searchMode === "images" ? "Search pictures…" : `Message ${BOT_LABELS[bot] ?? bot}…`}
                enterKeyHint={searchMode ? "search" : undefined}
                value={text}
                onChange={(e) => actions.setDraft(bot, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && searchMode) {
                    setSearchMode(null);
                    return;
                  }
                  // A search box submits on Enter on every device.
                  if (e.key === "Enter" && !e.shiftKey && (!COARSE_POINTER || searchMode)) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
            </>
          )}
          {/* v4 deck p.6: the mic keeps its place and the SEND SLOT sits
              immediately right of it. The slot carries voice-entry when the
              field is empty and the send glyph once there is text — swapped
              in place, so neither button ever moves. */}
          <Recorder bot={bot} onPhase={setRecording} />
          {/* Dark-ship gate. With voice mode off for this agent the slot only
              exists once there is something to send — which is exactly the
              pre-merge composer. Without this every production user gets a
              voice button that cannot do anything. */}
          {/* Running counts too: an agent without voice mode still needs Stop while it replies (FINAL: active reply, no payload → Stop). */}
          {!recording && (voiceAvailable || hasText || hasCargo || running) && (
            <SendSlot
              hasText={hasText || hasCargo}
              voiceAvailable={voiceAvailable}
              live={voiceLive}
              busy={cargoBusy || !!lock || searching}
              running={running}
              hasDraft={hasText || hasCargo}
              onSend={send}
              onStop={() => void stop()}
              onEnterVoiceMode={enterVoiceMode}
            />
          )}
        </div>
      </div>
    </div>
  );
}
