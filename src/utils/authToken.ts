// ── AUTH TOKEN — single source of truth ──────────────────────────────────────
//
// Ported from the fix in zilvo-extension, where /api/extract-leads and
// /api/credits ended up sending tokens for two DIFFERENT user records on the
// same email: a stale token left on a legacy origin (www.zilvo.co) beat the
// real one because only `tabs[0]` was read. Rules here:
//
//   1. Tokens are read ONLY from the app origin (the host that owns login).
//   2. Every app tab is read, not just the first; the freshest (highest `iat`)
//      unexpired token wins, so an old tab can never beat a newer login.
//   3. Expired tokens are discarded and everything is purged → forced re-login.
//   4. Every authenticated request goes through getActiveToken(), so the popup
//      and the background never disagree about who is signed in.

import { getAppOrigins, TOKEN_ORIGINS, TOKEN_COOKIE_DOMAINS } from '../config';

interface JwtClaims {
  userId?: string;
  email?: string;
  isAdmin?: boolean;
  iat?: number;
  exp?: number;
}

interface TokenCandidate {
  token: string;
  user: { name?: string; email?: string; credits?: number } | null;
}

/**
 * Decode a JWT payload without verifying it. We only need `iat`/`exp` to pick
 * the freshest token; the backend still validates the signature.
 */
export function decodeJwt(token: string): JwtClaims | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as JwtClaims;
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string): boolean {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 <= Date.now() : false;
}

export function tokenIssuedAt(token: string): number {
  return decodeJwt(token)?.iat ?? 0;
}

/**
 * Epoch SECONDS of the last logout. Without this, logout does not stick: the
 * purge empties chrome.storage but getActiveToken() immediately re-reads the
 * token out of any still-open zilvo.co tab and writes it straight back. The
 * tombstone makes every token issued before the logout permanently unusable,
 * so a stale tab can no longer resurrect the session.
 */
const LOGOUT_AT_KEY = 'zilvoLogoutAt';

async function getLogoutAt(): Promise<number> {
  const { [LOGOUT_AT_KEY]: at } = await chrome.storage.local.get({ [LOGOUT_AT_KEY]: 0 });
  return typeof at === 'number' ? at : 0;
}

/** A token minted before the last logout is dead, no matter where it came from. */
function isRevokedByLogout(token: string, logoutAt: number): boolean {
  if (!logoutAt) return false;
  // `iat` has second resolution, so a login landing in the same second as the
  // logout must still be accepted — only strictly older tokens are revoked.
  return tokenIssuedAt(token) < logoutAt;
}

/**
 * Wipe every copy of the auth token: extension storage, the localStorage of
 * every Zilvo origin (legacy hosts included), and all Zilvo cookies.
 * `zilvoTokenResetVersion` is deliberately preserved.
 */
export async function clearAllTokens({ notify = true }: { notify?: boolean } = {}): Promise<void> {
  // Drop any in-flight lookup, otherwise a resolver that collected the token
  // before the purge writes it back to storage after the purge.
  activeTokenLookup = null;
  await chrome.storage.local.remove(['zilvoToken', 'zilvoName', 'zilvoEmail']);
  await chrome.storage.local.set({ [LOGOUT_AT_KEY]: Math.floor(Date.now() / 1000) });

  const tabs = await chrome.tabs.query({ url: TOKEN_ORIGINS }).catch(() => [] as chrome.tabs.Tab[]);
  await Promise.all(
    tabs.map(tab =>
      tab.id
        ? chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              func: () => {
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                document.cookie = 'token=; path=/; max-age=0; SameSite=Lax';
              },
            })
            .catch(() => {})
        : Promise.resolve()
    )
  );

  // getAll({domain}) also returns cookies of SUB-domains, so the removal URL has
  // to be built from `cookie.domain` — building it from the queried domain
  // aimed the delete at the wrong host and silently left the cookie in place.
  const seen = new Set<string>();
  for (const domain of TOKEN_COOKIE_DOMAINS) {
    const cookies = await chrome.cookies.getAll({ domain }).catch(() => [] as chrome.cookies.Cookie[]);
    for (const cookie of cookies) {
      const host = cookie.domain.replace(/^\./, '');
      const protocol = cookie.secure ? 'https' : 'http';
      const url = `${protocol}://${host}${cookie.path}`;
      const key = `${url}|${cookie.name}|${cookie.storeId ?? ''}`;
      if (seen.has(key)) continue; // the same cookie surfaces under several queried domains
      seen.add(key);
      await chrome.cookies
        .remove({ url, name: cookie.name, storeId: cookie.storeId })
        .catch(() => {});
    }
  }

  console.log('[Zilvo] clearAllTokens — purged storage, localStorage and cookies');
  if (notify) {
    chrome.runtime.sendMessage({ action: 'authStateChanged', loggedIn: false }).catch(() => {});
  }
}

/**
 * Read the token out of every open app tab (content script first, scripting API
 * as fallback for tabs that predate the extension load).
 */
