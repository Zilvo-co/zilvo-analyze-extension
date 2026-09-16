// content_zilvo.js — runs on every origin in the manifest's content_scripts
// matches: production AND localhost, since the manifest is static and cannot
// vary with ZILVO_ENV.
//
// Bridges the web app's localStorage auth into chrome.storage.local so the
// extension automatically reflects the user's logged-in state on the website.
//
// It deliberately does NOT decide whether a session should be adopted: it
// reports what it sees, and background.js drops the message unless the sending
// frame's origin is the ZILVO_APP this build talks to. That check belongs there
// because `sender.origin` comes from Chrome and cannot be forged by the page.

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
