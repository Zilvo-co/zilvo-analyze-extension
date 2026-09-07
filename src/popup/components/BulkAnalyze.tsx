import React, { useState, useEffect, useRef } from 'react';
import { isValidLinkedInCompanyUrl, normalizeLinkedInUrl } from '../../utils/helpers';
import { getActionCost } from '../../utils/zilvoApi';
import { ZILVO_APP_DEFAULT } from '../../config';
import type { CIBackgroundMessage } from '../../types';

const CI_ANALYZE_FALLBACK_COST = 5;

interface Props {
  onLogout: () => void;
  userName: string;
}

interface BulkItem {
  url: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  message?: string;
}

type Mode = 'input' | 'processing' | 'done';

export default function BulkAnalyze({ onLogout, userName }: Props) {
  const [mode, setMode]       = useState<Mode>('input');
  const [text, setText]       = useState('');
  const [inputError, setInputError] = useState('');
  const [items, setItems]     = useState<BulkItem[]>([]);
  const [creditsExhausted, setCreditsExhausted] = useState(false);
  const [baseUrl, setBaseUrl] = useState(ZILVO_APP_DEFAULT);
  const [creditCost, setCreditCost] = useState(CI_ANALYZE_FALLBACK_COST);
  const currentIdx            = useRef(0);
  const batchIdRef            = useRef<string>('');

  useEffect(() => {
    chrome.storage.local.get({ zilvoAppUrl: ZILVO_APP_DEFAULT }, s => {
      setBaseUrl(s.zilvoAppUrl as string);
    });
  }, []);

  // Fetch the ci.analyze cost once; fall back to 5 so the UI never breaks.
  useEffect(() => {
    getActionCost('ci.analyze', CI_ANALYZE_FALLBACK_COST)
      .then(cost => setCreditCost(cost || CI_ANALYZE_FALLBACK_COST))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (mode !== 'processing') return;

    const listener = (msg: CIBackgroundMessage) => {
      if (msg.type === 'CI_PROGRESS') {
        setItems(prev => prev.map((it, i) =>
          i === currentIdx.current ? { ...it, message: msg.message } : it
        ));
      } else if (msg.type === 'CI_COMPLETE') {
        setItems(prev => {
          const next = prev.map((it, i) =>
            i === currentIdx.current ? { ...it, status: 'done' as const, message: 'Saved' } : it
          );
          const nextIdx = currentIdx.current + 1;
          if (nextIdx < next.length) {
            currentIdx.current = nextIdx;
            chrome.runtime.sendMessage({
              type:           'ANALYZE_FOR_CI',
              linkedinUrl:    next[nextIdx].url,
              userInputField: next[nextIdx].url,
              batchId:        batchIdRef.current,
            });
            return next.map((it, i) =>
              i === nextIdx ? { ...it, status: 'processing' as const, message: 'Analyzing…' } : it
            );
          } else {
            setMode('done');
            return next;
          }
        });
      } else if (msg.type === 'CI_ERROR') {
        // Out of credits → stop the whole batch; every remaining item would fail
        // the same way. Never auto-retry a 402.
        const outOfCredits = msg.code === 402;
        if (outOfCredits) setCreditsExhausted(true);
        setItems(prev => {
          const next = prev.map((it, i) =>
            i === currentIdx.current
              ? { ...it, status: 'error' as const, message: outOfCredits ? 'Out of credits' : msg.error }
              : it
          );
          const nextIdx = currentIdx.current + 1;
          if (!outOfCredits && nextIdx < next.length) {
            currentIdx.current = nextIdx;
            chrome.runtime.sendMessage({
              type:           'ANALYZE_FOR_CI',
              linkedinUrl:    next[nextIdx].url,
              userInputField: next[nextIdx].url,
              batchId:        batchIdRef.current,
            });
            return next.map((it, i) =>
              i === nextIdx ? { ...it, status: 'processing' as const, message: 'Analyzing…' } : it
            );
          }
          setMode('done');
          // Mark the not-yet-run items as skipped so the summary is honest.
          return outOfCredits
            ? next.map(it => (it.status === 'pending' ? { ...it, status: 'error' as const, message: 'Skipped — out of credits' } : it))
            : next;
        });
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [mode]);

  const handleStart = () => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const valid  = lines.filter(l => isValidLinkedInCompanyUrl(l)).map(l => normalizeLinkedInUrl(l));
    const unique = [...new Set(valid)];

    if (unique.length === 0) {
      setInputError('No valid LinkedIn company URLs found. Add one per line.');
      return;
    }

    const newItems: BulkItem[] = unique.map((url, i) => ({
      url,
      status: i === 0 ? 'processing' : 'pending',
      message: i === 0 ? 'Analyzing…' : undefined,
    }));

    // Generate a unique batchId for this upload
    batchIdRef.current = `bulk-${Date.now().toString(36)}`;
    currentIdx.current = 0;
    setItems(newItems);
    setMode('processing');
    chrome.runtime.sendMessage({
      type:           'ANALYZE_FOR_CI',
      linkedinUrl:    unique[0],
      userInputField: unique[0],
      batchId:        batchIdRef.current,
    });
  };

  const handleReset = () => {
    setText('');
    setInputError('');
    setItems([]);
    setCreditsExhausted(false);
    currentIdx.current = 0;
    batchIdRef.current = '';
    setMode('input');
  };

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

  if (mode === 'input') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {authStrip}

        {/* Cost info bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'rgba(10,102,194,0.06)', borderRadius: 8, border: '1px solid rgba(10,102,194,0.15)' }}>
          <span style={{ fontSize: 11, color: 'var(--primary)' }}>💳</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{creditCost} credits per company · Results saved to your dashboard</span>
        </div>

        <div>
          <label className="form-label">LinkedIn Company URLs</label>
          <textarea
            style={{
              width: '100%', boxSizing: 'border-box',
              height: 130, resize: 'vertical',
              padding: '8px 10px', fontSize: 12,
              fontFamily: 'inherit', lineHeight: 1.5,
              border: `1px solid ${inputError ? 'var(--error)' : 'var(--border)'}`,
              borderRadius: 8, background: 'var(--surface)', color: 'var(--text)',
              outline: 'none',
            }}
            placeholder={'https://linkedin.com/company/stripe\nhttps://linkedin.com/company/notion\nhttps://linkedin.com/company/figma'}
            value={text}
            onChange={e => { setText(e.target.value); setInputError(''); }}
          />
          {inputError && <p className="input-error">{inputError}</p>}
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>
            One LinkedIn company URL per line. Each costs {creditCost} credits.
          </p>
        </div>
        <button className="btn btn--primary" onClick={handleStart} disabled={!text.trim()}>
          Analyze All
        </button>
      </div>
    );
  }

  const doneCount  = items.filter(it => it.status === 'done').length;
  const errorCount = items.filter(it => it.status === 'error').length;

  if (mode === 'done') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {authStrip}
        <div className="error-state" style={{ gap: 10 }}>
          <div
            className="error-icon"
            style={
              creditsExhausted
                ? { background: 'rgba(217,119,6,0.12)', color: 'var(--warning, #d97706)', fontSize: 22 }
                : { background: 'rgba(5,150,105,0.12)', color: 'var(--success)', fontSize: 22 }
            }
          >
            {creditsExhausted ? '!' : '✓'}
          </div>
          <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
            {creditsExhausted ? 'Stopped — out of credits' : 'Bulk analysis complete'}
          </p>
          <p className="error-message" style={{ color: 'var(--muted)' }}>
            {doneCount} saved{errorCount > 0 ? `, ${errorCount} failed` : ''}.{' '}
            {doneCount * creditCost} credits used.
            {creditsExhausted && ' Top up to analyze the rest.'}
          </p>
          <div className="error-actions">
            {creditsExhausted ? (
              <button
                className="btn btn--primary"
                onClick={() => chrome.tabs.create({ url: `${baseUrl}/billing` })}
              >
                Buy Credits
              </button>
            ) : (
              <button
                className="btn btn--primary"
                onClick={() => chrome.tabs.create({ url: `${baseUrl}/tools/company-intelligence/jobs` })}
              >
                View in Dashboard
              </button>
            )}
            <button className="btn btn--secondary" onClick={handleReset}>Analyze More</button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map(it => <ItemRow key={it.url} item={it} />)}
        </div>
      </div>
    );
  }

  // processing
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {authStrip}
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
        Analyzing {doneCount + errorCount + 1} of {items.length}…
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(it => <ItemRow key={it.url} item={it} />)}
      </div>
    </div>
  );
}

function ItemRow({ item }: { item: BulkItem }) {
  const icon =
    item.status === 'done'       ? '✓' :
    item.status === 'error'      ? '✕' :
    item.status === 'processing' ? '…' : '·';

  const color =
    item.status === 'done'       ? 'var(--success)' :
    item.status === 'error'      ? 'var(--error)'   :
    item.status === 'processing' ? 'var(--primary)'  : 'var(--muted)';

  const shortUrl = item.url.replace(/^https?:\/\/(www\.)?linkedin\.com\/company\//, '').replace(/\/$/, '');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--surface)', borderRadius: 7, border: '1px solid var(--border)' }}>
      <span style={{ fontSize: 13, color, fontWeight: 700, flexShrink: 0, width: 14, textAlign: 'center' }}>{icon}</span>
      <span style={{ fontSize: 12, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {shortUrl}
      </span>
      {item.message && (
        <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{item.message}</span>
      )}
    </div>
  );
}
