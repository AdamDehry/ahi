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
import { useT, type Key } from "../i18n";

/** Catalog keys, translated where they are shown (Team cards, global search). */
export const PURPOSE: Record<string, Key> = {
  michael: "shell.team.purpose.michael",
  zali: "shell.team.purpose.zali",
  avi: "shell.team.purpose.avi",
  miriam: "shell.team.purpose.miriam",
};

function draftToMichael(text: string) {
  actions.setDraft("michael", text);
  actions.setView("messages");
  actions.openMobileThread("michael");
}

export function TeamPage() {
  const t = useT();
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
              <button type="button" className="rd-btn" onClick={() => draftToMichael(t("shell.team.coordinateDraft"))}>
                {t("shell.team.askCoordinate")} <Icon name="arrow-right" />
              </button>
            ) : undefined
          }
        />
      </div>
      <div className="rd-team-grid">
        {bots.map((b) => (
          <button key={b} type="button" className={`rd-team-card${b === "michael" ? " lead" : ""}`} onClick={() => (actions.setView("messages"), actions.openMobileThread(b))} aria-label={t("shell.messageAgent", { name: BOT_LABELS[b] ?? b })}>
            <AgentAvatar bot={b} size="sm" />
            <span className="rd-team-text">
              <span className="rd-team-name">{BOT_LABELS[b] ?? b}</span>
              <span className="rd-team-role">{BOT_SUBTITLES[b] ?? ""}</span>
              <span className="rd-team-purpose">{PURPOSE[b] ? t(PURPOSE[b]) : ""}</span>
            </span>
            <Icon name="arrow-right" />
          </button>
        ))}
      </div>
      {hasMichael && (
        <div className="rd-team-more">
          <div>
            <h3>{t("shell.team.roomTitle")}</h3>
            <p className="rd-quiet">{t("shell.team.roomSub")}</p>
          </div>
          <button type="button" className="rd-btn" onClick={() => draftToMichael(t("shell.team.specialistDraft"))}>
            <Icon name="plus" /> {t("shell.team.addSpecialist")}
          </button>
        </div>
      )}
    </div>
  );
}

/** FINAL Settings section list: picks the section shown (SettingsPage). */
export function SettingsNav() {
  const t = useT();
  const { user } = useAppState();
  const active = useSettingsSection();
  return (
    <nav className="rd-settings-nav" aria-label={t("shell.team.settingsSections")}>
      {SETTINGS_SECTIONS.filter((x) => !x.owner || user?.admin).map((x) => (
        <button key={x.id} type="button" className={active === x.id ? "on" : ""} aria-current={active === x.id ? "page" : undefined} onClick={() => setSettingsSection(x.id)}>
          <Icon name={x.icon} /> {t(x.label)}
        </button>
      ))}
      <small className="rd-settings-ws">{t("shell.personalWorkspace")}</small>
    </nav>
  );
}
