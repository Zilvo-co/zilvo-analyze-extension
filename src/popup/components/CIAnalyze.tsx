import React, { useState, useEffect, useCallback } from 'react';
import { extractLinkedInCompanyData } from '../../content/linkedin';
import type { CIBackgroundMessage, LinkedInCompanyData } from '../../types';

interface Props {
  onLogout: () => void;
  userName: string;
}

type CIState =
  | { status: 'idle' }
  | { status: 'extracting' }
  | { status: 'ready'; liData: LinkedInCompanyData }
  | { status: 'loading'; step: string; message: string }
  | { status: 'success'; jobId: string; baseUrl: string }
  | { status: 'error'; error: string };

export default function CIAnalyze({ onLogout, userName }: Props) {
  const [state,     setState]     = useState<CIState>({ status: 'idle' });
  const [pageUrl,   setPageUrl]   = useState('');
  const [isLinkedIn, setIsLinkedIn] = useState(false);
  const [manualUrl, setManualUrl] = useState('');
  const [baseUrl,   setBaseUrl]   = useState('https://app.zilvo.co');

  useEffect(() => {
    chrome.storage.local.get({ zilvoBaseUrl: 'https://app.zilvo.co' }, items => {
      setBaseUrl(items.zilvoBaseUrl as string);
    });

    chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
      const tab = tabs[0];
      const url = tab?.url || '';
      setPageUrl(url);
      const onLinkedIn = /linkedin\.com\/company\//i.test(url);
      setIsLinkedIn(onLinkedIn);

      // Auto-extract LinkedIn data from the current tab
      if (onLinkedIn && tab?.id) {
        setState({ status: 'extracting' });
        try {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: extractLinkedInCompanyData,
          });
          const liData = result.result as LinkedInCompanyData;
          setState({ status: 'ready', liData });
        } catch {
          setState({ status: 'idle' });
        }
      }
    });
  }, []);

  useEffect(() => {
    const listener = (message: CIBackgroundMessage) => {
      if (message.type === 'CI_PROGRESS') {
        setState({ status: 'loading', step: message.step, message: message.message });
      } else if (message.type === 'CI_COMPLETE') {
        setState({ status: 'success', jobId: message.jobId, baseUrl });
      } else if (message.type === 'CI_ERROR') {
        setState({ status: 'error', error: message.error });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [baseUrl]);

  const handleAnalyzeLinkedIn = useCallback((liData: LinkedInCompanyData) => {
    setState({ status: 'loading', step: 'analyzing', message: 'Analyzing company…' });
    chrome.runtime.sendMessage({
      type:        'ANALYZE_FOR_CI',
      linkedinUrl: liData.linkedinUrl,
      websiteUrl:  liData.websiteUrl || undefined,
      companyName: liData.companyName || undefined,
      // Pass pre-extracted LinkedIn metadata
      linkedinIndustry:     liData.industry       || undefined,
      linkedinEmployeeCount: liData.employeeCount || undefined,
      linkedinFollowerCount: liData.followerCount || undefined,
      userInputField:       liData.linkedinUrl,
    });
  }, []);

  const handleAnalyzeManual = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const fullUrl = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    const isLi    = /linkedin\.com\/company\//i.test(trimmed);

    setState({ status: 'loading', step: 'analyzing', message: 'Analyzing company…' });
    chrome.runtime.sendMessage({
      type:           'ANALYZE_FOR_CI',
      linkedinUrl:    isLi    ? trimmed  : undefined,
      websiteUrl:     !isLi   ? fullUrl  : undefined,
      userInputField: trimmed,
    });
  }, []);

  const handleReset = () => setState({ status: 'idle' });

  // ── Loading ────────────────────────────────────────────────────────────────

  if (state.status === 'extracting') {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p className="loading-message">Detecting LinkedIn company…</p>
      </div>
    );
  }

  if (state.status === 'loading') {
    const steps = ['opening_linkedin', 'extracting_linkedin', 'analyzing'];
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p className="loading-message">{state.message}</p>
        <div className="steps">
          {[
            { key: 'opening_linkedin',    label: 'Opening LinkedIn' },
            { key: 'extracting_linkedin', label: 'Extracting company URL' },
            { key: 'analyzing',           label: 'AI analysis' },
          ].map(s => {
            const curIdx = steps.indexOf(state.step);
            const myIdx  = steps.indexOf(s.key);
            const cls = myIdx < curIdx ? 'step step--done' : myIdx === curIdx ? 'step step--active' : 'step';
            return (
              <div key={s.key} className={cls}>
                <div className="step-dot" />
                <span className="step-label">{s.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Success ────────────────────────────────────────────────────────────────

  if (state.status === 'success') {
    return (
      <div className="error-state" style={{ gap: 10 }}>
        <div className="error-icon" style={{ background: 'rgba(5,150,105,0.12)', color: 'var(--success)', fontSize: 22 }}>✓</div>
        <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Analysis saved!</p>
        <p className="error-message" style={{ color: 'var(--muted)' }}>
          View the full company profile and fit score in your Zilvo dashboard.
        </p>
        <div className="error-actions">
          <button
            className="btn btn--primary"
            onClick={() => chrome.tabs.create({ url: `${state.baseUrl}/tools/company-intelligence/companies` })}
          >
            Open Dashboard
          </button>
          <button className="btn btn--secondary" onClick={handleReset}>Analyze Another</button>
        </div>
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────

  if (state.status === 'error') {
    return (
      <div className="error-state">
        <div className="error-icon">!</div>
        <p className="error-message">{state.error}</p>
        <div className="error-actions">
          <button className="btn btn--secondary" onClick={handleReset}>Try Again</button>
        </div>
      </div>
    );
  }

  // ── LinkedIn company detected ──────────────────────────────────────────────

  if (state.status === 'ready') {
    const { liData } = state;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Auth strip */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 10px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Signed in as <strong style={{ color: 'var(--text)' }}>{userName}</strong></span>
          <button onClick={onLogout} style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Log out</button>
        </div>

        {/* LinkedIn company card */}
        <div style={{ background: 'rgba(10,102,194,0.06)', border: '1.5px solid rgba(10,102,194,0.2)', borderRadius: 10, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <div style={{ width: 28, height: 28, background: 'var(--primary)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
              </svg>
            </div>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {liData.companyName || 'LinkedIn Company'}
              </p>
              {liData.industry && (
                <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>{liData.industry}</p>
              )}
            </div>
          </div>

          {/* Metadata pills */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
            {liData.employeeCount && (
              <span style={{ fontSize: 11, padding: '2px 8px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, color: 'var(--muted)' }}>
                👥 {liData.employeeCount}
              </span>
            )}
            {liData.followerCount && (
              <span style={{ fontSize: 11, padding: '2px 8px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, color: 'var(--muted)' }}>
                ✱ {liData.followerCount}
              </span>
            )}
            {liData.websiteUrl && (
              <span style={{ fontSize: 11, padding: '2px 8px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
                🌐 {liData.websiteUrl.replace(/^https?:\/\/(www\.)?/, '')}
              </span>
            )}
          </div>

          <button
            className="btn btn--primary"
            style={{ padding: '9px 16px', fontSize: 13 }}
            onClick={() => handleAnalyzeLinkedIn(liData)}
          >
            Analyze Company · 5 credits
          </button>
        </div>
      </div>
    );
  }

  // ── Idle (no LinkedIn page detected) ──────────────────────────────────────

  const isWebsite = pageUrl && !pageUrl.startsWith('chrome') && !pageUrl.startsWith('about') && !isLinkedIn;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Auth strip */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 10px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>Signed in as <strong style={{ color: 'var(--text)' }}>{userName}</strong></span>
        <button onClick={onLogout} style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Log out</button>
      </div>

      {/* Current website quick-analyze */}
      {isWebsite && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Current Page</p>
          <p style={{ fontSize: 12, color: 'var(--text)', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pageUrl.replace(/^https?:\/\/(www\.)?/, '')}
          </p>
          <button
            className="btn btn--primary"
            style={{ padding: '8px 16px', fontSize: 13 }}
            onClick={() => handleAnalyzeManual(pageUrl)}
          >
            🌐 Analyze Website · 5 credits
          </button>
        </div>
      )}

      {/* Manual input */}
      <div>
        <label className="form-label">Enter a URL to analyze</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            className="url-input"
            placeholder="https://example.com or linkedin.com/company/…"
            value={manualUrl}
            onChange={e => setManualUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && manualUrl.trim()) handleAnalyzeManual(manualUrl); }}
          />
          <button
            className="btn btn--secondary"
            style={{ width: 'auto', padding: '8px 12px', flexShrink: 0 }}
            disabled={!manualUrl.trim()}
            onClick={() => handleAnalyzeManual(manualUrl)}
          >
            Go
          </button>
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
          Navigate to a LinkedIn company page for auto-detection.
        </p>
      </div>
    </div>
  );
}
