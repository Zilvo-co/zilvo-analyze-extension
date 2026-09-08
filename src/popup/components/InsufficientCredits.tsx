import React from 'react';
import { APP, appUrl } from '../../config';

interface Props {
  credits: number | null;
  creditCost: number;
  /** App host — /billing lives on the web app, not the API host. */
  baseUrl: string;
  /** Replaces the default single-analysis wording (bulk needs its own). */
  message?: React.ReactNode;
}

/**
 * Rendered above a disabled analyze action when the balance cannot cover it.
 * Shared by all three tabs so the wording and the top-up route stay identical.
 */
export default function InsufficientCredits({ credits, creditCost, baseUrl, message }: Props) {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        padding: '10px 12px', borderRadius: 8,
        background: 'rgba(217,119,6,0.08)',
        border: '1px solid rgba(217,119,6,0.25)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span style={{ fontSize: 12, flexShrink: 0, lineHeight: 1.4 }}>⚠️</span>
        <span style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.45 }}>
          {message ?? (
            <>
              Not enough credits. This analysis costs <strong>{creditCost}</strong> and you have{' '}
              <strong>{credits ?? 0}</strong>. Top up to continue.
            </>
          )}
        </span>
      </div>
      <button
        className="btn btn--primary"
        style={{ padding: '8px 16px', fontSize: 12 }}
        onClick={() => chrome.tabs.create({ url: appUrl(APP.billing, baseUrl) })}
      >
        Buy Credits
      </button>
    </div>
  );
}
