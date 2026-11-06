/**
 * Home (slice 4, FINAL): ask anything of the chosen agent, three starters,
 * Continue with your lead agent, then "A little attention. A lot in motion."
 * — the one thing waiting on you (a real Review item or build question) and
 * what is moving (real build cards).
 *
 * Sending uses the existing outbox (actions.enqueueSend + flushOutbox), then
 * lands in that agent's conversation. The decision card never approves
 * anything: "Let's review" opens the real Review item (D04).
 */
import { useEffect, useRef, useState } from "react";
import { actions, availableBots, getState, useAppState } from "../store";
import { flushOutbox } from "../lib/outbox";
import { primeVoiceAudio } from "../lib/voicemode";
import { primeElevenEar } from "../lib/elevenear";
import { BOT_LABELS, BOT_SUBTITLES } from "../lib/types";
import { BUILDS_URL, type BuildsView, type Card } from "../lib/builds";
import { fetchReview, type ReviewItem } from "../lib/review";
import { Icon } from "./icons";
import { AgentAvatar } from "./AgentRail";
import { goPage } from "./Shell";
import { railOrder } from "./agents";

function greeting(zone: string | undefined): string {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: zone || undefined }).format(new Date()));
  return h < 12 ? "GOOD MORNING" : h < 17 ? "GOOD AFTERNOON" : "GOOD EVENING";
}

const STARTERS: Array<{ icon: "sun" | "spark" | "pulse"; label: string; prompt: string }> = [
  { icon: "sun", label: "Plan my day", prompt: "Help me plan the rest of my day." },
  { icon: "spark", label: "Start something", prompt: "Let’s start something new." },
  { icon: "pulse", label: "Catch me up", prompt: "Catch me up on what matters today." },
];

/** Open an agent's conversation (phone: straight into it). */
function openChat(bot: string) {
  actions.setView("messages");
  actions.openMobileThread(bot);
}

