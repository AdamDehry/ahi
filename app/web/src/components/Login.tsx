import { useRef, useState } from "react";
import { login } from "../lib/api";
import { actions } from "../store";
import { LANGS, LANG_NAMES, setLang, useLang, useT } from "../i18n";
import "../redesign/signin.css";

/**
 * Sign-in, one for one with the FINAL concept's welcome screen (ONBOARDING-HANDOFF §1): the lowercase
 * ahi. wordmark, Sign in / Create account as a rounded segmented choice, one masked access-token field,
 * pending feedback, an inline message that keeps what was typed, and offline told apart from a wrong
 * token. No password or email account system; real sign-in stays the existing token check.
 */
type View = "signin" | "create" | "recovery";

/** The published installer: the repo's latest release, set at build time by the release workflow (VITE_AHI_SETUP_URL). */
const SETUP_DOWNLOAD_URL: string = import.meta.env.VITE_AHI_SETUP_URL || "";

export default function Login() {
  const t = useT();
  const lang = useLang();
  const [view, setView] = useState<View>("signin");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    if (!navigator.onLine) {
      setError(t("login.offline"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const user = await login(value);
      if (user) return actions.loggedIn(user);
      setError(t("login.notRecognized"));
    } catch {
      setError(t("login.unreachable"));
    }
    setBusy(false);
    field.current?.focus();
  }

  const go = (v: View) => () => (setError(""), setView(v));

  return (
    <div className="rd-signin">
      <div className="setup-frame">
        <header className="setup-masthead">
          {view === "recovery" ? (
            <button type="button" className="setup-wordmark" onClick={go("signin")} aria-label={t("login.backToSignIn")}>
              <bdi dir="ltr">ahi<i>.</i></bdi>
            </button>
          ) : (
            <span />
          )}
        </header>
        <main className="setup-signin">
          {view === "recovery" ? (
            <section className="setup-signin-inner">
              <p className="setup-kicker">{t("login.recoveryKicker")}</p>
              <h1>{t("login.recoveryTitle")}</h1>
              <p className="setup-intro">{t("login.recoveryIntro")}</p>
              <div className="setup-card">
                <h3>{t("login.otherDeviceTitle")}</h3>
                <p className="setup-footnote">{t("login.otherDeviceBody")}</p>
                <h3 className="setup-card-gap">{t("login.noDeviceTitle")}</h3>
                <p className="setup-footnote">{t("login.noDeviceBody")}</p>
              </div>
              <div className="setup-button-row setup-center">
                <button type="button" className="setup-button" onClick={go("signin")}>{t("login.backToSignInArrow")}</button>
              </div>
            </section>
          ) : (
            <div className="setup-signin-inner">
              <p className="setup-wordmark"><bdi dir="ltr">ahi<i>.</i></bdi></p>
              <p className="setup-brand-description">{t("login.brandDescription")}</p>
              <h1>{t("login.welcome")}</h1>
              <p className="setup-intro">{t("login.tagline")}</p>
              <nav className="setup-entry-switch" aria-label={t("login.accountAccess")}>
                <button type="button" aria-current={view === "signin" ? "page" : undefined} onClick={go("signin")}>{t("login.signIn")}</button>
                <button type="button" aria-current={view === "create" ? "page" : undefined} onClick={go("create")}>{t("login.createAccount")}</button>
              </nav>
              {view === "signin" ? (
                <>
                  <form className="setup-form" onSubmit={submit}>
                    <label>
                      {t("login.tokenLabel")}
                      <input
                        ref={field}
                        type="password"
                        name="token"
                        className="setup-input"
                        autoComplete="off"
                        required
                        placeholder={t("login.tokenPlaceholder")}
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                      />
                    </label>
                    <button className="setup-button primary" type="submit" disabled={busy}>
                      {busy ? t("login.signingIn") : t("login.enter")}
                    </button>
                    <p className="setup-error" role="alert">{error}</p>
                  </form>
                  <div className="setup-button-row setup-end">
                    <button type="button" className="setup-button" onClick={go("recovery")}>{t("login.lostToken")}</button>
                  </div>
                </>
              ) : (
                <div className="setup-return">
                  <h3>{t("login.newWorkspaceTitle")}</h3>
                  <p>{t("login.newWorkspaceBody")}</p>
                  {SETUP_DOWNLOAD_URL ? (
                    <a className="setup-button primary setup-download" href={SETUP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">{t("login.downloadSetup")}</a>
                  ) : (
                    <p>{t("login.downloadFromReleases")}</p>
                  )}
                  <p>{t("login.joining")}</p>
                  <button type="button" className="setup-button" onClick={go("signin")}>{t("login.haveToken")}</button>
                </div>
              )}
            </div>
          )}
        </main>
        <footer className="setup-footer">
          <span>{t("login.footer")}</span>
          <nav className="setup-lang" aria-label={t("login.language")}>
            {LANGS.map((l) => (
              <button key={l} type="button" lang={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
                {LANG_NAMES[l]}
              </button>
            ))}
          </nav>
          <span>{t("common.brand")}</span>
        </footer>
      </div>
    </div>
  );
}
