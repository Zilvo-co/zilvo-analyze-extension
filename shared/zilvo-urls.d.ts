// Types for shared/zilvo-urls.js — the runtime module is plain ESM so the
// legacy extension can load it in the browser without a build step.

export declare const ZILVO_ENV: 'local' | 'production';
export declare const ZILVO_API: string;
export declare const ZILVO_APP: string;

export declare const API: {
  login: string; logout: string; me: string; credits: string;
  ledger: string; charge: string; pricing: string; analyze: string;
};

export declare const APP: {
  login: string; signup: string; forgotPassword: string; billing: string;
  companies: string; jobs: string; overview: string;
};

export declare function apiUrl(path: string): string;
export declare function appUrl(path: string, base?: string): string;

export declare const TOKEN_ORIGINS: string[];
export declare const TOKEN_COOKIE_DOMAINS: string[];
