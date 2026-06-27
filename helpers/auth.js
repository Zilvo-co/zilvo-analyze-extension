/**
 * helpers/auth.js
 * JWT token + user profile storage for Zilvo auth in the extension.
 */

const AUTH_KEY = 'zilvo_auth';

export async function getStoredAuth() {
  const result = await chrome.storage.local.get(AUTH_KEY);
  return result[AUTH_KEY] ?? null;
}

export async function setStoredAuth(token, user) {
  await chrome.storage.local.set({ [AUTH_KEY]: { token, user } });
}

export async function clearStoredAuth() {
  await chrome.storage.local.remove(AUTH_KEY);
}

export async function updateStoredCredits(credits) {
  const auth = await getStoredAuth();
  if (!auth) return;
  await chrome.storage.local.set({
    [AUTH_KEY]: { ...auth, user: { ...auth.user, credits } },
  });
}
