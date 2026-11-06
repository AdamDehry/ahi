/**
 * Your team (slice 9, FINAL compact directory) and the Settings section nav.
 * Cards are the agents this user may message, with role and a one-line purpose
 * (FINAL: no model line here — Settings → Agents shows model and voice). Message opens that
 * agent; Ask Michael to coordinate and Add a specialist only prepare a draft
 * in Michael's chat — adding a specialist never creates access by itself.
 */
import { actions, availableBots, useAppState } from "../store";
import { BOT_LABELS, BOT_SUBTITLES } from "../lib/types";
import { Icon } from "./icons";
import { AgentAvatar } from "./AgentRail";
import { PageHeader } from "./pages";
import { railOrder } from "./agents";
import { SETTINGS_SECTIONS, setSettingsSection, useSettingsSection } from "./SettingsPage";

export const PURPOSE: Record<string, string> = {
  michael: "Your first point of contact. Plans, delegates, and brings the important decisions back to you.",
  zali: "Builds your software and keeps it running.",
  avi: "Turns ideas into thoughtful design.",
  miriam: "Makes room in your calendar and personal life.",
};

function draftToMichael(text: string) {
  actions.setDraft("michael", text);
  actions.setView("messages");
  actions.openMobileThread("michael");
}

export function TeamPage() {
  const { user } = useAppState();
  const bots = railOrder(availableBots(user));
  const hasMichael = bots.includes("michael");
  return (
    <div className="rd-page rd-page-scroll rd-team" data-page="team">
      <div className="rd-page-top">
        <PageHeader
          page="team"
          actionsSlot={
            hasMichael ? (
              <button type="button" className="rd-btn" onClick={() => draftToMichael("Please coordinate the team on this: ")}>
                Ask Michael to coordinate <Icon name="arrow-right" />
              </button>
            ) : undefined
          }
        />
      </div>
      <div className="rd-team-grid">
        {bots.map((b) => (
          <button key={b} type="button" className={`rd-team-card${b === "michael" ? " lead" : ""}`} onClick={() => (actions.setView("messages"), actions.openMobileThread(b))} aria-label={`Message ${BOT_LABELS[b] ?? b}`}>
            <AgentAvatar bot={b} size="sm" />
            <span className="rd-team-text">
              <span className="rd-team-name">{BOT_LABELS[b] ?? b}</span>
              <span className="rd-team-role">{BOT_SUBTITLES[b] ?? ""}</span>
              <span className="rd-team-purpose">{PURPOSE[b] ?? ""}</span>
            </span>
            <Icon name="arrow-right" />
          </button>
        ))}
      </div>
      {hasMichael && (
        <div className="rd-team-more">
          <div>
            <h3>Room for another specialist.</h3>
            <p className="rd-quiet">Work out the role and what good work looks like with Michael.</p>
          </div>
          <button type="button" className="rd-btn" onClick={() => draftToMichael("I’d like to add a specialist to the team. Role: ")}>
            <Icon name="plus" /> Add a specialist
          </button>
        </div>
      )}
    </div>
  );
}

/** FINAL Settings section list: picks the section shown (SettingsPage). */
export function SettingsNav() {
  const { user } = useAppState();
  const active = useSettingsSection();
  return (
    <nav className="rd-settings-nav" aria-label="Settings sections">
      {SETTINGS_SECTIONS.filter((x) => !x.owner || user?.admin).map((x) => (
        <button key={x.id} type="button" className={active === x.id ? "on" : ""} aria-current={active === x.id ? "page" : undefined} onClick={() => setSettingsSection(x.id)}>
          <Icon name={x.icon} /> {x.label}
        </button>
      ))}
      <small className="rd-settings-ws">Personal workspace</small>
    </nav>
  );
}
