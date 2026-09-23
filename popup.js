/**
 * popup.js — 4-tab popup controller
 *
 * Tab 0 (lists)       — ICP analysis of a whole LinkedIn extraction
 * Tab 1 (linkedin)    — LinkedIn company auto-detect + analyze
 * Tab 2 (website)     — Website auto-detect + analyze
 * Tab 3 (manual)      — Bulk CSV upload for LinkedIn & website URLs
 */

import { isValidLinkedInCompanyUrl } from './helpers/utils.js';
import { getStoredAuth, updateStoredCredits } from './helpers/auth.js';
import { API, APP, apiUrl, appUrl } from './helpers/constants.js';

const $ = id => document.getElementById(id);

// ─── Shared state ─────────────────────────────────────────────────────────────
let _detection = null; // result from GET_TAB_DETECTION
let _activeTab  = 'lists';

// ─── Init (deferred to end of file so all const declarations are initialized) ─

// ═══════════════════════════════════════════════════════════════════════════════
// TAB BAR
// ═══════════════════════════════════════════════════════════════════════════════

function initTabBar() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  _activeTab = name;
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name)
  );
  document.querySelectorAll('.tab-content').forEach(el =>
    el.classList.toggle('hidden', el.id !== `tab-${name}`)
  );
  // Auth overlay: visible on CI tabs only when not logged in
  syncAuthOverlay();
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

// /login is a web page on the app host, not an API route — using the API base
// here sent users to https://api.zilvo.co/login, which 404s.
const ZILVO_LOGIN_URL = appUrl(APP.login);

/**
 * Point every [data-zilvo-link] anchor at the configured app host.
 *
 * These used to be absolute https://zilvo.co/... hrefs baked into popup.html,
 * so they ignored the configured environment entirely — pointing at production
 * while everything else talked to localhost, and at the marketing host rather
 * than the app host even in production.
 */
function applyZilvoLinks() {
  for (const el of document.querySelectorAll('[data-zilvo-link]')) {
    const path = APP[el.dataset.zilvoLink];
    if (path) el.href = appUrl(path);
  }
}

const authOverlay  = $('auth-overlay');
const loginBtn     = $('login-btn');
const userBadge    = $('user-badge');
const userCredits  = $('user-credits');
const refreshBtn   = $('refresh-btn');

async function initAuth() {
  loginBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: ZILVO_LOGIN_URL });
  });

  refreshBtn.addEventListener('click', async () => {
    resetAllDetection();
    await runDetection();
  });

  // Live updates from background
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.action === 'CI_AUTO_STATUS')    onAutoScrapeStatus(msg);
    if (msg.action === 'ZILVO_AUTH_SYNCED') onAuthSynced(msg);
  });

  icpSelect.addEventListener('change', onIcpChange);

  // ICPs are authored in the web app, so the empty state just sends the user
  // to My ICP. Opening a tab closes the popup; the list is re-fetched on the
  // next open, so the new ICP shows up without any extra refresh wiring.
  icpAddBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: appUrl(APP.icp) });
  });

  const auth = await getStoredAuth();
  if (auth?.token) {
    showUserBadge(auth.user);
    await initIcpSelector();
    // Before detection, so a pending "Open in Zilvo Analyze" wins over the
    // auto-switch that would otherwise move the user to the LinkedIn tab.
    // applyPendingList force-loads the lists itself, so only load here when
    // there was no pending request — otherwise every open fetched twice.
    const jumped = await applyPendingList();
    if (!jumped) await loadLists();
    await runDetection();
  }
  syncAuthOverlay();
}

function syncAuthOverlay() {
  // Every tab needs an account, so the overlay is purely a login gate.
  const loggedIn   = !userBadge.classList.contains('hidden');
  const showOverlay = !loggedIn;

  authOverlay.classList.toggle('hidden', !showOverlay);

  // When the auth overlay is visible, hide all tab content so the login
  // screen fills the full extension. Restore the active tab when logged in.
  document.querySelectorAll('.tab-content').forEach(el => {
    if (showOverlay) {
      el.classList.add('hidden');
    } else {
      el.classList.toggle('hidden', el.id !== `tab-${_activeTab}`);
    }
  });
}

function showUserBadge(user) {
  userBadge.classList.remove('hidden');
  userCredits.textContent = `${user?.credits ?? '—'} cr`;
}

function hideUserBadge() {
  userBadge.classList.add('hidden');
}

