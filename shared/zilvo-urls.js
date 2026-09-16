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
//             token. Reading a token from anywhere but the app host is how
//             stale sessions leak in.
//
// BOTH POINT AT THE SAME HOST. api.zilvo.co and app.zilvo.co are served by the
// same nginx on the same box, but they are SEPARATE deployments — their /login
// responses carry different Next.js buildIds, so they are independent processes
// with independent env files, and their databases had drifted apart. The web
// app calls its API with relative paths, so the dashboard always reads whatever
// app.zilvo.co is serving. When the extension pointed at api.zilvo.co it was
// querying the OTHER deployment: the token verified (shared JWT secret) but
// account-scoped reads came back empty, so /company-intelligence/icp answered
// `200 []` instead of erroring and the popup showed "No ICP yet" for a user
// with two positionings on screen.
//
// Anything account-scoped MUST come from the same deployment that owns the
// session. Keep these two equal unless the API is genuinely split out again —
// and if it is, the two must share a database.
const HOSTS = {
  // One port for both: since the platform/marketing repo split, `zilvo-platform`
  // serves the app (login, dashboards) AND /api from a single local dev server.
  // `app` is also the ONLY origin getActiveToken() will read a token from, so
  // pointing it at a port the platform is not on silently logs the popup out.
  local:      { api: 'http://localhost:3001', app: 'http://localhost:3001' },
  production: { api: 'https://app.zilvo.co',  app: 'https://app.zilvo.co'  },
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
  // The user's saved positionings. `${API.icp}/${id}/default` sets the account
  // default — the same endpoint the web app's My ICP page uses.
  icp:     '/api/company-intelligence/icp',
};

/** Web-app pages, relative to ZILVO_APP. Opened in tabs, never fetched. */
export const APP = {
  login:          '/login',
  signup:         '/signup',
  forgotPassword: '/forgot-password',
  billing:        '/billing',
  companies:      '/tools/company-intelligence/companies',
  // My ICP — where positionings are created. The popup links here when the
  // account has none yet, since an ICP can only be authored in the web app.
  icp:            '/tools/company-intelligence/icp',
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
