import React from 'react';
import type { ClassificationResult } from '../../types';

interface Props {
  result: ClassificationResult;
  companyName: string | null;
  websiteUrl: string | null;
  onReset: () => void;
}

function ConfidencePill({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? '#059669' : pct >= 60 ? '#D97706' : '#DC2626';
  return <span className="confidence-score" style={{ color }}>{pct}%</span>;
}

export default function ResultCard({ result, companyName, websiteUrl, onReset }: Props) {
  const displayName = result.companyName || companyName;

  return (
    <div className="result-card">
      {displayName && <h2 className="result-company">{displayName}</h2>}
      {websiteUrl && (
        <a href={websiteUrl} target="_blank" rel="noopener noreferrer" className="result-url">
          {websiteUrl.replace(/^https?:\/\//, '')}
        </a>
      )}

      <div className="result-badges">
        <span className="badge badge--industry">{result.industry}</span>
        <span className="badge">{result.businessType}</span>
        <span className="badge">{result.companyModel}</span>
        <span className="badge">{result.growthStage}</span>
      </div>

      {result.companyDescription && (
        <p className="result-description">{result.companyDescription}</p>
      )}

      <div className="result-section">
        <div className="result-row">
          <span className="result-label">Business Type</span>
          <span>{result.businessType}</span>
          <ConfidencePill score={result.businessTypeConfidence} />
        </div>
        <div className="result-row">
          <span className="result-label">Company Model</span>
          <span>{result.companyModel}</span>
          <ConfidencePill score={result.companyModelConfidence} />
        </div>
        <div className="result-row">
          <span className="result-label">Industry</span>
          <span>{result.industry}</span>
          <ConfidencePill score={result.industryConfidence} />
        </div>
      </div>

      {result.targetCustomerType?.length > 0 && (
        <div className="result-section">
          <span className="result-label">Target Customers</span>
          <div className="keywords">
            {result.targetCustomerType.map(t => (
              <span key={t} className="keyword-tag">{t}</span>
            ))}
          </div>
        </div>
      )}

      {result.geography?.length > 0 && (
        <div className="result-section">
          <span className="result-label">Geography</span>
          <div className="keywords">
            {result.geography.map(g => (
              <span key={g} className="keyword-tag">{g}</span>
            ))}
          </div>
        </div>
      )}

      {result.servicesOffered?.length > 0 && (
        <div className="result-section">
          <span className="result-label">Services Offered</span>
          <div className="keywords">
            {result.servicesOffered.map(s => (
              <span key={s} className="keyword-tag">{s}</span>
            ))}
          </div>
        </div>
      )}

      {result.buyerPersonas?.length > 0 && (
        <div className="result-section">
          <span className="result-label">Buyer Personas</span>
          <div className="keywords">
            {result.buyerPersonas.map(p => (
              <span key={p} className="keyword-tag">{p}</span>
            ))}
          </div>
        </div>
      )}

      {result.icp && (
        <div className="result-section">
          <span className="result-label">ICP</span>
          {result.icp.industriesServed?.length > 0 && (
            <p className="result-icp-row"><strong>Industries:</strong> {result.icp.industriesServed.join(', ')}</p>
          )}
          {result.icp.companySizes?.length > 0 && (
            <p className="result-icp-row"><strong>Company Sizes:</strong> {result.icp.companySizes.join(', ')}</p>
          )}
          {result.icp.buyerRoles?.length > 0 && (
            <p className="result-icp-row"><strong>Buyer Roles:</strong> {result.icp.buyerRoles.join(', ')}</p>
          )}
          {result.icp.useCases?.length > 0 && (
            <p className="result-icp-row"><strong>Use Cases:</strong> {result.icp.useCases.join(', ')}</p>
          )}
        </div>
      )}

      <button className="btn btn--secondary" onClick={onReset}>Classify Another</button>
    </div>
  );
}