async function onAuthSynced(msg) {
  if (msg.loggedOut) {
    hideUserBadge();
    // Hide the selector too: the ICPs belong to the account that just signed
    // out, and the next account's list may be completely different.
    _icps = [];
    setIcpState('hidden');
    syncAuthOverlay();
    resetAllDetection();
  } else {
    showUserBadge(msg.user);
    await initIcpSelector();
    syncAuthOverlay();
    // A user who clicked "Open in Zilvo Analyze" while signed out lands here
    // after logging in — honour that request instead of dropping it.
    const jumped = await applyPendingList();
    if (!jumped) await loadLists({ force: true });
    if (!_detection) await runDetection();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ICP SELECTOR — which positioning an analysis is scored against
// ═══════════════════════════════════════════════════════════════════════════════
//
// Picking one makes it the ACCOUNT default (same endpoint the web app's My ICP
// page calls), so the extension and the dashboard can never disagree about the
// active positioning. `zilvoIcpId` is mirrored into chrome.storage because
// background.js reads it when it POSTs the analysis.

const ICP_KEY   = 'zilvoIcpId';
const icpBar    = $('icp-bar');
const icpPicker = $('icp-picker');
const icpSelect = $('icp-select');
const icpEmpty  = $('icp-empty');
const icpAddBtn = $('icp-add-btn');
const icpError  = $('icp-error');

let _icps = [];

function showIcpError(message) {
  icpError.textContent = message;
  icpError.classList.toggle('hidden', !message);
}

/**
 * Show the bar in one of its two states, or hide it entirely.
 * `state` is 'picker' (account has ICPs), 'empty' (none yet) or 'hidden'.
 */
function setIcpState(state) {
  icpBar.classList.toggle('hidden', state === 'hidden');
  icpPicker.classList.toggle('hidden', state !== 'picker');
  icpEmpty.classList.toggle('hidden', state !== 'empty');
}

function renderIcpOptions() {
  // No "(default)" marker: the selected ICP *is* the default, so the label
  // would follow the selection around and read as noise.
  icpSelect.innerHTML = '';
  for (const icp of _icps) {
    const option = document.createElement('option');
    option.value = icp._id;
    option.textContent = icp.name;
    icpSelect.appendChild(option);
  }
}

async function initIcpSelector() {
  const auth = await getStoredAuth();
  if (!auth?.token) { setIcpState('hidden'); return; }

  let list;
  try {
    const res = await fetch(apiUrl(API.icp), {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    list = await res.json();
  } catch (err) {
    // A failed lookup is not worth an error banner over the whole panel —
    // analysis still works, it just scores against the account default. Stay
    // hidden rather than showing the empty state: a network blip is not
    // evidence the account has no ICPs, and "+ Add ICP" would be a lie.
    console.warn('[Zilvo] ICP list failed —', err.message);
    setIcpState('hidden');
    return;
  }

  _icps = Array.isArray(list) ? list : [];

  // No positionings yet: offer the way to create one instead of hiding the bar
  // outright, which left no hint that fit scoring existed at all.
  if (!_icps.length) {
    await chrome.storage.local.remove(ICP_KEY);
    showIcpError('');
    setIcpState('empty');
    return;
  }

  renderIcpOptions();

  // The account default wins over the last local pick: it is the same
  // isDefault the My ICP page writes, so a change made in the web app shows up
  // here instead of being shadowed by a stale local value.
  const { [ICP_KEY]: stored } = await chrome.storage.local.get({ [ICP_KEY]: '' });
  const keep =
    _icps.find(i => i.isDefault)?._id ||
    (stored && _icps.some(i => i._id === stored) ? stored : '') ||
    _icps[0]._id;

  icpSelect.value = keep;
  await chrome.storage.local.set({ [ICP_KEY]: keep });
  showIcpError('');
  setIcpState('picker');
}

async function onIcpChange() {
  const id       = icpSelect.value;
  const previous = _icps.find(i => i.isDefault)?._id || '';
  const auth     = await getStoredAuth();

  showIcpError('');
  // Mirror first so an analysis started before the save lands still uses the
  // ICP the user just picked.
  await chrome.storage.local.set({ [ICP_KEY]: id });
  if (!auth?.token) return;

  icpSelect.disabled = true;
  try {
    const res = await fetch(`${apiUrl(API.icp)}/${encodeURIComponent(id)}/default`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _icps = _icps.map(i => ({ ...i, isDefault: i._id === id }));
  } catch (err) {
    // Roll back rather than leave the panel showing a default the account does
    // not have — the divergence stays invisible until an analysis is scored
    // against the wrong positioning.
    console.warn('[Zilvo] set default ICP failed —', err.message);
    if (previous) {
      icpSelect.value = previous;
      await chrome.storage.local.set({ [ICP_KEY]: previous });
    }
    showIcpError('Could not set default — try again.');
  } finally {
    icpSelect.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DETECTION (shared between both CI tabs)
// ═══════════════════════════════════════════════════════════════════════════════

async function runDetection() {
  showDetectionLoading();

  const result = await chrome.runtime.sendMessage({ action: 'GET_TAB_DETECTION' });
  _detection = result;

  // Auto-switch to the relevant tab based on what was detected — but never
  // away from a list the user is part-way through setting up.
  if (_listsBusy || _selectedList) {
    // leave the Lists tab alone
  } else if (result.type === 'LINKEDIN_COMPANY') {
    switchTab('linkedin');
  } else if (result.type === 'WEBSITE' || result.type === 'WEBSITE_WITH_LINKEDIN') {
    switchTab('website');
  }

  applyLinkedInDetection(result);
  applyWebsiteDetection(result);

  // Check if background already auto-scraped this tab
  const session = await getSessionScrape();
  if (session && session.tabId === result.tabId) {
    if (session.status === 'IN_PROGRESS') {
      setLiAnalyzeState(true);
    } else if (session.status === 'DONE') {
      showLiResult('success', 'Auto-analyzed! Results are in your Zilvo Dashboard.');
      updateCreditsDisplay(session.creditsRemaining);
    } else if (session.status === 'ERROR') {
      _lastLiAttempt = autoLiAttempt(session.linkedinUrl || result.linkedinUrl);
      showLiResult('error', session.error || 'Auto-analysis failed.');
    }
  }
}

function showDetectionLoading() {
  $('li-detect-loading').classList.remove('hidden');
  $('li-detect-found').classList.add('hidden');
  $('li-detect-none').classList.add('hidden');
  $('li-analyze-btn').classList.add('hidden');

  $('web-detect-loading').classList.remove('hidden');
  $('web-detect-found').classList.add('hidden');
  $('web-detect-is-linkedin').classList.add('hidden');
  $('web-detect-none').classList.add('hidden');
  $('web-analyze-btn').classList.add('hidden');
}

function resetAllDetection() {
  showDetectionLoading();
  hideLiResult();
  hideWebResult();
  _detection = null;
}

// ── LinkedIn tab detection UI ─────────────────────────────────────────────────

function applyLinkedInDetection(d) {
  $('li-detect-loading').classList.add('hidden');

  if (d.type === 'LINKEDIN_COMPANY') {
    $('li-detect-found').classList.remove('hidden');
    $('li-detect-url').textContent = d.linkedinUrl || '';
    $('li-auto-status').classList.add('hidden');
    $('li-analyze-btn').classList.remove('hidden');
    $('li-analyze-text').textContent = 'Analyze Company';
  } else {
    $('li-detect-none').classList.remove('hidden');
    // Still allow manual input — no analyze button for auto
  }

  // Wire listeners (once)
  wireLinkedInTab();
}

let _liWired = false;
function wireLinkedInTab() {
  if (_liWired) return;
  _liWired = true;

  $('li-analyze-btn').addEventListener('click', () => handleLiAnalyze(null));

  $('li-retry-btn').addEventListener('click', () => {
    if (_lastLiAttempt) runLiAnalyze(_lastLiAttempt, 'retry');
  });

  $('li-manual-toggle').addEventListener('click', () =>
    toggleSection($('li-manual-body'), $('li-manual-chevron'), $('li-manual-toggle'))
  );
  $('li-manual-clear').addEventListener('click', () => {
    $('li-manual-url').value = '';
    $('li-manual-error').textContent = '';
  });
  $('li-manual-btn').addEventListener('click', () =>
    handleLiAnalyze($('li-manual-url').value.trim())
  );
  $('li-manual-url').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLiAnalyze($('li-manual-url').value.trim());
  });
}

// What the last LinkedIn analyze asked for, so "Try again" repeats THAT
// request. Also set for a failed AUTO-analysis, which the user never started by
// hand and so has nothing else to click. Token excluded on purpose — it is
// re-read at send time so a retry after re-login uses the current session.
let _lastLiAttempt = null;

/** The attempt that would re-run an auto-analysis of `linkedinUrl`. */
function autoLiAttempt(linkedinUrl) {
  if (!linkedinUrl) return null;
  // Deliberately the URL form, not the tab form: it opens a fresh /about/ tab
  // rather than depending on the user still sitting on the page that failed.
  return { action: 'ANALYZE_COMPANY_URL', linkedinUrl, userInputField: linkedinUrl };
}

async function handleLiAnalyze(overrideUrl) {
  $('li-manual-error').textContent = '';

  let attempt;
  if (overrideUrl) {
    if (!isValidLinkedInCompanyUrl(overrideUrl)) {
      $('li-manual-error').textContent = 'Please enter a valid LinkedIn company URL.';
      return;
    }
    attempt = { action: 'ANALYZE_COMPANY_URL', linkedinUrl: overrideUrl, userInputField: overrideUrl };
  } else {
    if (!_detection || _detection.type !== 'LINKEDIN_COMPANY') return;
    attempt = { action: 'ANALYZE_COMPANY', tabId: _detection.tabId, userInputField: _detection.linkedinUrl };
  }

  await runLiAnalyze(attempt, 'main');
}

/**
 * Send one LinkedIn analyze. `source` only decides which button shows the
 * spinner — both disable the whole set so a retry cannot race the original.
 */
async function runLiAnalyze(attempt, source) {
  const auth = await getStoredAuth();
  if (!auth?.token) { syncAuthOverlay(); return; }

  _lastLiAttempt = attempt;
  hideLiResult();
  setLiAnalyzeState(true, source);
  const result = await requestAnalyze({ ...attempt, token: auth.token });
  setLiAnalyzeState(false, source);

  if (result.success) {
    _lastLiAttempt = null;
    updateCreditsDisplay(result.creditsRemaining);
    showLiResult('success', 'Analysis started! View results in your Zilvo Dashboard.');
    // Update button label
    if ($('li-analyze-btn')) $('li-analyze-text').textContent = 'Re-analyze';
  } else {
    showLiResult('error', analyzeErrorText(result));
  }
}

/**
 * Send an analyze request and ALWAYS come back with a result object.
 *
 * chrome.runtime.sendMessage rejects when the MV3 service worker is torn down
 * mid-request, and resolves `undefined` when no listener replies. Both used to
 * escape the bare `await` at the call sites: the line that re-enabled the
 * button never ran, so the spinner span forever and no reason was ever shown.
 */
async function requestAnalyze(message) {
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result) {
      console.error('[Zilvo] analyze: no response from background for', message.action);
      return { success: false, error: 'The extension background stopped responding. Reopen the panel and try again.' };
    }
    if (!result.success) console.error('[Zilvo] analyze failed:', result);
    return result;
  } catch (err) {
    console.error('[Zilvo] analyze request failed:', err);
    return { success: false, error: err?.message || 'Could not reach the extension background.' };
  }
}

/** Failure text for the UI: the reason, plus the HTTP status when there is one. */
function analyzeErrorText(result) {
  const reason = result?.error || 'Analysis failed. Please try again.';
  return result?.status ? `${reason} (HTTP ${result.status})` : reason;
}

function setLiAnalyzeState(on, source = 'main') {
  const btn = $('li-analyze-btn');
  const manBtn = $('li-manual-btn');
  const retBtn = $('li-retry-btn');
  if (btn) btn.disabled = on;
  if (manBtn) manBtn.disabled = on;
  if (retBtn) retBtn.disabled = on;

  const mainBusy  = on && source === 'main';
  const retryBusy = on && source === 'retry';
  $('li-analyze-text').textContent = mainBusy ? 'Analyzing…' : (
    _detection?.type === 'LINKEDIN_COMPANY' ? 'Re-analyze' : 'Analyze Company'
  );
  $('li-analyze-spinner').style.display = mainBusy  ? 'inline-block' : 'none';
  $('li-retry-text').textContent        = retryBusy ? 'Retrying…' : 'Try again';
  $('li-retry-spinner').style.display   = retryBusy ? 'inline-block' : 'none';
}

function showLiResult(type, text) {
  const card = $('li-result-card');
  const msg  = $('li-result-msg');
  card.classList.remove('hidden');
  msg.className   = `result-msg result-${type}`;
  msg.textContent = text;
  // Offer the retry only where it means something: a failure we still know how
  // to repeat.
  $('li-retry-btn').classList.toggle('hidden', type !== 'error' || !_lastLiAttempt);
}

function hideLiResult() {
  $('li-result-card').classList.add('hidden');
  $('li-retry-btn').classList.add('hidden');
}

// ── Website tab detection UI ──────────────────────────────────────────────────

function applyWebsiteDetection(d) {
  $('web-detect-loading').classList.add('hidden');

  if (d.type === 'WEBSITE' || d.type === 'WEBSITE_WITH_LINKEDIN') {
    $('web-detect-found').classList.remove('hidden');
    $('web-detect-url').textContent = truncateUrl(d.websiteUrl || d.currentUrl || '');
    $('web-analyze-btn').classList.remove('hidden');
    $('web-analyze-text').textContent = 'Analyze Website';
  } else if (d.type === 'LINKEDIN_COMPANY') {
    $('web-detect-is-linkedin').classList.remove('hidden');
  } else {
    $('web-detect-none').classList.remove('hidden');
  }

  wireWebsiteTab();
}

let _webWired = false;
function wireWebsiteTab() {
  if (_webWired) return;
  _webWired = true;

  $('web-analyze-btn').addEventListener('click', () => handleWebAnalyze(null));

  $('web-retry-btn').addEventListener('click', () => {
    if (_lastWebAttempt) runWebAnalyze(_lastWebAttempt, 'retry');
  });

  $('web-manual-toggle').addEventListener('click', () =>
    toggleSection($('web-manual-body'), $('web-manual-chevron'), $('web-manual-toggle'))
  );
  $('web-manual-clear').addEventListener('click', () => {
    $('web-manual-url').value = '';
    $('web-manual-error').textContent = '';
  });
  $('web-manual-btn').addEventListener('click', () =>
    handleWebAnalyze($('web-manual-url').value.trim())
  );
  $('web-manual-url').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleWebAnalyze($('web-manual-url').value.trim());
  });
}

// What the last website analyze actually asked for, so "Try again" repeats THAT
// request rather than whatever the panel happens to be detecting now. Cleared
// on success — a finished analysis has nothing left to retry.
//
// The token is deliberately NOT stored: it is re-read at send time, so a retry
// after a re-login uses the current session instead of the expired one.
let _lastWebAttempt = null;

async function handleWebAnalyze(overrideUrl) {
  $('web-manual-error').textContent = '';

  let websiteUrl, linkedinUrl, userInputField, tabId;
  if (overrideUrl) {
    if (!overrideUrl.startsWith('http')) {
      $('web-manual-error').textContent = 'Enter a valid URL starting with https://';
      return;
    }
    websiteUrl     = overrideUrl;
    linkedinUrl    = null;
    userInputField = overrideUrl;
    tabId          = null;
  } else {
    if (!_detection || (_detection.type !== 'WEBSITE' && _detection.type !== 'WEBSITE_WITH_LINKEDIN')) return;
    websiteUrl     = _detection.websiteUrl || _detection.currentUrl;
    linkedinUrl    = _detection.linkedinUrl || null;
    userInputField = _detection.currentUrl || websiteUrl;
    tabId          = _detection?.tabId ?? null;
  }

  await runWebAnalyze({ websiteUrl, linkedinUrl, userInputField, tabId }, 'main');
}

/**
 * Send one website analyze. `source` only decides which button shows the
 * spinner — both disable the whole set so a retry cannot race the original.
 */
async function runWebAnalyze(attempt, source) {
  const auth = await getStoredAuth();
  if (!auth?.token) { syncAuthOverlay(); return; }

  _lastWebAttempt = attempt;
  hideWebResult();
  setWebAnalyzeState(true, source);
  const result = await requestAnalyze({ action: 'ANALYZE_WEBSITE', ...attempt, token: auth.token });
  setWebAnalyzeState(false, source);

  if (result.success) {
    _lastWebAttempt = null;
    updateCreditsDisplay(result.creditsRemaining);
    showWebResult('success', 'Analysis started! View results in your Zilvo Dashboard.');
  } else {
    showWebResult('error', analyzeErrorText(result));
  }
}

function setWebAnalyzeState(on, source = 'main') {
  const btn    = $('web-analyze-btn');
  const manBtn = $('web-manual-btn');
  const retBtn = $('web-retry-btn');
  if (btn)    btn.disabled    = on;
  if (manBtn) manBtn.disabled = on;
  if (retBtn) retBtn.disabled = on;

  const mainBusy  = on && source === 'main';
  const retryBusy = on && source === 'retry';
  $('web-analyze-text').textContent       = mainBusy  ? 'Analyzing…' : 'Analyze Website';
  $('web-analyze-spinner').style.display  = mainBusy  ? 'inline-block' : 'none';
  $('web-retry-text').textContent         = retryBusy ? 'Retrying…' : 'Try again';
  $('web-retry-spinner').style.display    = retryBusy ? 'inline-block' : 'none';
}

function showWebResult(type, text) {
  const card = $('web-result-card');
  const msg  = $('web-result-msg');
  card.classList.remove('hidden');
  msg.className   = `result-msg result-${type}`;
  msg.textContent = text;
  // Offer the retry only where it means something: a failure we still know how
  // to repeat.
  $('web-retry-btn').classList.toggle('hidden', type !== 'error' || !_lastWebAttempt);
}

function hideWebResult() {
  $('web-result-card').classList.add('hidden');
  $('web-retry-btn').classList.add('hidden');
}

// ── Auto-scrape status listener (from background.js) ─────────────────────────

function onAutoScrapeStatus(msg) {
  if (msg.status === 'IN_PROGRESS') {
    setLiAnalyzeState(true);
    hideLiResult();
    $('li-auto-status').classList.remove('hidden');
    $('li-auto-dot').className = 'auto-dot auto-dot-active';
    $('li-auto-label').textContent = 'Auto-analyzing…';
  } else if (msg.status === 'DONE') {
    setLiAnalyzeState(false);
    $('li-auto-status').classList.remove('hidden');
    $('li-auto-dot').className = 'auto-dot auto-dot-done';
    $('li-auto-label').textContent = 'Auto-analyzed';
    $('li-analyze-text').textContent = 'Re-analyze';
    showLiResult('success', 'Auto-analyzed! Results are ready in your Zilvo Dashboard.');
    updateCreditsDisplay(msg.creditsRemaining);
  } else if (msg.status === 'ERROR') {
    setLiAnalyzeState(false);
    $('li-auto-status').classList.add('hidden');
    // An auto-analysis is not something the user started, so without this the
    // error card has nothing to act on.
    _lastLiAttempt = autoLiAttempt(msg.linkedinUrl || _detection?.linkedinUrl);
    showLiResult('error', msg.error || 'Auto-analysis failed.');
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function getSessionScrape() {
  try {
    const r = await chrome.storage.session.get('lastCIScrape');
    return r.lastCIScrape ?? null;
  } catch { return null; }
}

function updateCreditsDisplay(credits) {
  if (credits == null) return;
  userCredits.textContent = `${credits} cr`;
  updateStoredCredits(credits);
}

function truncateUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname !== '/' ? u.pathname.slice(0, 28) : '';
    return u.hostname + path;
  } catch { return url.slice(0, 50); }
}

function toggleSection(bodyEl, chevronEl, triggerEl) {
  const isOpen = !bodyEl.classList.contains('hidden');
  bodyEl.classList.toggle('hidden', isOpen);
  chevronEl.classList.toggle('open', !isOpen);
  triggerEl.setAttribute('aria-expanded', String(!isOpen));
}

// ═══════════════════════════════════════════════════════════════════════════════
// LISTS TAB (ICP analysis of a LinkedIn extraction)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The user picks a list they already extracted and a Project, and Zilvo scores
// every distinct company behind it against that Project's ICP.
//
// The run is driven from HERE, not from the web app, for a concrete reason: a
// LinkedIn extraction gives us company URLs, and the analyzer needs each
// company's WEBSITE. Only this extension can open a LinkedIn company page to
// find one. So the web app educates and shows results; the extension starts the
// work — reusing the very same per-company pipeline the Upload tab already uses.

let _lists          = [];
let _selectedList   = null;
let _listsProjects  = [];
let _listsBusy      = false;
let _listsBatchId   = null;
/** First click on an already-analyzed list arms the button; second click runs. */
let _listsRerunArmed = false;

const PENDING_LIST_KEY = 'zilvo_pending_list';
/** A request older than this is stale — the user has moved on. Long enough to
 * survive the sign-in detour a logged-out click takes. */
const PENDING_LIST_TTL_MS = 10 * 60_000;

function initListsTab() {
  $('lists-refresh-btn').addEventListener('click', () => loadLists({ force: true }));
  $('lists-back-btn').addEventListener('click', () => selectList(null));
  $('lists-progress-back-btn').addEventListener('click', () => selectList(null));
  $('lists-analyze-btn').addEventListener('click', () => handleListAnalyze());

  // An already-open panel reacts live to "Open in Zilvo Analyze".
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'ZILVO_OPEN_LIST') applyPendingList();
  });
}

