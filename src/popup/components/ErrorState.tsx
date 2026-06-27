import React from 'react';

interface Props {
  error: string;
  onRetry: () => void;
  onReset: () => void;
}

export default function ErrorState({ error, onRetry, onReset }: Props) {
  const isApiKeyError = error.toLowerCase().includes('api key');
  return (
    <div className="error-state">
      <div className="error-icon">!</div>
      <p className="error-message">{error}</p>
      <div className="error-actions">
        {!isApiKeyError && (
          <button className="btn btn--primary" onClick={onRetry}>Retry</button>
        )}
        <button className="btn btn--secondary" onClick={onReset}>Start Over</button>
      </div>
    </div>
  );
}
