/**
 * helpers/auth.js
 * JWT token + user profile storage for Zilvo auth in the extension.
 *
 * ONE RULE GOVERNS THIS FILE: a token is trusted only if it came from the web
 * app THIS build is configured against (ZILVO_APP).
 *
 * content_zilvo.js is registered on production AND localhost — the manifest is
 * static and cannot vary with ZILVO_ENV — so it syncs whatever session it finds
 * into this one slot. Without the stamp, a token picked up during local dev
 * outlives an environment switch and is then sent to api.zilvo.co, where it
 * VERIFIES (same JWT secret) but resolves to a userId that only exists in the
 * local database. The API answers 200 with an empty list rather than 401, so
 * every account-scoped list — ICPs included — silently reads as empty instead
 * of erroring. That is the failure this stamp exists to prevent.
 *
 * The React build under src/ enforces the same rule in utils/authToken.ts.
 */

import { ZILVO_APP } from './constants.js';

const AUTH_KEY = 'zilvo_auth';

export async function getStoredAuth() {
  const result = await chrome.storage.local.get(AUTH_KEY);
  const auth   = result[AUTH_KEY] ?? null;
  if (!auth) return null;

  // Records written before the stamp existed carry no origin, and nothing in
  // them says which host minted them — treat those as foreign too and force a
  // single re-login rather than keep trusting a token that may be the very one
  // causing the mismatch.
  if (auth.origin !== ZILVO_APP) {
    console.warn(
      '[Zilvo] purging auth from', auth.origin ?? 'an unknown origin',
      '— this build talks to', ZILVO_APP,
    );
    await chrome.storage.local.remove(AUTH_KEY);
    return null;
  }
  return auth;
}

/** Only ever called for a session that came from ZILVO_APP — see the guard in
 *  background.js's ZILVO_SYNC_AUTH handler. */
export async function setStoredAuth(token, user) {
  await chrome.storage.local.set({ [AUTH_KEY]: { token, user, origin: ZILVO_APP } });
}

export async function clearStoredAuth() {
  await chrome.storage.local.remove(AUTH_KEY);
}

export async function updateStoredCredits(credits) {
  const auth = await getStoredAuth();
  if (!auth) return;
  // Spread keeps `origin` on the record; dropping it would purge the session on
  // the next read.
  await chrome.storage.local.set({
    [AUTH_KEY]: { ...auth, user: { ...auth.user, credits } },
  });
}
