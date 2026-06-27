import React from 'react';
import type { ProgressStep } from '../../types';

const STEPS: ProgressStep[] = [
  'opening_linkedin',
  'extracting_linkedin',
  'opening_website',
  'extracting_content',
  'classifying',
];

const STEP_LABELS: Record<ProgressStep, string> = {
  opening_linkedin:   'Open LinkedIn',
  extracting_linkedin:'Extract Website URL',
  opening_website:    'Open Company Website',
  extracting_content: 'Extract Content',
  classifying:        'AI Classification',
  done:               'Done',
};

interface Props {
  step: ProgressStep;
  message: string;
}

export default function LoadingState({ step, message }: Props) {
  const currentIndex = STEPS.indexOf(step);
  return (
    <div className="loading-state">
      <div className="spinner" />
      <p className="loading-message">{message}</p>
      <div className="steps">
        {STEPS.map((s, i) => {
          const cls = i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'pending';
          return (
            <div key={s} className={`step step--${cls}`}>
              <div className="step-dot" />
              <span className="step-label">{STEP_LABELS[s]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
