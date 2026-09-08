import React, { useState } from 'react';
import { login } from '../../utils/zilvoApi';
import { getZilvoAppUrl, APP, appUrl } from '../../config';

interface Props {
  onLoggedIn: (token: string, name: string, email: string) => void;
}

export default function AuthLogin({ onLoggedIn }: Props) {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPw,   setShowPw]   = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');

  // /login, /signup and /forgot-password are web pages — they live on the app
  // host, NOT the API host. Using the API base here opens a 404.
  const openTab = async (path: string) => {
    chrome.tabs.create({ url: appUrl(path, await getZilvoAppUrl()) });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { token, user } = await login(email, password);
      if (!token) {
        setError('Invalid credentials.');
        return;
      }

      const name = user?.name || email;
      // Route through the background so this token is reconciled against any
      // token already held by an open app tab — two independent writers of the
      // same storage key is exactly how two accounts end up in play at once.
      chrome.runtime.sendMessage(
        { action: 'websiteLogin', token, user: { ...user, name, email } },
        (res?: { ok?: boolean }) => {
          if (chrome.runtime.lastError || res?.ok) {
            onLoggedIn(token, name, email);
            return;
          }
          // Rejected as older than an existing session — adopt the winner
          // rather than holding a token nothing else will send.
          chrome.runtime.sendMessage({ action: 'getActiveToken' }, (r?: { token?: string | null }) => {
            onLoggedIn(r?.token || token, name, email);
          });
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setError(msg && msg !== 'Session expired' ? msg : 'Invalid credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-login">

      {/* ── Hero ── */}
      <div className="auth-hero">
        <div className="auth-hero-icon">
          <span>Z</span>
        </div>
        <h2 className="auth-hero-title">Sign in to Zilvo</h2>
        <p className="auth-hero-sub">Analyze companies from LinkedIn &amp; websites</p>
      </div>

      {/* ── Google ── */}
      <button type="button" className="auth-google-btn" onClick={() => openTab(APP.login)}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.658 14.082 17.64 11.775 17.64 9.2z"/>
          <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
          <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/>
          <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z"/>
        </svg>
        Continue with Google
      </button>

      {/* ── Divider ── */}
      <div className="auth-divider"><span>or</span></div>

      {/* ── Form ── */}
      <form onSubmit={handleLogin} className="auth-form">

        <div className="auth-field">
          <label className="form-label" htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            type="email"
            className="url-input"
            placeholder="you@company.com"
            value={email}
            onChange={e => { setEmail(e.target.value); setError(''); }}
            disabled={loading}
            autoFocus
            autoComplete="email"
          />
        </div>

        <div className="auth-field">
          <div className="auth-pw-label-row">
            <label className="form-label" htmlFor="auth-password">Password</label>
            <button type="button" className="auth-forgot" onClick={() => openTab(APP.forgotPassword)}>
              Forgot password?
            </button>
          </div>
          <div className="auth-pw-wrapper">
            <input
              id="auth-password"
              type={showPw ? 'text' : 'password'}
              className="url-input"
              placeholder="••••••••"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(''); }}
              disabled={loading}
              autoComplete="current-password"
            />
            <button
              type="button"
              className="auth-pw-toggle"
              onClick={() => setShowPw(v => !v)}
              title={showPw ? 'Hide password' : 'Show password'}
            >
              {showPw ? (
                <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              ) : (
                <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              )}
            </button>
          </div>
        </div>

        {error && <p className="input-error">{error}</p>}

        <button
          type="submit"
          className="btn btn--primary auth-submit"
          disabled={loading || !email || !password}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>

      </form>

      {/* ── Sign up ── */}
      <p className="auth-signup-row">
        Don&apos;t have an account?{' '}
        <button type="button" className="auth-link" onClick={() => openTab(APP.signup)}>
          Sign up free
        </button>
      </p>

    </div>
  );
}
