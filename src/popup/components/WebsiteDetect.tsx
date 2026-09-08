import React, { useState, useEffect, useCallback } from 'react';
import { extractWebsiteContent } from '../../content/website';
import type { CIBackgroundMessage, ExtractedContent } from '../../types';

interface Props {
  onLogout: () => void;
  userName: string;
}

type State =
  | { status: 'idle' }
  | { status: 'loading'; step: string; message: string }
  | { status: 'success'; baseUrl: string }
  | { status: 'error'; error: string };

export default function WebsiteDetect({ onLogout, userName }: Props) {
  const [state,      setState]      = useState<State>({ status: 'idle' });
  const [pageUrl,    setPageUrl]    = useState('');
  const [tabId,      setTabId]      = useState<number | null>(null);
  const [manualUrl,  setManualUrl]  = useState('');
  const [baseUrl,    setBaseUrl]    = useState('https://app.zilvo.co');
  const [isValidPage, setIsValidPage] = useState(false);

  useEffect(() => {
    chrome.storage.local.get({ zilvoBaseUrl: 'https://app.zilvo.co' }, items => {
      setBaseUrl(items.zilvoBaseUrl as string);
    });
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      const url = tab?.url || '';
      setPageUrl(url);
      setTabId(tab?.id ?? null);
      setIsValidPage(url.startsWith('http') && !/linkedin\.com/i.test(url));
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

  const handleAnalyze = useCallback(async (url: string, fromCurrentTab = false) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const fullUrl = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    setState({ status: 'loading', step: 'analyzing', message: 'Analyzing website…' });

    let pageContent: string | undefined;
    if (fromCurrentTab && tabId) {
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractWebsiteContent,
        });
        const content = result.result as ExtractedContent;
        pageContent = [
          `Title: ${content.title}`,
          `Description: ${content.metaDescription}`,
          content.h1s.length ? `H1: ${content.h1s.join(' | ')}` : '',
          content.h2s.length ? `H2: ${content.h2s.join(' | ')}` : '',
          content.bodyText,
        ].filter(Boolean).join('\n');
      } catch {
        // Fall back to server-side fetch if scripting fails
      }
    }

    chrome.runtime.sendMessage({ type: 'ANALYZE_FOR_CI', websiteUrl: fullUrl, pageContent });
  }, [tabId]);

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
        <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Analysis queued</p>
        <p className="error-message" style={{ color: 'var(--muted)' }}>
          It’s processing in the cloud — it’ll show in your Jobs list, then Companies once done.
        </p>
        <div className="error-actions">
          <button
            className="btn btn--primary"
            onClick={() => chrome.tabs.create({ url: `${state.baseUrl}/tools/company-intelligence/jobs` })}
          >
            View Jobs
          </button>
          <button className="btn btn--secondary" onClick={() => setState({ status: 'idle' })}>
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
            <button className="btn btn--secondary" onClick={() => setState({ status: 'idle' })}>Try Again</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {authStrip}

      {/* Current page quick-analyze */}
      {isValidPage && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
            Current Page
          </p>
          <p style={{ fontSize: 12, color: 'var(--text)', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pageUrl.replace(/^https?:\/\/(www\.)?/, '')}
          </p>
          <button
            className="btn btn--primary"
            style={{ padding: '8px 16px', fontSize: 13 }}
            onClick={() => handleAnalyze(pageUrl, true)}
          >
            🌐 Analyze Website · 5 credits
          </button>
        </div>
      )}

      {/* Manual input */}
      <div>
        <label className="form-label">Enter any website URL</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            className="url-input"
            placeholder="https://example.com"
            value={manualUrl}
            onChange={e => setManualUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && manualUrl.trim()) handleAnalyze(manualUrl, false); }}
          />
          <button
            className="btn btn--secondary"
            style={{ width: 'auto', padding: '8px 12px', flexShrink: 0 }}
            disabled={!manualUrl.trim()}
            onClick={() => handleAnalyze(manualUrl, false)}
          >
            Go
          </button>
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
          5 credits per analysis. Results saved to your dashboard.
        </p>
      </div>
    </div>
  );
}
