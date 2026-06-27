import React, { useState, useEffect } from 'react';

interface Props {
  onBack: () => void;
}

const MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — Fast & cost-efficient' },
  { value: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6 — Balanced' },
  { value: 'claude-opus-4-7',           label: 'Claude Opus 4.7 — Most capable' },
];

export default function Settings({ onBack }: Props) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-haiku-4-5-20251001');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.storage.local.get({ apiKey: '', model: 'claude-haiku-4-5-20251001' }, items => {
      setApiKey((items.apiKey as string) || '');
      setModel((items.model as string) || 'claude-haiku-4-5-20251001');
    });
  }, []);

  const handleSave = () => {
    chrome.storage.local.set({ apiKey, model }, () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  return (
    <div className="app">
      <header className="app-header">
        <button className="icon-btn" onClick={onBack}>←</button>
        <span className="app-title-text">Settings</span>
        <div style={{ width: 32 }} />
      </header>
      <main className="app-main">
        <div className="settings-form">
          <div className="form-group">
            <label className="form-label">Anthropic API Key</label>
            <input
              type="password"
              className="url-input"
              placeholder="sk-ant-…"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
            />
            <p className="form-hint">
              Get your key at{' '}
              <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer">
                console.anthropic.com
              </a>
            </p>
          </div>

          <div className="form-group">
            <label className="form-label">Model</label>
            <select className="url-input" value={model} onChange={e => setModel(e.target.value)}>
              {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>

          <button className="btn btn--primary" onClick={handleSave}>
            {saved ? '✓ Saved!' : 'Save Settings'}
          </button>
        </div>
      </main>
    </div>
  );
}
