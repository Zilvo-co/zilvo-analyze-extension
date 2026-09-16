import React, { useState, useEffect, useCallback } from 'react';
import Settings from './components/Settings';
import AuthLogin from './components/AuthLogin';
import LinkedInDetect from './components/LinkedInDetect';
import WebsiteDetect from './components/WebsiteDetect';
import BulkAnalyze from './components/BulkAnalyze';
import { getCredits, getActionCost, getICPs, setDefaultICP, type ZilvoIcp } from '../utils/zilvoApi';
import { CI_ANALYZE_ACTION, CI_ANALYZE_FALLBACK_COST } from '../utils/credits';
import { getZilvoAppUrl, APP, appUrl } from '../config';

type ActiveTab = 'linkedin' | 'website' | 'manual';

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab,  setActiveTab]  = useState<ActiveTab>('linkedin');
  const [zilvoToken, setZilvoToken] = useState('');
  const [zilvoName,  setZilvoName]  = useState('');
  const [credits,    setCredits]    = useState<number | null>(null);
  const [creditCost, setCreditCost] = useState(CI_ANALYZE_FALLBACK_COST);
  const [icps, setIcps] = useState<ZilvoIcp[]>([]);
  const [icpId, setIcpId] = useState('');
  const [icpSaving, setIcpSaving] = useState(false);
  const [icpError, setIcpError] = useState('');
  // Empty list vs. not-loaded-yet: only the former should offer "+ Add ICP".
  const [icpsLoaded, setIcpsLoaded] = useState(false);

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

  // Load the user's ICPs so they can pick which positioning to score fit against.
  useEffect(() => {
    if (!zilvoToken) { setIcps([]); setIcpId(''); setIcpsLoaded(false); return; }
    let cancelled = false;
    getICPs(zilvoToken)
      .then((list) => {
        if (cancelled) return;
        setIcps(list);
        setIcpsLoaded(true);
        chrome.storage.local.get({ zilvoIcpId: '' }, (items) => {
          if (cancelled) return;
          // The account default wins over whatever this device last used: it is
          // the same isDefault the My ICP page writes, so a change made in the
          // web app shows up here on the next open instead of being shadowed by
          // a stale local pick.
          const stored = items.zilvoIcpId as string;
          const keep =
            list.find((i) => i.isDefault)?._id ||
            (stored && list.some((i) => i._id === stored) ? stored : '') ||
            list[0]?._id || '';
          setIcpId(keep);
          chrome.storage.local.set({ zilvoIcpId: keep });
        });
      })
      // Stay silent on failure rather than falling through to the empty state:
      // a network blip is not evidence the account has no ICPs.
      .catch(() => { if (!cancelled) { setIcps([]); setIcpsLoaded(false); } });
    return () => { cancelled = true; };
  }, [zilvoToken]);

  // Picking an ICP makes it the account default, exactly as the web app's My
  // ICP page does, so both surfaces always agree on the active positioning.
  const onIcpChange = (id: string) => {
    const prevId   = icpId;
    const prevIcps = icps;
    setIcpError('');
    setIcpId(id);
    // The background reads zilvoIcpId when it POSTs the analysis, so keep it in
    // step with the selection immediately — not only once the account default
    // has saved.
    chrome.storage.local.set({ zilvoIcpId: id });
    setIcps((list) => list.map((i) => ({ ...i, isDefault: i._id === id })));
    if (!zilvoToken) return;

    setIcpSaving(true);
    setDefaultICP(zilvoToken, id)
      .catch(() => {
        // Roll back rather than leave the popup showing a default the account
        // does not have. A silent divergence is invisible until an analysis is
        // scored against the wrong positioning.
        setIcpId(prevId);
        setIcps(prevIcps);
        chrome.storage.local.set({ zilvoIcpId: prevId });
        setIcpError('Could not set default — try again.');
      })
      .finally(() => setIcpSaving(false));
  };

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

      {/* ICPs are authored in the web app, so an account with none gets a link to
          My ICP instead of a select with nothing in it. */}
      {icpsLoaded && icps.length === 0 && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>No ICP yet — analyses skip fit scoring.</span>
          <button
            onClick={async () => chrome.tabs.create({ url: appUrl(APP.icp, await getZilvoAppUrl()) })}
            style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
            + Add ICP
          </button>
        </div>
      )}

      {icps.length > 0 && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label htmlFor="icp-select" style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>My ICP</label>
            {/* No "(default)" suffix: the selected ICP *is* the account default,
                so the marker would sit on every option in turn and read as noise. */}
            <select id="icp-select" value={icpId} disabled={icpSaving}
              onChange={(e) => onIcpChange(e.target.value)}
              title="Also becomes your default ICP across Zilvo"
              aria-describedby={icpError ? 'icp-error' : undefined}
              style={{ flex: 1, fontSize: 11, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg, #fff)', color: 'inherit', opacity: icpSaving ? 0.6 : 1 }}>
              {icps.map((i) => <option key={i._id} value={i._id}>{i.name}</option>)}
            </select>
          </div>
          {icpError && (
            <div id="icp-error" role="alert" style={{ fontSize: 10, color: 'var(--danger, #c0392b)', marginTop: 4 }}>{icpError}</div>
          )}
        </div>
      )}

      <main className="app-main">
        {activeTab === 'linkedin' && <LinkedInDetect onLogout={handleLogout} userName={zilvoName || 'User'} {...creditState} />}
        {activeTab === 'website'  && <WebsiteDetect  onLogout={handleLogout} userName={zilvoName || 'User'} {...creditState} />}
        {activeTab === 'manual'   && <BulkAnalyze    onLogout={handleLogout} userName={zilvoName || 'User'} {...creditState} />}
      </main>
    </div>
  );
}
