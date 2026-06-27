import React, { useState, useEffect } from 'react';
import Settings from './components/Settings';
import AuthLogin from './components/AuthLogin';
import LinkedInDetect from './components/LinkedInDetect';
import WebsiteDetect from './components/WebsiteDetect';
import BulkAnalyze from './components/BulkAnalyze';

type ActiveTab = 'linkedin' | 'website' | 'manual';

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab,  setActiveTab]  = useState<ActiveTab>('linkedin');
  const [zilvoToken, setZilvoToken] = useState('');
  const [zilvoName,  setZilvoName]  = useState('');

  useEffect(() => {
    chrome.storage.local.get({ zilvoToken: '', zilvoName: '' }, items => {
      setZilvoToken(items.zilvoToken as string);
      setZilvoName(items.zilvoName as string);
    });
  }, []);

  const handleLogout = () => {
    chrome.storage.local.set({ zilvoToken: '', zilvoName: '', zilvoEmail: '' }, () => {
      setZilvoToken('');
      setZilvoName('');
    });
  };

  if (showSettings) {
    return <Settings onBack={() => setShowSettings(false)} />;
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

  const ciContent = zilvoToken
    ? null
    : <AuthLogin onLoggedIn={(token, name, email) => {
        setZilvoToken(token);
        setZilvoName(name || email);
      }} />;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="app-logo">Z</span>
          <span>Zilvo Analyze</span>
        </div>
        <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
      </header>

      {/* Tab switcher */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 10px' }}>
        <button style={tabStyle('linkedin')} onClick={() => setActiveTab('linkedin')}>LI Company</button>
        <button style={tabStyle('website')}  onClick={() => setActiveTab('website')}>Website</button>
        <button style={tabStyle('manual')}   onClick={() => setActiveTab('manual')}>Manual</button>
      </div>

      <main className="app-main">
        {/* ── Tab 1: LinkedIn Company Auto Detect ── */}
        {activeTab === 'linkedin' && (
          zilvoToken
            ? <LinkedInDetect onLogout={handleLogout} userName={zilvoName || 'User'} />
            : ciContent
        )}

        {/* ── Tab 2: Website Auto Detect ── */}
        {activeTab === 'website' && (
          zilvoToken
            ? <WebsiteDetect onLogout={handleLogout} userName={zilvoName || 'User'} />
            : ciContent
        )}

        {/* ── Tab 3: Manual Bulk Analysis ── */}
        {activeTab === 'manual' && (
          zilvoToken
            ? <BulkAnalyze onLogout={handleLogout} userName={zilvoName || 'User'} />
            : ciContent
        )}
      </main>
    </div>
  );
}