/**
 * Jump to the list the web app asked for.
 *
 * "Open in Zilvo Analyze" on an extraction page stores the id; whether the panel
 * opened itself or the user clicked the toolbar icon afterwards, it lands here
 * and the right list is already selected. Consumed once, so reopening the panel
 * later does not drag the user back to an old list.
 */
async function applyPendingList() {
  const stored = (await chrome.storage.local.get(PENDING_LIST_KEY))[PENDING_LIST_KEY];
  if (!stored?.extractionId) return false;
  await chrome.storage.local.remove(PENDING_LIST_KEY);
  if (Date.now() - (stored.at ?? 0) > PENDING_LIST_TTL_MS) return false;

  switchTab('lists');
  await loadLists({ force: true });

  const match = _lists.find((l) => l.id === stored.extractionId);
  if (match) {
    await selectList(match);
  } else {
    // The list is gone (deleted, or another account) — say so rather than
    // silently showing the picker as if nothing was asked for.
    $('lists-error').textContent = `Could not find "${stored.extractionName || 'that extraction'}" in this account.`;
    $('lists-error').classList.remove('hidden');
  }
  // Either way the lists were just (re)loaded — the caller must not fetch again.
  return true;
}

/** Authenticated GET against the Zilvo API, returning parsed JSON or null. */
async function zilvoGet(path) {
  const auth = await getStoredAuth();
  if (!auth?.token) return null;
  try {
    const res = await fetch(apiUrl(path), {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (!res.ok) {
      console.warn('[Zilvo] GET', path, '->', res.status);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('[Zilvo] GET', path, 'failed:', err);
    return null;
  }
}

async function loadLists({ force = false } = {}) {
  if (_lists.length && !force) return;

  $('lists-loading').classList.remove('hidden');
  $('lists-empty').classList.add('hidden');
  $('lists-error').classList.add('hidden');
  $('lists-items').classList.add('hidden');

  const data = await zilvoGet(API.extractionsForAnalysis);
  $('lists-loading').classList.add('hidden');

  if (!data) {
    $('lists-error').textContent = 'Could not load your extractions. Check your connection and try again.';
    $('lists-error').classList.remove('hidden');
    return;
  }

  _lists = data.extractions || [];
  if (!_lists.length) {
    $('lists-empty').classList.remove('hidden');
    return;
  }

  renderLists();
}

function renderLists() {
  const ul = $('lists-items');
  ul.innerHTML = '';

  for (const list of _lists) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lists-item';

    const name = document.createElement('span');
    name.className = 'lists-item-name';
    name.textContent = list.name;
    btn.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'lists-item-meta';
    // An account extraction has no people — every row is a company, so showing
    // "0 leads" would be noise.
    const counts = list.type === 'accounts'
      ? `${list.companies.toLocaleString()} companies`
      : `${list.leads.toLocaleString()} leads · ${list.companies.toLocaleString()} companies`;
    meta.appendChild(
      document.createTextNode(
        `${counts} · ` +
        new Date(list.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      )
    );

    // Say plainly whether this list was already analysed, so nobody pays twice.
    if (list.analysis?.started) {
      const chip = document.createElement('span');
      chip.className = 'lists-chip lists-chip-done';
      chip.textContent = `ICP analyzed ${list.analysis.completed}/${list.analysis.total}`;
      meta.appendChild(chip);
    }
    if (list.verificationStatus === 'COMPLETED') {
      const chip = document.createElement('span');
      chip.className = 'lists-chip lists-chip-verified';
      chip.textContent = 'Verified';
      meta.appendChild(chip);
    }
    btn.appendChild(meta);

    btn.addEventListener('click', () => selectList(list));
    li.appendChild(btn);
    ul.appendChild(li);
  }

  ul.classList.remove('hidden');
}

async function selectList(list) {
  if (_listsBusy) return;
  _selectedList = list;
  _listsRerunArmed = false;

  // A stale "could not find …" from an earlier deep link must not sit over
  // whichever view is shown next.
  $('lists-error').classList.add('hidden');
  $('lists-picker-card').classList.toggle('hidden', !!list);
  $('lists-selected-card').classList.toggle('hidden', !list);
  $('lists-progress-card').classList.add('hidden');
  $('lists-analyze-btn').textContent = 'Analyze ICP Fit';

  if (!list) return;

  // A paid re-run deserves a warning before the button does anything.
  $('lists-rerun-note').classList.toggle('hidden', !list.analysis?.started);

  $('lists-sel-name').textContent = list.name;
  $('lists-sel-counts').textContent = list.type === 'accounts'
    ? `${list.companies.toLocaleString()} companies`
    : `${list.leads.toLocaleString()} leads · ${list.companies.toLocaleString()} unique companies`;

  await loadProjects();
}

/**
 * The account's projects. A Project carries the ICP a run is scored against, so
 * picking one here is what makes the result meaningful.
 */
async function loadProjects() {
  const select = $('lists-project-select');
  const data = await zilvoGet(API.projects);
  _listsProjects = data?.projects || [];

  select.innerHTML = '';
  const empty = !_listsProjects.length;
  $('lists-project-empty').classList.toggle('hidden', !empty);
  select.classList.toggle('hidden', empty);
  $('lists-analyze-btn').disabled = empty;

  for (const project of _listsProjects) {
    const option = document.createElement('option');
    option.value = project._id;
    option.textContent = project.companyName || 'Untitled project';
    if (project._id === data?.activeId) option.selected = true;
    select.appendChild(option);
  }
}

async function handleListAnalyze() {
  if (_listsBusy || !_selectedList) return;

  const auth = await getStoredAuth();
  if (!auth?.token) return;

  const projectId = $('lists-project-select').value;
  if (!projectId) return;

  // Re-running an analyzed list charges again, so the first click only arms
  // the button — the warning note above it says why.
  if (_selectedList.analysis?.started && !_listsRerunArmed) {
    _listsRerunArmed = true;
    $('lists-analyze-btn').textContent = 'Click again to re-run (charges again)';
    return;
  }

  _listsBusy = true;
  $('lists-analyze-btn').disabled = true;
  $('lists-analyze-btn').textContent = 'Starting…';
  $('lists-back-btn').disabled = true;

  try {
    // Ask the server for the DISTINCT companies — two leads at the same
    // employer must not be analysed (or charged for) twice.
    const data = await zilvoGet(`${API.extractions}/${_selectedList.id}/companies`);

    // null = the request failed; an empty array = the list really has nothing
    // to analyze. Reporting a failure as "nothing to analyze" hides outages.
    if (!data) {
      $('lists-sel-counts').textContent =
        'Could not load the companies for this list. Check your connection and try again.';
      return;
    }
    const companies = data.companies || [];

    if (!companies.length) {
      $('lists-sel-counts').textContent =
        'No companies with a LinkedIn page in this list — nothing to analyze.';
      return;
    }

    $('lists-selected-card').classList.add('hidden');
    $('lists-progress-card').classList.remove('hidden');

    // One batch per run, so the whole list stays one group (and one CSV) on the
    // Analysis Jobs page — the same contract the Upload tab uses.
    _listsBatchId = `extraction-${_selectedList.id}-${Date.now().toString(36)}`;

    await runListJobs(companies, auth.token, projectId);
  } finally {
    _listsBusy = false;
    _listsRerunArmed = false;
    $('lists-analyze-btn').disabled = false;
    $('lists-analyze-btn').textContent = 'Analyze ICP Fit';
    $('lists-back-btn').disabled = false;
  }
}

/**
 * Run one company at a time through the existing per-company pipeline.
 *
 * Sequential on purpose: each job opens a LinkedIn tab and a website tab, and
 * running them in parallel is how you get rate-limited.
 */
async function runListJobs(companies, token, projectId) {
  const list = $('lists-results');
  list.innerHTML = '';

  const rows = companies.map((company) => {
    const li = document.createElement('li');
    li.className = 'bulk-result-item';

    const dot = document.createElement('span');
    dot.className = 'bulk-status-dot bulk-dot-pending';
    const name = document.createElement('span');
    name.className = 'bulk-item-url';
    name.textContent = company.name || company.linkedinUrl;
    const badge = document.createElement('span');
    badge.className = 'bulk-item-badge bulk-badge-pending';
    badge.textContent = 'Queued';

    li.append(dot, name, badge);
    list.appendChild(li);
    return { company, dot, badge };
  });

  const setRow = (row, state, label) => {
    row.dot.className = `bulk-status-dot bulk-dot-${state}`;
    row.badge.className = `bulk-item-badge bulk-badge-${state}`;
    row.badge.textContent = label;
  };

  let done = 0;
  let outOfCredits = false;
  $('lists-progress-fill').style.width = '0%';
  $('lists-progress-label').textContent = `0 / ${companies.length} companies`;

  for (const row of rows) {
    // Once the account is out of credits every further dispatch 402s too —
    // stop instead of marching the rest of the list into "Failed".
    if (outOfCredits) {
      setRow(row, 'error', 'Skipped — no credits');
      continue;
    }

    setRow(row, 'active', 'Analyzing…');

    const result = await requestAnalyze({
      action: 'ANALYZE_COMPANY_URL',
      linkedinUrl: row.company.linkedinUrl,
      token,
      userInputField: row.company.linkedinUrl,
      batchId: _listsBatchId,
      // What makes this job show up under the extraction, and be scored
      // against the project the user chose rather than whichever is active.
      run: {
        source: 'linkedin_extraction',
        sourceExtractionId: _selectedList.id,
        projectId,
      },
    });

    if (result?.status === 402) outOfCredits = true;
    setRow(
      row,
      result?.success ? 'done' : 'error',
      result?.success ? 'Queued' : outOfCredits ? 'Failed — no credits' : 'Failed'
    );

    done++;
    $('lists-progress-fill').style.width = `${Math.round((done / companies.length) * 100)}%`;
    $('lists-progress-label').textContent = `${done} / ${companies.length} companies`;

    if (typeof result?.creditsRemaining === 'number') {
      await updateStoredCredits(result.creditsRemaining);
      userCredits.textContent = `${result.creditsRemaining} cr`;
    }
  }

  $('lists-progress-label').textContent = outOfCredits
    ? `${done} / ${companies.length} dispatched — stopped: not enough credits. Top up on Zilvo and retry.`
    : `${done} / ${companies.length} companies queued — analysis continues in the cloud.`;
  // The list it was started from now shows analysis progress.
  await loadLists({ force: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL TAB (CSV bulk upload)
// ═══════════════════════════════════════════════════════════════════════════════

let _bulkLinkedInUrls = [];
let _bulkWebsiteUrls  = [];
let _bulkRunning      = false;

// The rows that errored in the last pass, paired with the <li> they own, plus
// the batch they belong to. "Retry failed" re-runs exactly these — the rows
// that already succeeded are never re-sent, so a retry cannot double-charge.
let _bulkFailed  = [];
let _bulkBatchId = null;
let _bulkTotal   = 0;

function initManualTab() {
  $('li-csv-input').addEventListener('change',  e => handleCsvUpload(e, 'linkedin'));
  $('web-csv-input').addEventListener('change', e => handleCsvUpload(e, 'website'));
  $('li-csv-clear-btn').addEventListener('click',  () => clearBulkCsv('linkedin'));
  $('web-csv-clear-btn').addEventListener('click', () => clearBulkCsv('website'));
  $('li-csv-example-btn').addEventListener('click', () => downloadExampleCsv('linkedin'));
  $('web-csv-example-btn').addEventListener('click', () => downloadExampleCsv('website'));
  $('bulk-run-btn').addEventListener('click', handleBulkAnalyze);
  $('bulk-retry-btn').addEventListener('click', handleBulkRetry);
}

function downloadExampleCsv(type) {
  const isLinkedIn = type === 'linkedin';
  const content = isLinkedIn
    ? [
        'https://www.linkedin.com/company/google/',
        'https://www.linkedin.com/company/microsoft/',
        'https://www.linkedin.com/company/apple/',
        'https://www.linkedin.com/company/amazon/',
        'https://www.linkedin.com/company/meta/',
      ].join('\n')
    : [
        'https://google.com',
        'https://microsoft.com',
        'https://apple.com',
        'https://amazon.com',
        'https://meta.com',
      ].join('\n');
  const filename = isLinkedIn ? 'linkedin-urls-example.csv' : 'website-urls-example.csv';
  const blob = new Blob([content], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Extract URLs from raw CSV text. Handles quoted values and multi-column rows. */
function parseUrlsFromCsv(text) {
  const urlPattern = /https?:\/\/[^\s,"'\t]+/gi;
  const urls = [];
  for (const line of text.split(/\r?\n/)) {
    const matches = line.match(urlPattern);
    if (matches) urls.push(matches[0].replace(/[/]+$/, '').trim()); // first URL per row, strip trailing slash
  }
  return [...new Set(urls)]; // deduplicate
}

// The `accept` attribute on the file input is only a hint — the OS picker lets
// the user switch to "All files" and choose anything. An .xlsx picked that way
// used to be read as text, match zero URLs, and report NOTHING: the skipped
// count was 0, so no message was shown and the preview simply stayed hidden.
const CSV_EXTENSIONS         = ['.csv', '.txt'];
const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods', '.numbers'];
const MAX_CSV_BYTES          = 2 * 1024 * 1024; // 2 MB

/** Why this file cannot be parsed, or null when it can be. */
function csvRejectionReason(file) {
  const name = (file.name || '').toLowerCase();

  if (SPREADSHEET_EXTENSIONS.some(ext => name.endsWith(ext))) {
    return 'Excel files aren\u2019t supported. In Excel choose File → Save As → CSV, then upload the .csv.';
  }
  if (!CSV_EXTENSIONS.some(ext => name.endsWith(ext))) {
    return 'Unsupported file type. Upload a .csv file with one URL per row.';
  }
  if (file.size === 0) {
    return 'That file is empty.';
  }
  if (file.size > MAX_CSV_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Upload a CSV under 2 MB.`;
  }
  return null;
}

/** Report `message` and drop whatever was previously loaded for this list. */
function failCsvUpload(type, message) {
  const isLinkedIn = type === 'linkedin';
  const prefix     = isLinkedIn ? 'li' : 'web';

  if (isLinkedIn) _bulkLinkedInUrls = [];
  else            _bulkWebsiteUrls  = [];

  renderBulkPreview(prefix, [], isLinkedIn ? 'LinkedIn' : 'website');
  $(`${prefix}-csv-clear-btn`).classList.add('hidden');
  $(`${prefix}-csv-error`).textContent = message;
  updateBulkRunBtn();
}

function handleCsvUpload(e, type) {
  const input = e.target;
  const file  = input.files[0];
  // Clear the selection so re-picking the SAME filename fires `change` again —
  // otherwise a user who fixes their file and re-uploads it sees nothing happen.
  input.value = '';
  if (!file) return;

  const isLinkedIn = type === 'linkedin';
  const prefix     = isLinkedIn ? 'li' : 'web';
  const errorEl    = $(`${prefix}-csv-error`);
  errorEl.textContent = '';

  const rejection = csvRejectionReason(file);
  if (rejection) { failCsvUpload(type, rejection); return; }

  const reader = new FileReader();
  reader.onload = ev => {
    const allUrls = parseUrlsFromCsv(ev.target.result);

    // Nothing URL-shaped anywhere in the file — a wrong file, a header-only
    // export, or a column of bare domains with no scheme.
    if (allUrls.length === 0) {
      failCsvUpload(type, 'No URLs found in this file. Each row needs a full URL starting with http:// or https://.');
      return;
    }

    const valid = isLinkedIn
      ? allUrls.filter(u => isValidLinkedInCompanyUrl(u))
      : allUrls.filter(u => u.startsWith('http'));

    if (isLinkedIn) _bulkLinkedInUrls = valid;
    else            _bulkWebsiteUrls  = valid;

    // URLs were found but none survived validation — say so instead of leaving
    // an empty preview and a hidden Analyze button to explain themselves.
    if (valid.length === 0) {
      failCsvUpload(type, isLinkedIn
        ? `Found ${allUrls.length} URL(s), but none are LinkedIn company URLs (linkedin.com/company/…).`
        : `Found ${allUrls.length} URL(s), but none are valid website URLs.`);
      return;
    }

    const skipped = allUrls.length - valid.length;
    if (skipped > 0) {
      errorEl.textContent = isLinkedIn
        ? `${skipped} row(s) skipped — not valid LinkedIn company URLs.`
        : `${skipped} row(s) skipped — not valid URLs.`;
    }

    renderBulkPreview(prefix, valid, isLinkedIn ? 'LinkedIn' : 'website');
    updateBulkRunBtn();
  };
  reader.onerror = () => failCsvUpload(type, 'Could not read that file. Upload a .csv saved as plain text.');
  reader.readAsText(file);
}

function renderBulkPreview(prefix, urls, label) {
  const hasUrls = urls.length > 0;
  $(`${prefix}-csv-preview`).classList.toggle('hidden', !hasUrls);
  $(`${prefix}-csv-clear-btn`).classList.toggle('hidden', !hasUrls);

  if (!hasUrls) {
    $(`${prefix}-csv-zone-label`).textContent = 'Click to upload CSV';
    return;
  }

  $(`${prefix}-csv-zone-label`).textContent = `${urls.length} ${label} URL${urls.length !== 1 ? 's' : ''} loaded`;
  $(`${prefix}-csv-count`).textContent = `${urls.length} URL${urls.length !== 1 ? 's' : ''} found`;

  const listEl = $(`${prefix}-csv-list`);
  listEl.innerHTML = '';
  const preview = urls.slice(0, 5);
  for (const url of preview) {
    const li = document.createElement('li');
    li.className  = 'bulk-url-item';
    li.title      = url;
    li.textContent = truncateUrl(url);
    listEl.appendChild(li);
  }
  if (urls.length > 5) {
    const li = document.createElement('li');
    li.className  = 'bulk-url-item bulk-url-more';
    li.textContent = `+${urls.length - 5} more…`;
    listEl.appendChild(li);
  }
}

function clearBulkCsv(type) {
  const isLinkedIn = type === 'linkedin';
  const prefix     = isLinkedIn ? 'li' : 'web';

  if (isLinkedIn) { _bulkLinkedInUrls = []; $('li-csv-input').value = ''; }
  else            { _bulkWebsiteUrls  = []; $('web-csv-input').value = ''; }

  $(`${prefix}-csv-preview`).classList.add('hidden');
  $(`${prefix}-csv-clear-btn`).classList.add('hidden');
  $(`${prefix}-csv-zone-label`).textContent = 'Click to upload CSV';
  $(`${prefix}-csv-error`).textContent = '';
  updateBulkRunBtn();
}

function updateBulkRunBtn() {
  // Loading or clearing a CSV invalidates the previous run's failures: the rows
  // still on screen are no longer what "Retry failed" would send.
  _bulkFailed = [];
  $('bulk-retry-btn').classList.add('hidden');

  const hasData = _bulkLinkedInUrls.length > 0 || _bulkWebsiteUrls.length > 0;
  const total   = _bulkLinkedInUrls.length + _bulkWebsiteUrls.length;
  $('bulk-run-btn').classList.toggle('hidden', !hasData);
  $('bulk-run-text').textContent = hasData ? `Analyze All (${total})` : 'Analyze All';
}

/** One result row. Text goes in via textContent — a CSV supplies these URLs. */
function makeBulkRow(job) {
  const li  = document.createElement('li');
  li.className = 'bulk-result-item';

  const dot = document.createElement('span');
  dot.className = 'bulk-status-dot bulk-dot-pending';

  const url = document.createElement('span');
  url.className  = 'bulk-item-url';
  url.title      = job.url;
  url.textContent = truncateUrl(job.url);

  const badge = document.createElement('span');
  badge.className  = 'bulk-item-badge bulk-badge-pending';
  badge.textContent = 'Pending';

  li.append(dot, url, badge);
  return li;
}

function setBulkRowState(itemEl, state, label) {
  itemEl.querySelector('.bulk-status-dot').className   = `bulk-status-dot bulk-dot-${state}`;
  itemEl.querySelector('.bulk-item-badge').className   = `bulk-item-badge bulk-badge-${state}`;
  itemEl.querySelector('.bulk-item-badge').textContent = label;
}

/** Drop the previous failure reason so a retry does not stack a second line. */
function clearBulkRowReason(itemEl) {
  itemEl.querySelector('.bulk-item-reason')?.remove();
  itemEl.removeAttribute('title');
}

function setBulkBusy(on, source) {
  _bulkRunning = on;
  $('bulk-run-btn').disabled   = on;
  $('bulk-retry-btn').disabled = on;

  const mainBusy  = on && source === 'main';
  const retryBusy = on && source === 'retry';
  $('bulk-run-spinner').style.display   = mainBusy  ? 'inline-block' : 'none';
  $('bulk-run-text').textContent        = mainBusy  ? 'Analyzing…' : `Analyze All (${_bulkTotal})`;
  $('bulk-retry-spinner').style.display = retryBusy ? 'inline-block' : 'none';
  $('bulk-retry-text').textContent      = retryBusy
    ? 'Retrying…'
    : `Retry failed (${_bulkFailed.length})`;
  $('bulk-retry-btn').classList.toggle('hidden', on || _bulkFailed.length === 0);
}

/**
 * Run `entries` ({ job, itemEl }) one at a time, updating each row in place.
 * Leaves _bulkFailed holding whatever failed THIS pass, so a retry of a retry
 * narrows down rather than repeating the original set.
 */
async function runBulkJobs(entries, token, source) {
  const failed = [];
  let done = 0;

  $('bulk-progress-fill').style.width  = '0%';
  $('bulk-progress-label').textContent = `0 / ${entries.length} completed`;

  for (const entry of entries) {
    const { job, itemEl } = entry;
    clearBulkRowReason(itemEl);
    setBulkRowState(itemEl, 'active', 'Analyzing…');
    itemEl.scrollIntoView({ block: 'nearest' });

    const result = job.type === 'linkedin'
      ? await requestAnalyze({
          action:        'ANALYZE_COMPANY_URL',
          linkedinUrl:   job.url,
          token,
          userInputField: job.url,
          batchId:       _bulkBatchId,
        })
      : await requestAnalyze({
          action:        'ANALYZE_WEBSITE',
          websiteUrl:    job.url,
          linkedinUrl:   null,
          token,
          tabId:         null,
          userInputField: job.url,
          batchId:       _bulkBatchId,
        });

    done++;
    $('bulk-progress-fill').style.width  = `${Math.round((done / entries.length) * 100)}%`;
    $('bulk-progress-label').textContent = `${done} / ${entries.length} completed`;

    if (result.success) {
      setBulkRowState(itemEl, 'done', 'Done');
      if (result.creditsRemaining != null) updateCreditsDisplay(result.creditsRemaining);
    } else {
      setBulkRowState(itemEl, 'error', 'Error');
      // The reason used to live only in the row's `title`, so it was invisible
      // unless you hovered. Put it on a second line under the URL.
      const reason = analyzeErrorText(result);
      const reasonEl = document.createElement('span');
      reasonEl.className  = 'bulk-item-reason';
      reasonEl.textContent = reason;
      itemEl.appendChild(reasonEl);
      itemEl.title = reason;
      failed.push(entry);
    }
  }

  _bulkFailed = failed;
  setBulkBusy(false, source);

  // Set the dashboard link to point directly to the jobs page so they can download the CSV batch
  $('bulk-dashboard-link').href = appUrl(APP.jobs);
  $('bulk-dashboard-link').classList.remove('hidden');
}

async function handleBulkAnalyze() {
  if (_bulkRunning) return;

  const auth = await getStoredAuth();
  if (!auth?.token) { syncAuthOverlay(); return; }

  const jobs = [
    ..._bulkLinkedInUrls.map(url => ({ type: 'linkedin', url })),
    ..._bulkWebsiteUrls.map(url  => ({ type: 'website',  url })),
  ];
  if (!jobs.length) return;

  _bulkBatchId = `bulk-${Date.now().toString(36)}`;
  _bulkTotal   = jobs.length;
  _bulkFailed  = [];

  $('bulk-progress-card').classList.remove('hidden');
  $('bulk-dashboard-link').classList.add('hidden');
  setBulkBusy(true, 'main');

  // Build per-item rows
  const listEl = $('bulk-results-list');
  listEl.innerHTML = '';
  const entries = jobs.map(job => {
    const itemEl = makeBulkRow(job);
    listEl.appendChild(itemEl);
    return { job, itemEl };
  });

  await runBulkJobs(entries, auth.token, 'main');
}

/**
 * Re-run only the rows that errored, under the ORIGINAL batch id so the whole
 * CSV stays one batch on the dashboard and its export is not split in two.
 */
async function handleBulkRetry() {
  if (_bulkRunning || !_bulkFailed.length) return;

  const auth = await getStoredAuth();
  if (!auth?.token) { syncAuthOverlay(); return; }

  const entries = _bulkFailed;
  setBulkBusy(true, 'retry');
  await runBulkJobs(entries, auth.token, 'retry');
}

// ─── Auto-detect on tab navigation ───────────────────────────────────────────

function initTabWatcher() {
  // Re-detect when the current tab finishes navigating to a new URL
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    // Ignore background tabs that aren't the one we're watching
    if (_detection?.tabId && tabId !== _detection.tabId) return;
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || activeTab.id !== tabId) return;
    const auth = await getStoredAuth();
    if (!auth?.token) return;
    resetAllDetection();
    await runDetection();
  });

  // Re-detect when the user switches to a different browser tab
  chrome.tabs.onActivated.addListener(async () => {
    const auth = await getStoredAuth();
    if (!auth?.token) return;
    resetAllDetection();
    await runDetection();
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
  applyZilvoLinks();
  initTabBar();
  initListsTab();
  initManualTab();
  initTabWatcher();
  await initAuth();
})();
