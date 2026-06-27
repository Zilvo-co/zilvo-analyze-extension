// content_zilvo.js — runs on zilvo.co and localhost:3000
// Bridges the web app's localStorage auth into chrome.storage.local so the
// extension automatically reflects the user's logged-in state on the website.

(function () {
  function syncLogin(token, userRaw) {
    try {
      const user = JSON.parse(userRaw);
      chrome.runtime.sendMessage({ action: 'ZILVO_SYNC_AUTH', token, user }).catch(() => {});
    } catch {}
  }

  function syncLogout() {
    chrome.runtime.sendMessage({ action: 'ZILVO_SYNC_LOGOUT' }).catch(() => {});
  }

  // On page load: push whatever is currently in localStorage to the extension
  const token   = localStorage.getItem('token');
  const userRaw = localStorage.getItem('user');
  if (token && userRaw) {
    syncLogin(token, userRaw);
  } else {
    // Clear stale extension auth if the website has no session
    syncLogout();
  }

  // Login event: web app fires this via window.postMessage in useAuth.login()
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || typeof d !== 'object') return;

    if (d.type === 'zilvo_auth_login' && d.token) {
      syncLogin(d.token, localStorage.getItem('user'));
    } else if (d.type === 'zilvo_auth_logout') {
      syncLogout();
    }
  });
})();
