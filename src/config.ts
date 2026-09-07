// ── Backend + web app URLs ───────────────────────────────────────────────────
// ZILVO_API_DEFAULT — where the REST API lives (fetch calls only).
// ZILVO_APP_DEFAULT — where the web app lives (login, billing, dashboard links,
//                     and the origin that owns the auth token).
// These are DIFFERENT hosts. Opening a page on the API host gives a 404, and
// reading a token from anywhere but the app host is how stale sessions leak in.
// For local dev point both at 'http://localhost:3000'.
export const ZILVO_API_DEFAULT = 'https://api.zilvo.co';
export const ZILVO_APP_DEFAULT = 'https://app.zilvo.co';

// Every origin that has ever stored a Zilvo token. Purged on reset/logout so no
// legacy host can hand an old session back to the extension.
export const TOKEN_ORIGINS = [
  'https://app.zilvo.co/*',
  'https://zilvo.co/*',
  'https://www.zilvo.co/*',
  'http://localhost:3000/*',
];

// Cookie domains matching TOKEN_ORIGINS.
export const TOKEN_COOKIE_DOMAINS = ['zilvo.co', 'www.zilvo.co', 'app.zilvo.co', 'api.zilvo.co'];

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
