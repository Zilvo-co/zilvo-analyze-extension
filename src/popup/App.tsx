import React, { useState, useEffect, useCallback } from 'react';
import Settings from './components/Settings';
import AuthLogin from './components/AuthLogin';
import LinkedInDetect from './components/LinkedInDetect';
import WebsiteDetect from './components/WebsiteDetect';
import BulkAnalyze from './components/BulkAnalyze';
import { getCredits, getActionCost } from '../utils/zilvoApi';
import { CI_ANALYZE_ACTION, CI_ANALYZE_FALLBACK_COST } from '../utils/credits';

type ActiveTab = 'linkedin' | 'website' | 'manual';

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab,  setActiveTab]  = useState<ActiveTab>('linkedin');
  const [zilvoToken, setZilvoToken] = useState('');
  const [zilvoName,  setZilvoName]  = useState('');
  const [credits,    setCredits]    = useState<number | null>(null);
  const [creditCost, setCreditCost] = useState(CI_ANALYZE_FALLBACK_COST);

  // Resolve auth on open. The background's getActiveToken() is the single
  // resolver the analyze pipeline uses too, so the credits shown here always
  // belong to the account that will actually be charged.
  useEffect(() => {
    chrome.runtime.sendMessage({ action: 'getActiveToken' }, (res?: { token?: string | null }) => {
      if (chrome.runtime.lastError) return;
      const token = res?.token || '';
      setZilvoToken(token);
      if (!token) { setZilvoName(''); return; }
      chrome.storage.local.get({ zilvoName: '' }, items => setZilvoName(items.zilvoName as string));
    });
  }, []);

  // React to auth state changes pushed by the background service worker.
  // This fires when the user logs in or out on the zilvo.co website — the
  // zilvoSync content script detects it and background relays it here.
  useEffect(() => {
    type AuthMsg = { action: string; loggedIn?: boolean; token?: string; name?: string; email?: string };
    const handler = (msg: AuthMsg) => {
      if (msg.action !== 'authStateChanged') return;
      if (msg.loggedIn && msg.token) {
        setZilvoToken(msg.token);
        setZilvoName(msg.name || msg.email || '');
      } else {
        setZilvoToken('');
        setZilvoName('');
        setCredits(null);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // The balance every analyze tab gates on. Kept here rather than per-tab so a
  // spend on one tab is visible on the others, and so switching tabs does not
  // re-hit the API.
  const refreshCredits = useCallback(() => {
    if (!zilvoToken) { setCredits(null); return; }
    getCredits(zilvoToken)
      .then(balance => setCredits(balance))
      // Leave it unknown rather than 0 — canAfford() stays permissive on null,
      // so a blip on /api/credits cannot lock a funded user out of analyzing.
      .catch(() => setCredits(null));
  }, [zilvoToken]);

  useEffect(() => { refreshCredits(); }, [refreshCredits]);

  // Cost of one analysis, resolved once for the whole popup.
  useEffect(() => {
    getActionCost(CI_ANALYZE_ACTION, CI_ANALYZE_FALLBACK_COST)
      .then(cost => setCreditCost(cost || CI_ANALYZE_FALLBACK_COST))
      .catch(() => {});
  }, []);

  const handleLogout = () => {
    // Background calls the API logout and purges storage, every origin's
    // localStorage and all cookies — don't clear only the cached copy here.
    chrome.runtime.sendMessage({ action: 'extensionLogout', token: zilvoToken }).catch(() => {});
    setZilvoToken('');
    setZilvoName('');
    setCredits(null);
  };

  if (showSettings) {
    return <Settings onBack={() => setShowSettings(false)} />;
  }

  // ── Not logged in: full-screen sign-in gate ──
  if (!zilvoToken) {
    return (
      <div className="app">
        <header className="app-header">
          <div className="app-title">
            <span className="app-logo">Z</span>
            <span>Zilvo Analyze</span>
          </div>
          <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
        </header>
        <main className="app-main">
          <AuthLogin onLoggedIn={(token, name, email) => {
            setZilvoToken(token);
            setZilvoName(name || email);
          }} />
        </main>
      </div>
    );
  }

  const tabStyle = (tab: ActiveTab): React.CSSProperties => ({
    flex: 1,
    padding: '6px 0',
    border: 'none',
    background: 'none',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    borderBottom: activeTab === tab ? '2px solid var(--primary)' : '2px solid transparent',
    color: activeTab === tab ? 'var(--primary)' : 'var(--muted)',
    transition: 'color 0.12s, border-color 0.12s',
    whiteSpace: 'nowrap' as const,
  });

  const creditState = { credits, creditCost, refreshCredits };
  const lowBalance = credits !== null && credits < creditCost;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="app-logo">Z</span>
          <span>Zilvo Analyze</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {credits !== null && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: lowBalance ? 'var(--warning, #d97706)' : 'var(--muted)',
              }}
              title={lowBalance ? `An analysis costs ${creditCost} credits` : undefined}
            >
              {credits.toLocaleString()} credits
            </span>
          )}
          <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
        </div>
      </header>

      {/* Tab switcher */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 10px' }}>
        <button style={tabStyle('linkedin')} onClick={() => setActiveTab('linkedin')}>LI Company</button>
        <button style={tabStyle('website')}  onClick={() => setActiveTab('website')}>Website</button>
        <button style={tabStyle('manual')}   onClick={() => setActiveTab('manual')}>Bulk Upload</button>
      </div>

      <main className="app-main">
        {activeTab === 'linkedin' && <LinkedInDetect onLogout={handleLogout} userName={zilvoName || 'User'} {...creditState} />}
        {activeTab === 'website'  && <WebsiteDetect  onLogout={handleLogout} userName={zilvoName || 'User'} {...creditState} />}
        {activeTab === 'manual'   && <BulkAnalyze    onLogout={handleLogout} userName={zilvoName || 'User'} {...creditState} />}
      </main>
    </div>
  );
}