function useWorkData(admin: boolean) {
  const [builds, setBuilds] = useState<BuildsView | null>(null);
  const [review, setReview] = useState<ReviewItem[] | null>(null);
  const { buildsRev, reviewRev } = useAppState();
  useEffect(() => {
    if (!admin) return;
    let live = true;
    fetch(BUILDS_URL, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((v) => live && setBuilds(v)).catch(() => live && setBuilds(null));
    void fetchReview(false).then((v) => live && setReview(v ? v.waiting : null));
    return () => {
      live = false;
    };
  }, [admin, buildsRev, reviewRev]);
  return { builds, review };
}

export default function Home() {
  const s = useAppState();
  const admin = !!s.user?.admin;
  const bots = railOrder(availableBots(s.user));
  const [picked, setPicked] = useState<string | null>(null);
  // The effective agent is re-derived from the CURRENT access every render (review R1-A5): an
  // agent removed while Home is open can neither stay selected nor receive a send.
  const fallback: string | null = bots.includes("michael") ? "michael" : (bots[0] as string | undefined) ?? null;
  const agent = picked && bots.includes(picked) ? picked : fallback;
  const setAgent = (b: string) => setPicked(b);
  const [text, setText] = useState("");
  const [picking, setPicking] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const { builds, review } = useWorkData(admin);
  const lead = bots.includes("michael") ? "michael" : bots[0];
  // No agent this session may message (review R2-5): say so instead of showing a name it cannot use.
  if (!agent) {
    return (
      <div className="rd-page rd-page-scroll rd-home" data-page="home">
        <section className="rd-home-hero">
          <h1 className="rd-home-title">Welcome.</h1>
          <p className="rd-sub">No agents are available to you yet. Whoever runs this workspace can add one for you.</p>
        </section>
      </div>
    );
  }

  const send = () => {
    const value = text.trim();
    const user = getState().user;
    if (!value || !user || !availableBots(user).includes(agent)) return;
    actions.enqueueSend(agent, value, user, []);
    flushOutbox();
    setText("");
    openChat(agent);
  };
  /**
   * Attach and Talk continue in the agent's own conversation; the words typed here go with you
   * as that agent's draft. Talk starts the call directly, inside this tap (the same priming the
   * composer does) — it never clicks the composer's send slot, which would SEND a draft (review
   * R1-C2). Attach opens that agent's file picker only if that conversation is still the one
   * showing when the composer mounts (review R1-C3).
   */
  const handOff = (then: "attach" | "voice") => {
    if (!availableBots(getState().user).includes(agent)) return;
    if (text.trim()) actions.setDraft(agent, text);
    setText("");
    if (then === "voice") {
      primeVoiceAudio();
      primeElevenEar();
      actions.startCall(agent);
      openChat(agent);
      return;
    }
    openChat(agent);
    window.setTimeout(() => {
      const st = getState();
      if (st.view !== "messages" || st.activeBot !== agent || st.settingsOpen) return;
      (document.querySelector(".rd-chat-pane:not([hidden]) .composer-icon.attach, .mobile-screen.pushed .composer-icon.attach") as HTMLButtonElement | null)?.click();
    }, 60);
  };

  const one: { title: string; body: string; tag: string; go: () => void; action: string } | null = (() => {
    const r = review?.[0];
    if (r) return { title: r.title, body: r.cost_risk || "Ready for your okay.", tag: r.desk, go: () => actions.openReview(r.id), action: "Let’s review" };
    const q = builds?.sections.needs_you[0];
    if (q) return { title: q.title, body: q.ask ?? q.now?.text ?? "One decision is waiting on you.", tag: "Your work", go: () => actions.openBuilds(q.id), action: "Open it" };
    return null;
  })();
  const moving: Card[] = builds ? [...builds.sections.moving, ...builds.sections.ready].slice(0, 3) : [];

  return (
    <div className="rd-page rd-page-scroll rd-home" data-page="home">
      <section className="rd-home-hero">
        <div className="rd-eyebrow">{greeting(undefined)}{s.user?.name ? `, ${s.user.name.split(" ")[0].toUpperCase()}` : ""}</div>
        <h1 className="rd-home-title">What can I take off your plate?</h1>
        <p className="rd-sub">One conversation. Your whole world, working together.</p>
        <form
          className="rd-home-composer"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label htmlFor="rd-home-request" className="sr-only">Ask {BOT_LABELS[agent] ?? agent} anything</label>
          <textarea
            id="rd-home-request"
            ref={area}
            rows={2}
            value={text}
            placeholder="Ask anything, or tell me what you need…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="rd-home-toolbar">
            <div className="rd-agent-picker">
              <button type="button" className="rd-picker-btn" aria-haspopup="listbox" aria-expanded={picking} onClick={() => setPicking(!picking)}>
                <span className="rd-picker-dot" data-bot={agent} />
                <span className="rd-picker-name">{BOT_LABELS[agent] ?? agent}</span>
                <span className="rd-picker-role">{BOT_SUBTITLES[agent] ?? ""}</span>
                <Icon name="chevron" />
              </button>
              {picking && (
                <ul className="rd-picker-menu" role="listbox" aria-label="Who to ask">
                  {bots.map((b) => (
                    <li key={b}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={b === agent}
                        onClick={() => {
                          setAgent(b);
                          setPicking(false);
                          area.current?.focus();
                        }}
                      >
                        <AgentAvatar bot={b} size="sm" />
                        {BOT_LABELS[b] ?? b}
                        <small>{BOT_SUBTITLES[b] ?? ""}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rd-home-actions">
              <button type="button" className="rd-chat-control" aria-label="Attach a file" onClick={() => handOff("attach")}>
                <Icon name="plus" />
              </button>
              {s.voiceBots.includes(agent) && (
                <button type="button" className="rd-chat-control" aria-label={`Talk to ${BOT_LABELS[agent] ?? agent}`} onClick={() => handOff("voice")}>
                  <Icon name="wave" />
                </button>
              )}
              <button type="submit" className="rd-home-send" aria-label={`Send to ${BOT_LABELS[agent] ?? agent}`} disabled={!text.trim()}>
                <Icon name="arrow-up" />
              </button>
            </div>
          </div>
        </form>
        <div className="rd-starters">
          {STARTERS.map((st) => (
            <button
              key={st.label}
              type="button"
              onClick={() => {
                setText(st.prompt);
                area.current?.focus();
              }}
            >
              <Icon name={st.icon} />
              {st.label}
            </button>
          ))}
        </div>
        {lead && (
          <button type="button" className="rd-continue" onClick={() => openChat(lead)}>
            <AgentAvatar bot={lead} size="sm" />
            <span>
              Continue with {BOT_LABELS[lead] ?? lead}
              <small>Your ongoing conversation, always in one place.</small>
            </span>
            <Icon name="arrow-right" />
          </button>
        )}
      </section>

      {admin && (
        <section className="rd-overview" aria-label="Attention and work in motion">
          <div className="rd-section-head">
            <h2>
              <span className="rd-marker" />A little attention. A lot in motion.
            </h2>
            <button type="button" onClick={() => goPage("work")}>
              See all work <Icon name="arrow-right" />
            </button>
          </div>
          <div className="rd-overview-grid">
            <article className="rd-card rd-one">
              <div className="rd-card-top">
                <span className="rd-eyebrow rd-accent">• ONE FOR YOU</span>
                {one && <span className="rd-card-tag">{one.tag}</span>}
              </div>
              {one ? (
                <>
                  <h3>{one.title}</h3>
                  <p>{one.body}</p>
                  <div className="rd-card-foot">
                    <span className="rd-card-who">
                      <AgentAvatar bot="michael" size="sm" /> {BOT_LABELS[lead ?? "michael"]} has the details
                    </span>
                    <button type="button" className="rd-link-action" onClick={one.go}>
                      {one.action} <Icon name="arrow-right" />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h3>Nothing is waiting on you.</h3>
                  <p>When something needs your okay, it shows here first.</p>
                </>
              )}
            </article>
            <article className="rd-card rd-moving">
              <div className="rd-card-top">
                <h3>Moving for you</h3>
                <span className="rd-eyebrow">• LIVE</span>
              </div>
              {moving.length ? (
                <ul>
                  {moving.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => actions.openBuilds(c.id)}>
                        <AgentAvatar bot={c.from && c.from !== "foreman" ? c.from : "michael"} size="sm" />
                        <span>
                          {c.title}
                          <small>
                            {BOT_LABELS[c.from ?? ""] ?? "Your team"} · {c.now?.text ?? (c.kicker === "built" ? "Built, ready for a look" : c.kicker)}
                          </small>
                        </span>
                        {c.kicker === "built" ? (
                          <span className="rd-moving-state done" title="Ready for a look">
                            <Icon name="check" />
                          </span>
                        ) : c.now ? (
                          <span className="rd-moving-state working" title="Working" aria-label="Working" />
                        ) : (
                          <Icon name="chevron-right" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rd-quiet">{builds ? "Nothing is moving right now." : "Loading your work…"}</p>
              )}
              <button type="button" className="rd-card-foot rd-team-foot" onClick={() => goPage("work")}>
                <span className="rd-team-stack" aria-hidden="true">
                  {bots.slice(0, 3).map((bot) => (
                    <AgentAvatar key={bot} bot={bot} size="xs" />
                  ))}
                </span>
                <span>One team. On the same page.</span>
                <Icon name="arrow-right" />
              </button>
            </article>
          </div>
        </section>
      )}
      {admin && (
        <footer className="rd-home-foot">
          {/* FINAL workspace-footer: what this workspace is connected to, and a quiet privacy line. */}
          <button type="button" className="rd-home-connected" onClick={() => goPage("connections")} aria-label="Connected to your world · open Connections">
            <span className="rd-home-connected-icons" aria-hidden="true">
              <i><Icon name="gmail" /></i>
              <i><Icon name="search" /></i>
              <i><Icon name="folder" /></i>
            </span>
            <span>
              Connected to your world<span className="rd-home-foot-arrow"> ↗</span>
            </span>
          </button>
          <span className="rd-home-privacy">
            <Icon name="shield" />
            Private. Yours. Always.
          </span>
        </footer>
      )}
    </div>
  );
}
