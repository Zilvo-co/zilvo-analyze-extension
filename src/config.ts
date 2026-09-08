// ── Backend + web app URLs ───────────────────────────────────────────────────
// Values live in ONE place: shared/zilvo-urls.js, which the legacy extension at
// the repo root loads too. Change the environment there, not here.
//
// This module adds only what the React build needs on top: the chrome.storage
// overrides that let a user point the extension at a different host from
// Settings, and the app-origin rule the token resolver depends on.
export {
  ZILVO_ENV,
  API,
  APP,
  apiUrl,
  appUrl,
  TOKEN_ORIGINS,
  TOKEN_COOKIE_DOMAINS,
} from '../shared/zilvo-urls.js';

import { ZILVO_API, ZILVO_APP } from '../shared/zilvo-urls.js';

/** Defaults for the chrome.storage overrides below. */
export const ZILVO_API_DEFAULT = ZILVO_API;
export const ZILVO_APP_DEFAULT = ZILVO_APP;

// Bump to force every installed extension to purge its tokens once on update.
// Leaving it unchanged means a normal version bump does NOT log users out.
export const TOKEN_RESET_VERSION = '2.0.1';

/** Base URL for API requests. */
export function getZilvoBaseUrl(): Promise<string> {
  return new Promise(resolve => {
    chrome.storage.local.get({ zilvoBaseUrl: ZILVO_API_DEFAULT }, items => {
      resolve(items.zilvoBaseUrl as string);
    });
  });
}

/** Base URL for anything opened in a browser tab (login, billing, dashboards). */
export function getZilvoAppUrl(): Promise<string> {
  return new Promise(resolve => {
    chrome.storage.local.get({ zilvoAppUrl: ZILVO_APP_DEFAULT }, items => {
      resolve(items.zilvoAppUrl as string);
    });
  });
}

/**
 * The ONLY origin a live auth token may be read from — the host that owns the
 * login flow. Follows the configured app URL so local dev works unchanged.
 */
export async function getAppOrigins(): Promise<string[]> {
  const appUrl = await getZilvoAppUrl();
  return [`${appUrl.replace(/\/+$/, '')}/*`];
}
