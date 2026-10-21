import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getZilvoAppUrl, APP, appUrl } from '../../config';

interface Props {
  onLoggedIn: (token: string, name: string, email: string) => void;
}

// The brand mark ships in icons/ and is copied to dist as-is, so resolve it
// against the extension root rather than through the bundler.
const LOGO_SRC =
  typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('icons/zilvo-logo.png')
    : 'icons/zilvo-logo.png';

export default function AuthLogin({ onLoggedIn }: Props) {
  const [waiting, setWaiting] = useState(false);
  const [error,   setError]   = useState('');

  // Kept in a ref: App re-creates this callback on every render, and a
  // re-subscribing effect would leave a gap where a token push is missed.
  const onLoggedInRef = useRef(onLoggedIn);
  onLoggedInRef.current = onLoggedIn;

  // /login is a web page — it lives on the app host, NOT the API host. Login
  // happens there; the zilvoSync content script bridges the resulting token
  // back to the extension, exactly as it does for a login in an app tab.
  const openSignIn = useCallback(async () => {
    setError('');
    try {
      const url = appUrl(APP.login, await getZilvoAppUrl());
      chrome.tabs.create({ url }, () => {
        if (chrome.runtime.lastError) {
          setError('Could not open the Zilvo sign-in page. Try again.');
          return;
        }
        setWaiting(true);
      });
    } catch {
      setError('Could not open the Zilvo sign-in page. Try again.');
    }
  }, []);

  // The background broadcasts authStateChanged once the tab bridge adopts the
  // new token, so the button can acknowledge the sign-in without polling.
  useEffect(() => {
    if (!waiting) return;
    const handler = (msg: { action?: string; loggedIn?: boolean; token?: string; name?: string; email?: string }) => {
      if (msg?.action !== 'authStateChanged' || !msg.loggedIn || !msg.token) return;
      setWaiting(false);
      onLoggedInRef.current(msg.token, msg.name || msg.email || '', msg.email || '');
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [waiting]);

  return (
    <div className="auth-shell">

      {/* Gradient accent — the one splash of brand colour above the card */}
      <div className="auth-accent" aria-hidden="true" />

      <div className="auth-card">

        {/* ── Brand header ── */}
        <header className="auth-brand">
          <span className="auth-brand-logo">
            <img src={LOGO_SRC} alt="" />
          </span>
          <div className="auth-brand-text">
            <span className="auth-brand-name">Zilvo Analyze</span>
            <span className="auth-brand-sub">Company intelligence extension</span>
          </div>
        </header>

        {/* ── Sign-in panel ── */}
        <main className="auth-hero">
          <span className="auth-hero-icon">
            <img src={LOGO_SRC} alt="" />
          </span>

          <h1 className="auth-hero-title">Sign in to Zilvo</h1>
          <p className="auth-hero-sub">Connect the extension to your company workspace.</p>

          <button
            type="button"
            className="auth-cta"
            onClick={openSignIn}
            disabled={waiting}
            aria-busy={waiting}
          >
            {waiting ? (
              <>
                <span className="auth-cta-spinner" aria-hidden="true" />
                Waiting for sign-in…
              </>
            ) : (
              <>
                Sign in
                <svg className="auth-cta-arrow" width="17" height="17" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h13" />
                  <path d="M12 5l7 7-7 7" />
                </svg>
              </>
            )}
          </button>

          {error && <p className="auth-error" role="alert">{error}</p>}

          {waiting && (
            <p className="auth-note" role="status">
              Finish signing in on the Zilvo tab that just opened.
              <br />
              Didn&apos;t open?{' '}
              <button type="button" className="auth-note-link" onClick={openSignIn}>Try again</button>
            </p>
          )}
        </main>

        {/* ── Footer ── */}
        <footer className="auth-footer">
          Zilvo Analyze<span className="auth-footer-sep">·</span>Chrome extension
        </footer>

      </div>
    </div>
  );
}
