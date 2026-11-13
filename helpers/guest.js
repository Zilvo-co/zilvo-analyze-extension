/**
 * Guest (no-login) trial for the Company Analyzer.
 *
 * The marketing site's public analyzer exposes the same flow, and the extension
 * reuses it so a signed-out user gets the identical 50-credit trial:
 *
 *   GET  /api/public/company-analyzer/quota   → { limit, used, remaining, guestToken }
 *   POST /api/public/company-analyzer/analyze { url }   → { accepted: [{ jobId }], remaining }
 *   POST /api/public/company-analyzer/bulk    { urls }  → same shape
 *   GET  /api/public/company-analyzer/results?ids=…     → { results, quota, finished }
 *
 * The signed guest token is the credential (X-Guest-Token). It is kept in
 * chrome.storage so reopening the panel continues the same trial instead of
 * minting a fresh identity every time.
 */
import { API, apiUrl } from './constants.js';

/** Fallback only — the live value comes from the quota API (`creditCost`). */
export const CREDITS_PER_ANALYSIS = 5;

const TOKEN_KEY = 'zilvo_guest_token';
const QUOTA_KEY = 'zilvo_guest_quota';

// ── Shared guest identity ──────────────────────────────────────────────────
// chrome.storage.local is isolated per extension, so this extension and the
// LinkedIn scraper would otherwise mint two guest IDs for one browser. Both
// share the signed token through a cookie on the API origin. The platform keeps
// ONE GuestQuota row: the Analyze budget and the 50-row LinkedIn budget stay
// separate on that row.
const GUEST_COOKIE_URL = 'https://api.zilvo.co';
const GUEST_COOKIE_NAME = 'zilvo_guest';
const GUEST_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60;

async function readSharedGuestToken() {
  try {
    const cookie = await chrome.cookies.get({ url: GUEST_COOKIE_URL, name: GUEST_COOKIE_NAME });
    return cookie?.value || null;
  } catch {
    return null;
  }
}

async function writeSharedGuestToken(token) {
  if (!token) return;
  try {
    await chrome.cookies.set({
      url: GUEST_COOKIE_URL,
      name: GUEST_COOKIE_NAME,
      value: token,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + GUEST_COOKIE_TTL_SECONDS,
    });
  } catch {
    // The local token still works if the cookie API is unavailable.
  }
}

async function readLocalGuestToken() {
  const { [TOKEN_KEY]: token } = await chrome.storage.local.get(TOKEN_KEY);
  return token || null;
}

