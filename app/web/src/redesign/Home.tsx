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
import { useT, type Key } from "../i18n";

/** The time of day, as the pair of keys for the greeting alone and with a first name. (The en-US hour is parsed back, never shown.) */
function greeting(zone: string | undefined): { plain: Key; named: Key } {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: zone || undefined }).format(new Date()));
  return h < 12
    ? { plain: "home.morning", named: "home.morningName" }
    : h < 17
      ? { plain: "home.afternoon", named: "home.afternoonName" }
      : { plain: "home.evening", named: "home.eveningName" };
}

const STARTERS: Array<{ icon: "sun" | "spark" | "pulse"; label: Key; prompt: Key }> = [
  { icon: "sun", label: "home.starter.plan", prompt: "home.starter.planPrompt" },
  { icon: "spark", label: "home.starter.start", prompt: "home.starter.startPrompt" },
  { icon: "pulse", label: "home.starter.catchUp", prompt: "home.starter.catchUpPrompt" },
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
  const t = useT();
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
          <h1 className="rd-home-title">{t("home.welcome")}</h1>
          <p className="rd-sub">{t("home.noAgents")}</p>
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
    if (r) return { title: r.title, body: r.cost_risk || t("home.readyForOkay"), tag: r.desk, go: () => actions.openReview(r.id), action: t("home.letsReview") };
    const q = builds?.sections.needs_you[0];
    if (q) return { title: q.title, body: q.ask ?? q.now?.text ?? t("home.oneDecision"), tag: t("shell.nav.work"), go: () => actions.openBuilds(q.id), action: t("home.openIt") };
    return null;
  })();
  const moving: Card[] = builds ? [...builds.sections.moving, ...builds.sections.ready].slice(0, 3) : [];

  return (
    <div className="rd-page rd-page-scroll rd-home" data-page="home">
      <section className="rd-home-hero">
        <div className="rd-eyebrow">{s.user?.name ? t(greeting(undefined).named, { name: s.user.name.split(" ")[0].toUpperCase() }) : t(greeting(undefined).plain)}</div>
        <h1 className="rd-home-title">{t("shell.page.home.title")}</h1>
        <p className="rd-sub">{t("shell.page.home.sub")}</p>
        <form
          className="rd-home-composer"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label htmlFor="rd-home-request" className="sr-only">{t("home.askAnythingLabel", { name: BOT_LABELS[agent] ?? agent })}</label>
          <textarea
            id="rd-home-request"
            ref={area}
            rows={2}
            value={text}
            dir="auto"
            placeholder={t("home.composerPlaceholder")}
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
                <ul className="rd-picker-menu" role="listbox" aria-label={t("home.whoToAsk")}>
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
              <button type="button" className="rd-chat-control" aria-label={t("home.attachFile")} onClick={() => handOff("attach")}>
                <Icon name="plus" />
              </button>
              {s.voiceBots.includes(agent) && (
                <button type="button" className="rd-chat-control" aria-label={t("home.talkTo", { name: BOT_LABELS[agent] ?? agent })} onClick={() => handOff("voice")}>
                  <Icon name="wave" />
                </button>
              )}
              <button type="submit" className="rd-home-send" aria-label={t("home.sendTo", { name: BOT_LABELS[agent] ?? agent })} disabled={!text.trim()}>
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
                setText(t(st.prompt));
                area.current?.focus();
              }}
            >
              <Icon name={st.icon} />
              {t(st.label)}
            </button>
          ))}
        </div>
        {lead && (
          <button type="button" className="rd-continue" onClick={() => openChat(lead)}>
            <AgentAvatar bot={lead} size="sm" />
            <span>
              {t("home.continueWith", { name: BOT_LABELS[lead] ?? lead })}
              <small>{t("home.continueSub")}</small>
            </span>
            <Icon name="arrow-right" />
          </button>
        )}
      </section>

      {admin && (
        <section className="rd-overview" aria-label={t("home.overviewLabel")}>
          <div className="rd-section-head">
            <h2>
              <span className="rd-marker" />{t("home.overviewTitle")}
            </h2>
            <button type="button" onClick={() => goPage("work")}>
              {t("home.seeAllWork")} <Icon name="arrow-right" />
            </button>
          </div>
          <div className="rd-overview-grid">
            <article className="rd-card rd-one">
              <div className="rd-card-top">
                <span className="rd-eyebrow rd-accent">{t("home.oneForYou")}</span>
                {one && <span className="rd-card-tag" dir="auto">{one.tag}</span>}
              </div>
              {one ? (
                <>
                  <h3 dir="auto">{one.title}</h3>
                  <p dir="auto">{one.body}</p>
                  <div className="rd-card-foot">
                    <span className="rd-card-who">
                      <AgentAvatar bot="michael" size="sm" /> {t("home.hasDetails", { name: BOT_LABELS[lead ?? "michael"] })}
                    </span>
                    <button type="button" className="rd-link-action" onClick={one.go}>
                      {one.action} <Icon name="arrow-right" />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h3>{t("home.nothingWaiting")}</h3>
                  <p>{t("home.nothingWaitingSub")}</p>
                </>
              )}
            </article>
            <article className="rd-card rd-moving">
              <div className="rd-card-top">
                <h3>{t("home.movingForYou")}</h3>
                <span className="rd-eyebrow">{t("home.live")}</span>
              </div>
              {moving.length ? (
                <ul>
                  {moving.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => actions.openBuilds(c.id)}>
                        <AgentAvatar bot={c.from && c.from !== "foreman" ? c.from : "michael"} size="sm" />
                        <span>
                          <bdi dir="auto">{c.title}</bdi>
                          <small dir="auto">
                            {BOT_LABELS[c.from ?? ""] ?? t("shell.nav.team")} · {c.now?.text ?? (c.kicker === "built" ? t("home.builtReady") : c.kicker)}
                          </small>
                        </span>
                        {c.kicker === "built" ? (
                          <span className="rd-moving-state done" title={t("home.readyForLook")}>
                            <Icon name="check" />
                          </span>
                        ) : c.now ? (
                          <span className="rd-moving-state working" title={t("home.working")} aria-label={t("home.working")} />
                        ) : (
                          <Icon name="chevron-right" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rd-quiet">{builds ? t("home.nothingMoving") : t("home.loadingWork")}</p>
              )}
              <button type="button" className="rd-card-foot rd-team-foot" onClick={() => goPage("work")}>
                <span className="rd-team-stack" aria-hidden="true">
                  {bots.slice(0, 3).map((bot) => (
                    <AgentAvatar key={bot} bot={bot} size="xs" />
                  ))}
                </span>
                <span>{t("home.oneTeam")}</span>
                <Icon name="arrow-right" />
              </button>
            </article>
          </div>
        </section>
      )}
      {admin && (
        <footer className="rd-home-foot">
          {/* FINAL workspace-footer: what this workspace is connected to, and a quiet privacy line. */}
          <button type="button" className="rd-home-connected" onClick={() => goPage("connections")} aria-label={t("home.connectedLabel")}>
            <span className="rd-home-connected-icons" aria-hidden="true">
              <i><Icon name="gmail" /></i>
              <i><Icon name="search" /></i>
              <i><Icon name="folder" /></i>
            </span>
            <span>
              {t("home.connected")}<span className="rd-home-foot-arrow">{t("home.footArrow")}</span>
            </span>
          </button>
          <span className="rd-home-privacy">
            <Icon name="shield" />
            {t("home.privacy")}
          </span>
        </footer>
      )}
    </div>
  );
}
