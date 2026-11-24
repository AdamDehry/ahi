/**
 * Settings → Language. The choice applies at once (no reload), is saved on the server for this user,
 * and from then on the agents answer in it and the desktop app follows it. A save that fails puts the
 * old language back and says so.
 */
import { useEffect, useState } from "react";
import { LANGS, LANG_NAMES, getLang, isRtl, setLang, useLang, useT, type Lang } from "../i18n";
import { fetchPrefs, saveLanguage, type HebrewVoice } from "../lib/prefs";
import { Icon } from "./icons";

export default function LanguageSettings({ onSaved }: { onSaved: (text?: string) => void }) {
  const t = useT();
  const lang = useLang();
  const [voice, setVoice] = useState<HebrewVoice | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void fetchPrefs().then((p) => live && p && setVoice(p.hebrewVoice));
    return () => {
      live = false;
    };
  }, []);

  async function choose(next: Lang) {
    const before = getLang();
    if (next === before) return;
    setError("");
    setLang(next);
    if (await saveLanguage(next)) onSaved(t("common.saved"));
    else {
      setLang(before);
      setError(t("lang.saveFailed"));
    }
  }

  return (
    <>
      <div className="rs-card" role="radiogroup" aria-label={t("lang.pickerLabel")}>
        {LANGS.map((l) => (
          <button key={l} type="button" role="radio" aria-checked={lang === l} className="rs-row rs-lang" onClick={() => void choose(l)}>
            <div>
              <strong lang={l} dir={isRtl(l) ? "rtl" : "ltr"}>{LANG_NAMES[l]}</strong>
              <p>{t(isRtl(l) ? "lang.rtlNote" : "lang.ltrNote")}</p>
            </div>
            {lang === l && <Icon name="check" />}
          </button>
        ))}
      </div>
      {error && (
        <p className="rs-note rs-error" role="alert">
          {error}
        </p>
      )}
      <div className="rs-card">
        <div className="rs-row">
          <div>
            <strong>{t("lang.agentsTitle")}</strong>
            <p>{t("lang.agentsBody")}</p>
          </div>
        </div>
        {lang === "he" && voice && (
          <div className="rs-row">
            <div>
              <strong>{t("lang.voiceTitle")}</strong>
              <p>{t(`lang.voice.${voice}` as const)}</p>
            </div>
          </div>
        )}
      </div>
      <p className="rs-note">{t("lang.anyMessage")}</p>
    </>
  );
}
