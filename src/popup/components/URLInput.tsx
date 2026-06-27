import React, { useState } from 'react';
import { isValidLinkedInCompanyUrl } from '../../utils/helpers';

interface Props {
  onClassify: (url: string) => void;
  disabled: boolean;
}

export default function URLInput({ onClassify, disabled }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) { setError('Please enter a LinkedIn URL'); return; }
    if (!isValidLinkedInCompanyUrl(trimmed)) {
      setError('Must be a LinkedIn company URL  (e.g. linkedin.com/company/…)');
      return;
    }
    setError('');
    onClassify(trimmed);
  };

  return (
    <form className="url-form" onSubmit={handleSubmit}>
      <label className="form-label">LinkedIn Company URL</label>
      <input
        type="text"
        className={`url-input${error ? ' url-input--error' : ''}`}
        placeholder="https://linkedin.com/company/…"
        value={value}
        onChange={e => { setValue(e.target.value); setError(''); }}
        disabled={disabled}
        autoFocus
      />
      {error && <p className="input-error">{error}</p>}
      <button type="submit" className="btn btn--primary" disabled={disabled || !value.trim()}>
        {disabled ? 'Classifying…' : 'Classify Company'}
      </button>
    </form>
  );
}
