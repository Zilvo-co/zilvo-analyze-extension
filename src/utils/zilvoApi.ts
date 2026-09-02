import { getZilvoBaseUrl } from '../config';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ZilvoUser {
  name?: string;
  email?: string;
  credits?: number;
}

export interface LoginResult {
  token: string;
  user: ZilvoUser;
}

export interface PricingAction {
  action: string;
  creditCost: number;
  unit: string;
  label: string;
}

export interface PricingResponse {
  actions: PricingAction[];
  sellRatePerCredit: number;
}

export interface ChargeResult {
  ok: boolean;
  remaining?: number;
  cost?: number;
  txId?: string;
  error?: string;
}

export interface LedgerEntry {
  txId: string;
  action: string;
  cost: number;
  meta?: Record<string, unknown>;
  createdAt?: string;
}

export interface LedgerResponse {
  entries: LedgerEntry[];
  page?: number;
  hasMore?: boolean;
}

export interface ChargeOptions {
  units?: number;
  meta?: Record<string, unknown>;
  source?: string;
}

/** Error thrown by {@link zilvoFetch} carrying the HTTP status code. */
export interface ZilvoApiError extends Error {
  code?: number;
  /** On 402: credits needed for the action and the caller's current balance. */
  required?: number;
  remaining?: number;
}

// ── Low-level fetch ─────────────────────────────────────────────────────────────

function makeError(
  message: string,
  code?: number,
  extra?: { required?: number; remaining?: number }
): ZilvoApiError {
  const err = new Error(message) as ZilvoApiError;
  if (code != null) err.code = code;
  if (extra?.required != null) err.required = extra.required;
  if (extra?.remaining != null) err.remaining = extra.remaining;
  return err;
}

/**
 * Low-level Zilvo API fetch. Resolves the base URL from chrome.storage (via
 * `getZilvoBaseUrl`), sets JSON Content-Type, and adds a Bearer token when given.
 * Throws a {@link ZilvoApiError} with `.code` on 401 (session expired) / 402
 * (insufficient credits), or a generic error on other non-2xx responses.
 */
export async function zilvoFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<T> {
  const baseUrl = await getZilvoBaseUrl();

  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });

  if (res.status === 401) throw makeError('Session expired', 401);
  if (res.status === 402) {
    // Insufficient credits — parse required/remaining so the UI can prompt a top-up.
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      required?: number;
      remaining?: number;
    };
    throw makeError(body.error || 'Insufficient credits', 402, {
      required: body.required,
      remaining: body.remaining,
    });
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw makeError(body.error || `Request failed (${res.status})`, res.status);
  }

  return (await res.json().catch(() => ({}))) as T;
}

// ── High-level endpoints ─────────────────────────────────────────────────────────

/** POST /api/auth/login */
export async function login(email: string, password: string): Promise<LoginResult> {
  return zilvoFetch<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

/** GET /api/credits → current credit balance. */
export async function getCredits(token: string): Promise<number> {
  const data = await zilvoFetch<{ credits?: number }>('/api/credits', {}, token);
  return data.credits ?? 0;
}

/** GET /api/me → the authenticated user. */
export async function getMe(token: string): Promise<ZilvoUser> {
  return zilvoFetch<ZilvoUser>('/api/me', {}, token);
}

/** GET /api/pricing (public) → catalog of billable actions + sell rate. */
export async function getPricing(): Promise<PricingResponse> {
  return zilvoFetch<PricingResponse>('/api/pricing');
}

/**
 * Convenience helper: resolve the credit cost of a single action from
 * /api/pricing. Returns `fallback` (default 0) if the action is missing or the
 * request fails, so callers never break on pricing lookups.
 */
export async function getActionCost(action: string, fallback = 0): Promise<number> {
  try {
    const pricing = await getPricing();
    const match = pricing.actions.find(a => a.action === action);
    return match?.creditCost ?? fallback;
  } catch {
    return fallback;
  }
}

/** POST /api/auth/logout */
export async function logout(token: string): Promise<void> {
  await zilvoFetch('/api/auth/logout', { method: 'POST' }, token);
}

/** GET /api/credits/ledger?page=&action= */
export async function getLedger(
  token: string,
  opts: { page?: number; action?: string } = {}
): Promise<LedgerResponse> {
  const params = new URLSearchParams();
  if (opts.page != null) params.set('page', String(opts.page));
  if (opts.action) params.set('action', opts.action);
  const qs = params.toString();
  return zilvoFetch<LedgerResponse>(`/api/credits/ledger${qs ? `?${qs}` : ''}`, {}, token);
}

/**
 * POST /api/credits/charge — client-side credit charge. For future use; the
 * server already charges `ci.analyze` inside /api/company-intelligence/analyze,
 * so this must NOT be used for that action.
 */
export async function chargeCredits(
  token: string,
  action: string,
  opts: ChargeOptions = {}
): Promise<ChargeResult> {
  return zilvoFetch<ChargeResult>(
    '/api/credits/charge',
    {
      method: 'POST',
      body: JSON.stringify({
        action,
        units: opts.units ?? 1,
        meta: opts.meta ?? {},
        source: opts.source ?? 'extension',
      }),
    },
    token
  );
}
