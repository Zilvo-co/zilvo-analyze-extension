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
    } else if (d.type === 'zilvo_open_analyze') {
      // "Open in Zilvo Analyze" on an extraction page. The web app cannot talk
      // to the extension directly (no externally_connectable), so the request
      // rides the same page->content-script->background bridge auth uses.
      //
      // The ack is what tells the page the extension is installed at all: no
      // reply within its timeout and it falls back to written instructions.
      chrome.runtime
        .sendMessage({
          action: 'ZILVO_OPEN_ANALYZE',
          extractionId: String(d.extractionId || ''),
          extractionName: String(d.extractionName || ''),
        })
        .then((res) => {
          window.postMessage(
            { type: 'zilvo_open_analyze_ack', opened: !!(res && res.opened) },
            window.location.origin
          );
        })
        .catch(() => {
          // Background asleep or extension reloading — stay silent and let the
          // page time out into its fallback.
        });
    }
  });
})();
