import { useRef, useState } from "react";
import { login } from "../lib/api";
import { actions } from "../store";
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
      setError("You’re offline. Reconnect before signing in. Your token has not been sent.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const user = await login(value);
      if (user) return actions.loggedIn(user);
      setError("That token wasn’t recognized. Check it and try again.");
    } catch {
      setError("AHI can’t be reached right now. Your token is kept; try again in a moment.");
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
            <button type="button" className="setup-wordmark" onClick={go("signin")} aria-label="Back to sign in">
              ahi<i>.</i>
            </button>
          ) : (
            <span />
          )}
        </header>
        <main className="setup-signin">
          {view === "recovery" ? (
            <section className="setup-signin-inner">
              <p className="setup-kicker">BACK TO YOUR SPACE</p>
              <h1>Need your token?</h1>
              <p className="setup-intro">Check the AHI entry in your password manager or the recovery copy you saved.</p>
              <div className="setup-card">
                <h3>Still signed in on another device?</h3>
                <p className="setup-footnote">Open AHI there. The workspace owner can give this device its own access.</p>
                <h3 className="setup-card-gap">No trusted device or recovery copy?</h3>
                <p className="setup-footnote">Ask your workspace owner for a new token. AHI never sends tokens by email or message.</p>
              </div>
              <div className="setup-button-row setup-center">
                <button type="button" className="setup-button" onClick={go("signin")}>← Back to sign in</button>
              </div>
            </section>
          ) : (
            <div className="setup-signin-inner">
              <p className="setup-wordmark">ahi<i>.</i></p>
              <p className="setup-brand-description">ARTIFICIAL HARMONIOUS INTELLIGENCE</p>
              <h1>Welcome home.</h1>
              <p className="setup-intro">Your work. Your life. Your team.</p>
              <nav className="setup-entry-switch" aria-label="Account access">
                <button type="button" aria-current={view === "signin" ? "page" : undefined} onClick={go("signin")}>Sign in</button>
                <button type="button" aria-current={view === "create" ? "page" : undefined} onClick={go("create")}>Create account</button>
              </nav>
              {view === "signin" ? (
                <>
                  <form className="setup-form" onSubmit={submit}>
                    <label>
                      Your access token
                      <input
                        ref={field}
                        type="password"
                        name="token"
                        className="setup-input"
                        autoComplete="off"
                        required
                        placeholder="Enter your AHI token"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                      />
                    </label>
                    <button className="setup-button primary" type="submit" disabled={busy}>
                      {busy ? "Signing in…" : "Enter your workspace →"}
                    </button>
                    <p className="setup-error" role="alert">{error}</p>
                  </form>
                  <div className="setup-button-row setup-end">
                    <button type="button" className="setup-button" onClick={go("recovery")}>Lost your token?</button>
                  </div>
                </>
              ) : (
                <div className="setup-return">
                  <h3>A new workspace starts with AHI Setup.</h3>
                  <p>Download AHI Setup and open it on the computer that will host your workspace. It makes your home, connects a model and gives you your token.</p>
                  {SETUP_DOWNLOAD_URL ? (
                    <a className="setup-button primary setup-download" href={SETUP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">Download AHI Setup ↗</a>
                  ) : (
                    <p>Download AHI Setup from the project’s Releases page on GitHub.</p>
                  )}
                  <p>Joining someone’s workspace? Ask its owner for your token, then sign in.</p>
                  <button type="button" className="setup-button" onClick={go("signin")}>I have a token →</button>
                </div>
              )}
            </div>
          )}
        </main>
        <footer className="setup-footer">
          <span>One place for everything.</span>
          <span>AHI · Artificial Harmonious Intelligence</span>
        </footer>
      </div>
    </div>
  );
}