async function collectTokensFromAppTabs(): Promise<TokenCandidate[]> {
  const origins = await getAppOrigins();
  const tabs = await chrome.tabs.query({ url: origins }).catch(() => [] as chrome.tabs.Tab[]);
  console.log('[Zilvo] collectTokensFromAppTabs — app tabs found:', tabs.length);

  const found: TokenCandidate[] = [];
  for (const tab of tabs) {
    if (!tab.id) continue;
    let token: string | null = null;
    let user: TokenCandidate['user'] = null;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getAuthToken' });
      token = response?.token ?? null;
      user = response?.user ?? null;
    } catch {
      const results = await chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          func: () => {
            const t = localStorage.getItem('token') || null;
            let u: unknown = null;
            try { u = JSON.parse(localStorage.getItem('user') || ''); } catch { /* no user */ }
            return { token: t, user: u };
          },
        })
        .catch(() => null);
      const result = results?.[0]?.result as { token?: string | null; user?: TokenCandidate['user'] } | undefined;
      token = result?.token ?? null;
      user = result?.user ?? null;
    }
    if (token) found.push({ token, user });
  }
  return found;
}

/**
 * The one token every authenticated request must use. Concurrent callers share
 * a single in-flight lookup instead of racing each other.
 */
let activeTokenLookup: Promise<string | null> | null = null;

export function getActiveToken(): Promise<string | null> {
  if (activeTokenLookup) return activeTokenLookup;
  activeTokenLookup = (async () => {
    try {
      const candidates = await collectTokensFromAppTabs();
      const { zilvoToken } = await chrome.storage.local.get({ zilvoToken: '' });
      const cached = zilvoToken as string;
      if (cached) candidates.push({ token: cached, user: null });

      // A token left behind in a still-open tab is NOT a login. Without this
      // check the next lookup after a logout hands the old session straight
      // back and writes it into storage again.
      const logoutAt = await getLogoutAt();
      const revoked = candidates.filter(c => isRevokedByLogout(c.token, logoutAt));
      if (revoked.length) {
        console.warn('[Zilvo] getActiveToken — discarding', revoked.length, 'token(s) revoked by logout');
      }

      const usable = candidates.filter(
        c => !isTokenExpired(c.token) && !isRevokedByLogout(c.token, logoutAt)
      );
      if (!usable.length) {
        // Only purge for EXPIRY. Re-purging on a revoked token would rewrite the
        // tombstone on every lookup and fight the tab that still holds it.
        if (candidates.length && !revoked.length) {
          console.warn('[Zilvo] getActiveToken — every token expired, purging');
          await clearAllTokens();
        }
        return null;
      }

      // Freshest login wins — a stale tab can never override a newer session.
      usable.sort((a, b) => tokenIssuedAt(b.token) - tokenIssuedAt(a.token));
      const { token, user } = usable[0];
      console.log(
        '[Zilvo] getActiveToken — candidates:', candidates.length,
        '| chose userId:', decodeJwt(token)?.userId
      );

      // Keep the cache in step so nothing can drift back to an older token.
      if (token !== cached) {
        // Re-check the tombstone: a logout may have landed while this lookup was
        // reading the tabs, and writing here would undo the purge it just ran.
        if (isRevokedByLogout(token, await getLogoutAt())) {
          console.warn('[Zilvo] getActiveToken — logout landed mid-lookup, dropping token');
          return null;
        }
        const name = user?.name || user?.email || '';
        const email = user?.email || '';
        await chrome.storage.local.set({ zilvoToken: token, zilvoName: name, zilvoEmail: email });
        chrome.runtime
          .sendMessage({ action: 'authStateChanged', loggedIn: true, token, name, email })
          .catch(() => {});
      }
      return token;
    } catch (e) {
      console.error('getActiveToken failed:', e);
      return null;
    } finally {
      activeTokenLookup = null;
    }
  })();
  return activeTokenLookup;
}

/**
 * Adopt a token obtained outside the tab bridge (the in-popup email/password
 * login). Refuses expired tokens and never lets an older session overwrite a
 * newer one — without this, an in-popup login for account A and a website tab
 * on account B are two independent writers of the same storage key.
 */
export async function adoptToken(
  token: string,
  user?: { name?: string; email?: string; credits?: number }
): Promise<boolean> {
  if (!token || isTokenExpired(token)) {
    console.warn('[Zilvo] adoptToken — ignoring missing/expired token');
    return false;
  }
  const { zilvoToken } = await chrome.storage.local.get({ zilvoToken: '' });
  const cached = zilvoToken as string;
  if (cached && tokenIssuedAt(cached) > tokenIssuedAt(token)) {
    console.warn('[Zilvo] adoptToken — ignoring older token');
    return false;
  }
  // Reject the pre-logout token a stale tab keeps re-offering, but let a fresh
  // sign-in through — and lift the tombstone with it, so the new session is not
  // filtered out by the logout that preceded it.
  if (isRevokedByLogout(token, await getLogoutAt())) {
    console.warn('[Zilvo] adoptToken — ignoring token revoked by logout');
    return false;
  }
  const name = user?.name || user?.email || '';
  const email = user?.email || '';
  await chrome.storage.local.set({ zilvoToken: token, zilvoName: name, zilvoEmail: email });
  await chrome.storage.local.remove(LOGOUT_AT_KEY);
  chrome.runtime
    .sendMessage({ action: 'authStateChanged', loggedIn: true, token, name, email })
    .catch(() => {});
  return true;
}
