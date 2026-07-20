// Content script running on zilvo.co — syncs login/logout state to this extension.
// Mirrors the same logic in zilvo-extension/zilvoSync.js but uses separate message
// actions so both extensions can run side-by-side without interfering.

(function () {
  const TOKEN_KEY = 'token';
  const USER_KEY  = 'user';

  function getStoredAuth(): { token: string | null; user: Record<string, unknown> | null } {
    const token = localStorage.getItem(TOKEN_KEY) || null;
    let user: Record<string, unknown> | null = null;
    const raw = localStorage.getItem(USER_KEY);
    if (raw) {
      try { user = JSON.parse(raw); } catch (_) {}
    }
    return { token, user };
  }

  function syncAuthState() {
    const { token, user } = getStoredAuth();
    if (token) {
      chrome.runtime.sendMessage({ action: 'websiteLogin', token, user }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({ action: 'websiteLogout' }).catch(() => {});
    }
  }

  // Sync immediately on page load
  syncAuthState();

  // Poll localStorage every 2s — catches login/logout triggered by React state changes
  let lastToken = localStorage.getItem(TOKEN_KEY);
  setInterval(() => {
    const current = localStorage.getItem(TOKEN_KEY);
    if (current !== lastToken) {
      lastToken = current;
      syncAuthState();
    }
  }, 2000);

  // Catch cross-tab auth changes
  window.addEventListener('storage', (e) => {
    if ([TOKEN_KEY, USER_KEY].includes(e.key ?? '')) syncAuthState();
  });

  // Re-sync when user switches back to a zilvo.co tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncAuthState();
  });

  // React app posts this after completing a login
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'zilvo_auth_login') syncAuthState();
  });

  // Handle messages from the background service worker
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'getAuthToken') {
      const token = localStorage.getItem(TOKEN_KEY) || null;
      let user: Record<string, unknown> | null = null;
      try { user = JSON.parse(localStorage.getItem(USER_KEY) || ''); } catch (_) {}
      sendResponse({ token, user });
      return true;
    }
    if (request.action === 'clearWebsiteAuth') {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      document.cookie = 'token=; path=/; max-age=0; SameSite=Lax';
      location.href = '/';
    }
  });
})();
