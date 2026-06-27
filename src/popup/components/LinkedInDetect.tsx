import React, { useState, useEffect, useCallback } from 'react';
import { extractLinkedInCompanyData } from '../../content/linkedin';
import type { CIBackgroundMessage, LinkedInCompanyData } from '../../types';

interface Props {
  onLogout: () => void;
  userName: string;
}

type State =
  | { status: 'checking' }
  | { status: 'not_linkedin' }
  | { status: 'extracting' }
  | { status: 'ready'; liData: LinkedInCompanyData }
  | { status: 'loading'; step: string; message: string }
  | { status: 'success'; baseUrl: string }
  | { status: 'error'; error: string };

export default function LinkedInDetect({ onLogout, userName }: Props) {
  const [state,   setState]   = useState<State>({ status: 'checking' });
  const [baseUrl, setBaseUrl] = useState('https://app.zilvo.co');

  useEffect(() => {
    chrome.storage.local.get({ zilvoBaseUrl: 'https://app.zilvo.co' }, items => {
      setBaseUrl(items.zilvoBaseUrl as string);
    });

    chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
      const tab = tabs[0];
      const url = tab?.url || '';
      const onLinkedIn = /linkedin\.com\/company\//i.test(url);

      if (!onLinkedIn) {
        setState({ status: 'not_linkedin' });
        return;
      }

      if (tab?.id) {
        setState({ status: 'extracting' });
        try {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: extractLinkedInCompanyData,
          });
          setState({ status: 'ready', liData: result.result as LinkedInCompanyData });
        } catch {
          setState({ status: 'not_linkedin' });
        }
      }
    });
  }, []);

  useEffect(() => {
    const listener = (message: CIBackgroundMessage) => {
      if (message.type === 'CI_PROGRESS') {
        setState({ status: 'loading', step: message.step, message: message.message });
      } else if (message.type === 'CI_COMPLETE') {
        setState({ status: 'success', baseUrl });
      } else if (message.type === 'CI_ERROR') {
        setState({ status: 'error', error: message.error });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [baseUrl]);

  const handleAnalyze = useCallback((liData: LinkedInCompanyData) => {
    setState({ status: 'loading', step: 'analyzing', message: 'Analyzing company…' });
    chrome.runtime.sendMessage({
      type:                  'ANALYZE_FOR_CI',
      linkedinUrl:           liData.linkedinUrl,
      websiteUrl:            liData.websiteUrl      || undefined,
      companyName:           liData.companyName     || undefined,
      linkedinIndustry:      liData.industry        || undefined,
      linkedinEmployeeCount: liData.employeeCount   || undefined,
      linkedinFollowerCount: liData.followerCount   || undefined,
    });
  }, []);

  const authStrip = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 10px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>
        Signed in as <strong style={{ color: 'var(--text)' }}>{userName}</strong>
      </span>
      <button onClick={onLogout} style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        Log out
      </button>
    </div>
  );

  if (state.status === 'checking' || state.status === 'extracting') {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p className="loading-message">Detecting LinkedIn company…</p>
      </div>
    );
  }

  if (state.status === 'not_linkedin') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {authStrip}
        <div style={{ textAlign: 'center', padding: '24px 16px' }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>🔗</div>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
            No LinkedIn company page detected
          </p>
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            Navigate to a LinkedIn company page<br />
            <span style={{ color: 'var(--primary)' }}>linkedin.com/company/…</span><br />
            to auto-detect company data.
          </p>
        </div>
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p className="loading-message">{state.message}</p>
      </div>
    );
  }

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
          <button className="btn btn--secondary" onClick={() => setState({ status: 'checking' })}>
            Analyze Another
          </button>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {authStrip}
        <div className="error-state" style={{ marginTop: 0 }}>
          <div className="error-icon">!</div>
          <p className="error-message">{state.error}</p>
          <div className="error-actions">
            <button className="btn btn--secondary" onClick={() => setState({ status: 'not_linkedin' })}>
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ready — company card
  const { liData } = state;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {authStrip}

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
          onClick={() => handleAnalyze(liData)}
        >
          Analyze Company · 5 credits
        </button>
      </div>
    </div>
  );
}
