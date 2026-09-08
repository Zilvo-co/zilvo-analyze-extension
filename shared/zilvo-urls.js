/**
 * shared/zilvo-urls.js — THE single source of truth for every Zilvo URL.
 *
 * Consumed by BOTH extensions in this repo:
 *   • root (legacy vanilla JS) — helpers/constants.js re-exports from here
 *   • src/ (React + TS)        — src/config.ts re-exports from here
 *
 * To switch environments, change ZILVO_ENV below. That is the only edit.
 * The manifests deliberately list production AND localhost permissions at all
 * times, so they are not part of the switch and need no editing either.
 *
 * Plain ESM on purpose: the legacy extension loads it directly in the browser,
 * and the TypeScript build reads its types from the sibling .d.ts.
 */

/** ▸ The only line to change when switching environments. */
export const ZILVO_ENV = 'production';

// ZILVO_API — where the REST API lives (fetch calls only).
// ZILVO_APP — where the web app lives (login, billing, dashboards): every URL
//             that gets OPENED IN A TAB, and the origin that owns the auth
//             token. These are DIFFERENT hosts in production — opening a page
//             on the API host is a 404, and reading a token from anywhere but
//             the app host is how stale sessions leak in.
const HOSTS = {
  local:      { api: 'http://localhost:3001', app: 'http://localhost:3000' },
  production: { api: 'https://api.zilvo.co',  app: 'https://app.zilvo.co'  },
};

export const ZILVO_API = HOSTS[ZILVO_ENV].api;
export const ZILVO_APP = HOSTS[ZILVO_ENV].app;

/** REST endpoints, relative to ZILVO_API. */
export const API = {
  login:   '/api/auth/login',
  logout:  '/api/auth/logout',
  me:      '/api/me',
  credits: '/api/credits',
  ledger:  '/api/credits/ledger',
  charge:  '/api/credits/charge',
  pricing: '/api/pricing',
  analyze: '/api/company-intelligence/analyze',
};

/** Web-app pages, relative to ZILVO_APP. Opened in tabs, never fetched. */
export const APP = {
  login:          '/login',
  signup:         '/signup',
  forgotPassword: '/forgot-password',
  billing:        '/billing',
  companies:      '/tools/company-intelligence/companies',
  jobs:           '/tools/company-intelligence/jobs',
  overview:       '/tools/company-intelligence/overview',
};

/** Absolute API URL for one of the {@link API} paths. */
export function apiUrl(path) {
  return `${ZILVO_API}${path}`;
}

/**
 * Absolute web-app URL for one of the {@link APP} paths. `base` overrides the
 * host — the React build lets the user point the extension elsewhere from
 * Settings, and that override is stored in chrome.storage.
 */
export function appUrl(path, base = ZILVO_APP) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

/**
 * Every origin that has ever stored a Zilvo token. Purged on reset/logout so no
 * legacy host can hand an old session back to the extension. Kept as a fixed
 * list rather than derived from ZILVO_APP: a token left behind on a host we no
 * longer use still has to be cleaned up.
 *
 * NOTE: these must stay covered by `host_permissions` in both manifests.
 */
export const TOKEN_ORIGINS = [
  'https://app.zilvo.co/*',
  'https://zilvo.co/*',
  'https://www.zilvo.co/*',
  'http://localhost:3000/*',
  'http://localhost:3001/*',
];

/**
 * Cookie domains matching TOKEN_ORIGINS.
 *
 * Hosts only — chrome.cookies.getAll({ domain }) matches on the domain
 * attribute and never sees a port, so the previous 'localhost:3000' /
 * 'localhost:3001' entries matched nothing and left local dev cookies behind
 * on logout. 'localhost' covers both ports.
 */
export const TOKEN_COOKIE_DOMAINS = [
  'zilvo.co',
  'www.zilvo.co',
  'app.zilvo.co',
  'api.zilvo.co',
  'localhost',
];
