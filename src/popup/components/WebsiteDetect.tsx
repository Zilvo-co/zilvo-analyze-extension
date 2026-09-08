import React, { useState, useEffect, useCallback } from 'react';
import { extractWebsiteContent } from '../../content/website';
import InsufficientCredits from './InsufficientCredits';
import { canAfford } from '../../utils/credits';
import { ZILVO_APP_DEFAULT, APP, appUrl } from '../../config';
import type { CIBackgroundMessage, CreditState, ExtractedContent } from '../../types';

interface Props extends CreditState {
  onLogout: () => void;
  userName: string;
}

type State =
  | { status: 'idle' }
  | { status: 'loading'; step: string; message: string }
  | { status: 'success'; baseUrl: string }
  | { status: 'error'; error: string; code?: number; required?: number; remaining?: number };

export default function WebsiteDetect({ onLogout, userName, credits, creditCost, refreshCredits }: Props) {
  const [state,      setState]      = useState<State>({ status: 'idle' });
  const [pageUrl,    setPageUrl]    = useState('');
  const [tabId,      setTabId]      = useState<number | null>(null);
  const [manualUrl,  setManualUrl]  = useState('');
  const [baseUrl,    setBaseUrl]    = useState(ZILVO_APP_DEFAULT);
  const [isValidPage, setIsValidPage] = useState(false);

  // Gates both entry points below — the detected page and the manual URL box.
  const affordable = canAfford(credits, creditCost);

  useEffect(() => {
    chrome.storage.local.get({ zilvoAppUrl: ZILVO_APP_DEFAULT }, items => {
      setBaseUrl(items.zilvoAppUrl as string);
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
        refreshCredits(); // credits were just spent — re-read the balance
      } else if (message.type === 'CI_ERROR') {
        setState({
          status: 'error',
          error: message.error,
          code: message.code,
          required: message.required,
          remaining: message.remaining,
        });
        // A 402 means the balance is lower than we thought — re-read it so the
        // gate engages on the way back instead of offering the button again.
        if (message.code === 402) refreshCredits();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [baseUrl, refreshCredits]);

  const handleAnalyze = useCallback(async (url: string, fromCurrentTab = false) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    // Belt and braces: the buttons are disabled when unaffordable, but a stale
    // render must never be able to start a run that cannot be paid for.
    if (!canAfford(credits, creditCost)) return;
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

    chrome.runtime.sendMessage({ type: 'ANALYZE_FOR_CI', websiteUrl: fullUrl, pageContent, userInputField: fullUrl });
  }, [tabId, credits, creditCost]);

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
        <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Analysis saved!</p>
        <p className="error-message" style={{ color: 'var(--muted)' }}>
          View the full company profile and fit score in your Zilvo dashboard.
        </p>
        <div className="error-actions">
          <button
            className="btn btn--primary"
            onClick={() => chrome.tabs.create({ url: appUrl(APP.companies, state.baseUrl) })}
          >
            Open Dashboard
          </button>
          <button className="btn btn--secondary" onClick={() => setState({ status: 'idle' })}>
            Analyze Another
          </button>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    // 402 → surface a top-up CTA instead of a dead-end "Try Again" that just re-fails.
    const outOfCredits = state.code === 402;
    const creditsMsg =
      `Not enough credits to run this analysis.` +
      (state.required != null
        ? ` You need ${state.required}${state.remaining != null ? ` but have ${state.remaining}` : ''}.`
        : '') +
      ` Top up to continue.`;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {authStrip}
        <div className="error-state" style={{ marginTop: 0 }}>
          <div className="error-icon">!</div>
          <p className="error-message">{outOfCredits ? creditsMsg : state.error}</p>
          <div className="error-actions">
            {outOfCredits && (
              <button className="btn btn--primary" onClick={() => chrome.tabs.create({ url: appUrl(APP.billing, baseUrl) })}>
                Buy Credits
              </button>
            )}
            <button className="btn btn--secondary" onClick={() => setState({ status: 'idle' })}>
              {outOfCredits ? 'Back' : 'Try Again'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const displayDomain = pageUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {authStrip}

      {/* Cost info bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'rgba(10,102,194,0.06)', borderRadius: 8, border: '1px solid rgba(10,102,194,0.15)' }}>
        <span style={{ fontSize: 11, color: 'var(--primary)' }}>💳</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{creditCost} credits per analysis · Results saved to your dashboard</span>
      </div>

      {!affordable && (
        <InsufficientCredits credits={credits} creditCost={creditCost} baseUrl={baseUrl} />
      )}

      {/* Current page quick-analyze */}
      {isValidPage && (
        <div style={{ background: 'var(--surface)', border: '1.5px solid rgba(5,150,105,0.3)', borderRadius: 10, padding: '14px 14px' }}>
          {/* Header with checkmark */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <span style={{ width: 18, height: 18, background: 'rgba(5,150,105,0.15)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--success)', fontSize: 11, flexShrink: 0 }}>✓</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--success)' }}>Website detected</span>
          </div>

          {/* Domain */}
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayDomain}
          </p>

          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
            Ready to analyze this company.
          </p>

          {/* Meta pills */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Est. time</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>~7 seconds</span>
            </div>
            <div style={{ width: 1, background: 'var(--border)', flexShrink: 0 }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Cost</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)' }}>{creditCost} Credits</span>
            </div>
          </div>

          <button
            className="btn btn--primary"
            style={{ padding: '9px 16px', fontSize: 13 }}
            disabled={!affordable}
            onClick={() => handleAnalyze(pageUrl, true)}
          >
            Analyze Company
          </button>
        </div>
      )}

      {/* Manual input */}
      <div>
        <label className="form-label">Or enter any website URL</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            className="url-input"
            placeholder="https://example.com"
            value={manualUrl}
            onChange={e => setManualUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && manualUrl.trim() && affordable) handleAnalyze(manualUrl, false); }}
          />
          <button
            className="btn btn--secondary"
            style={{ width: 'auto', padding: '8px 12px', flexShrink: 0 }}
            disabled={!manualUrl.trim() || !affordable}
            onClick={() => handleAnalyze(manualUrl, false)}
          >
            Go
          </button>
        </div>
      </div>
    </div>
  );
}