async function writeLocalGuestToken(token) {
  if (token) await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

/** Combined trial usage across BOTH products; used only to resolve a clash. */
async function guestUsageScore(token) {
  if (!token) return 0;
  const headers = { 'X-Guest-Token': token };
  const read = (url) =>
    fetch(url, { headers, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  const [li, ci] = await Promise.all([
    read(apiUrl('/api/linkedin/guest/quota')),
    read(apiUrl(API.guestQuota)),
  ]);
  return (Number(li?.used) || 0) + (Number(ci?.used) || 0);
}

function guestTokenIssuedAt(token) {
  try {
    const part = String(token).split('.')[1] || '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    return Number(JSON.parse(atob(padded)).iat) || 0;
  } catch {
    return 0;
  }
}

/**
 * Canonical token for this browser. If both extensions already hold a different
 * used token (e.g. the update arrives after both were used), keep the one with
 * more combined usage; the older token breaks a tie. The loser's trial usage is
 * abandoned — guest trials are ephemeral, and the alternative is two identities.
 */
async function resolveGuestToken() {
  const shared = await readSharedGuestToken();
  const local = await readLocalGuestToken();
  if (!shared) {
    if (local) {
      await writeSharedGuestToken(local);
      return local;
    }
    return null;
  }
  if (!local || local === shared) return shared;

  const [sharedScore, localScore] = await Promise.all([
    guestUsageScore(shared),
    guestUsageScore(local),
  ]);
  let winner = shared;
  if (localScore > sharedScore) winner = local;
  else if (localScore === sharedScore) {
    const sharedAt = guestTokenIssuedAt(shared);
    const localAt = guestTokenIssuedAt(local);
    if (localAt && (!sharedAt || localAt < sharedAt)) winner = local;
  }
  await writeSharedGuestToken(winner);
  await writeLocalGuestToken(winner);
  return winner;
}

async function readToken() {
  return (await resolveGuestToken()) || '';
}

/** Persist the guest token + the latest quota snapshot from any response. */
async function persist(payload) {
  const patch = {};
  if (typeof payload?.guestToken === 'string' && payload.guestToken) {
    patch[TOKEN_KEY] = payload.guestToken;
    await writeSharedGuestToken(payload.guestToken);
  }
  const quota = quotaOf(payload);
  if (quota) {
    // Merge: a submission response only carries remaining/used, so keep the
    // cached creditCost/signupCredits instead of wiping them.
    const { [QUOTA_KEY]: prev } = await chrome.storage.local.get(QUOTA_KEY);
    patch[QUOTA_KEY] = { ...(prev || {}), ...quota };
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

function quotaOf(data) {
  if (!data) return null;
  const source = data.quota && Number.isFinite(Number(data.quota.remaining)) ? data.quota : data;
  if (!Number.isFinite(Number(source.remaining))) return null;
  // Submission/results responses keep the flat cost next to `quota`.
  const creditCost = Number(source.creditCost ?? data.creditCost);
  const signupCredits = Number(source.signupCredits ?? data.signupCredits);
  return {
    limit: Number(source.limit) || 50,
    used: Number(source.used) || 0,
    remaining: Number(source.remaining) || 0,
    requiresLogin: !!source.requiresLogin,
    ...(Number.isFinite(creditCost) && creditCost > 0 ? { creditCost } : {}),
    ...(Number.isFinite(signupCredits) && signupCredits > 0 ? { signupCredits } : {}),
  };
}

async function request(path, options = {}) {
  const token = await readToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['X-Guest-Token'] = token;

  const res = await fetch(apiUrl(path), { ...options, headers });
  const raw = await res.text().catch(() => '');
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (data) await persist(data);
  return { res, data, raw };
}

export async function getGuestToken() {
  return readToken();
}

/** Current trial balance. `null` means the guest API is unreachable. */
export async function getGuestQuota() {
  try {
    const { res, data } = await request(API.guestQuota, { cache: 'no-store' });
    if (!res.ok || !data) return null;
    return quotaOf(data);
  } catch {
    return null;
  }
}

export async function getStoredGuestQuota() {
  const { [QUOTA_KEY]: quota } = await chrome.storage.local.get(QUOTA_KEY);
  return quota || null;
}

/** Submit one website to the guest analyzer. */
export async function submitGuestAnalyze(url) {
  try {
    const { res, data, raw } = await request(API.guestAnalyze, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (res.ok && data) {
      const accepted = Array.isArray(data.accepted) ? data.accepted : [];
      return {
        ok: true,
        jobId: accepted[0]?.jobId || null,
        quota: quotaOf(data),
        requiresLogin: !!data.requiresLogin,
      };
    }
    return {
      ok: false,
      error:
        data?.error?.message ||
        data?.message ||
        raw ||
        `Analysis failed (HTTP ${res.status})`,
      requiresLogin: !!data?.requiresLogin,
      quota: quotaOf(data),
    };
  } catch (err) {
    return { ok: false, error: `Cannot reach Zilvo server: ${err.message}` };
  }
}

/** Poll a submitted guest analysis until it finishes (or the deadline). */
export async function pollGuestResults(ids, { timeoutMs = 90_000, intervalMs = 2_500 } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return { results: [], finished: false };
  const deadline = Date.now() + timeoutMs;
  let last = { results: [], finished: false };

  while (Date.now() < deadline) {
    try {
      const { res, data } = await request(
        `${API.guestResults}?ids=${encodeURIComponent(ids.join(','))}`,
        { cache: 'no-store' },
      );
      if (res.ok && data) {
        last = {
          results: Array.isArray(data.results) ? data.results : [],
          finished: !!data.finished,
          quota: quotaOf(data),
        };
        if (last.finished) return last;
      }
    } catch {
      // transient — keep polling until the deadline
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

/**
 * Import this browser's guest analyses into the account that just signed in.
 * Requires the normal user JWT plus the signed guest token.
 */
export async function claimGuestAnalyses(userToken) {
  const guestToken = await readToken();
  if (!userToken || !guestToken) return null;
  try {
    const res = await fetch(apiUrl(API.guestClaim), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ guestToken }),
    });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

/** Drop the guest trial after the user signs in (their account takes over). */
export async function clearGuestSession() {
  // Keep the shared cookie pointing at the (now claimed) guest identity, so the
  // other extension does not mint a fresh trial after logout.
  const token = await readLocalGuestToken();
  if (token) await writeSharedGuestToken(token);
  await chrome.storage.local.remove([TOKEN_KEY, QUOTA_KEY]);
}
