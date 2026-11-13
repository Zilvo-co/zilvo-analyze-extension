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

/** One analysis costs 5 credits (`ci.analyze` in the platform catalog). */
export const CREDITS_PER_ANALYSIS = 5;

const TOKEN_KEY = 'zilvo_guest_token';
const QUOTA_KEY = 'zilvo_guest_quota';

async function readToken() {
  const { [TOKEN_KEY]: token } = await chrome.storage.local.get(TOKEN_KEY);
  return token || '';
}

/** Persist the guest token + the latest quota snapshot from any response. */
async function persist(payload) {
  const patch = {};
  if (typeof payload?.guestToken === 'string' && payload.guestToken) {
    patch[TOKEN_KEY] = payload.guestToken;
  }
  const quota = quotaOf(payload);
  if (quota) patch[QUOTA_KEY] = quota;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

function quotaOf(data) {
  if (!data) return null;
  const source = data.quota && Number.isFinite(Number(data.quota.remaining)) ? data.quota : data;
  if (!Number.isFinite(Number(source.remaining))) return null;
  return {
    limit: Number(source.limit) || 50,
    used: Number(source.used) || 0,
    remaining: Number(source.remaining) || 0,
    requiresLogin: !!source.requiresLogin,
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
  await chrome.storage.local.remove([TOKEN_KEY, QUOTA_KEY]);
}
