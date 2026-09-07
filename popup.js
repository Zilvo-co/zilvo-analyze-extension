/**
 * popup.js — 3-tab popup controller
 *
 * Tab 1 (linkedin)    — LinkedIn company auto-detect + analyze
 * Tab 2 (website)     — Website auto-detect + analyze
 * Tab 3 (manual)      — Bulk CSV upload for LinkedIn & website URLs
 */

import { isValidLinkedInCompanyUrl } from './helpers/utils.js';
import { getStoredAuth, updateStoredCredits } from './helpers/auth.js';
import { ZILVO_APP } from './helpers/constants.js';

const $ = id => document.getElementById(id);

// ─── Shared state ─────────────────────────────────────────────────────────────
let _detection = null; // result from GET_TAB_DETECTION
let _activeTab  = 'linkedin';

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

// /login is a web page on the app host, not an API route — ZILVO_API here
// sent users to https://api.zilvo.co/login, which 404s.
const ZILVO_LOGIN_URL = `${ZILVO_APP}/login`;

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

  const auth = await getStoredAuth();
  if (auth?.token) {
    showUserBadge(auth.user);
    await runDetection();
  }
  syncAuthOverlay();
}

function syncAuthOverlay() {
  const isCI       = _activeTab === 'linkedin' || _activeTab === 'website' || _activeTab === 'manual';
  const loggedIn   = !userBadge.classList.contains('hidden');
  const showOverlay = isCI && !loggedIn;

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
    syncAuthOverlay();
    resetAllDetection();
  } else {
    showUserBadge(msg.user);
    syncAuthOverlay();
    if (!_detection) await runDetection();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DETECTION (shared between both CI tabs)
// ═══════════════════════════════════════════════════════════════════════════════

async function runDetection() {
  showDetectionLoading();

  const result = await chrome.runtime.sendMessage({ action: 'GET_TAB_DETECTION' });
  _detection = result;

  // Auto-switch to the relevant tab based on what was detected
  if (result.type === 'LINKEDIN_COMPANY') {
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

async function handleLiAnalyze(overrideUrl) {
  $('li-manual-error').textContent = '';
  hideLiResult();

  const auth = await getStoredAuth();
  if (!auth?.token) { syncAuthOverlay(); return; }

  let message;

  if (overrideUrl) {
    if (!isValidLinkedInCompanyUrl(overrideUrl)) {
      $('li-manual-error').textContent = 'Please enter a valid LinkedIn company URL.';
      return;
    }
    message = { action: 'ANALYZE_COMPANY_URL', linkedinUrl: overrideUrl, token: auth.token, userInputField: overrideUrl };
  } else {
    if (!_detection || _detection.type !== 'LINKEDIN_COMPANY') return;
    message = { action: 'ANALYZE_COMPANY', tabId: _detection.tabId, token: auth.token, userInputField: _detection.linkedinUrl };
  }

  setLiAnalyzeState(true);
  const result = await chrome.runtime.sendMessage(message);
  setLiAnalyzeState(false);

  if (result.success) {
    updateCreditsDisplay(result.creditsRemaining);
    showLiResult('success', 'Analysis started! View results in your Zilvo Dashboard.');
    // Update button label
    if ($('li-analyze-btn')) $('li-analyze-text').textContent = 'Re-analyze';
  } else {
    showLiResult('error', result.error || 'Analysis failed. Please try again.');
  }
}

function setLiAnalyzeState(on) {
  const btn = $('li-analyze-btn');
  const manBtn = $('li-manual-btn');
  if (btn) btn.disabled = on;
  if (manBtn) manBtn.disabled = on;
  $('li-analyze-text').textContent = on ? 'Analyzing…' : (
    _detection?.type === 'LINKEDIN_COMPANY' ? 'Re-analyze' : 'Analyze Company'
  );
  $('li-analyze-spinner').style.display = on ? 'inline-block' : 'none';
}

function showLiResult(type, text) {
  const card = $('li-result-card');
  const msg  = $('li-result-msg');
  card.classList.remove('hidden');
  msg.className   = `result-msg result-${type}`;
  msg.textContent = text;
}

function hideLiResult() {
  $('li-result-card').classList.add('hidden');
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

async function handleWebAnalyze(overrideUrl) {
  $('web-manual-error').textContent = '';
  hideWebResult();

  const auth = await getStoredAuth();
  if (!auth?.token) { syncAuthOverlay(); return; }

  let websiteUrl, linkedinUrl;

  let userInputField;
  if (overrideUrl) {
    if (!overrideUrl.startsWith('http')) {
      $('web-manual-error').textContent = 'Enter a valid URL starting with https://';
      return;
    }
    websiteUrl     = overrideUrl;
    linkedinUrl    = null;
    userInputField = overrideUrl;
  } else {
    if (!_detection || (_detection.type !== 'WEBSITE' && _detection.type !== 'WEBSITE_WITH_LINKEDIN')) return;
    websiteUrl     = _detection.websiteUrl || _detection.currentUrl;
    linkedinUrl    = _detection.linkedinUrl || null;
    userInputField = _detection.currentUrl || websiteUrl;
  }

  setWebAnalyzeState(true);
  const result = await chrome.runtime.sendMessage({
    action:      'ANALYZE_WEBSITE',
    websiteUrl,
    linkedinUrl,
    token:       auth.token,
    tabId:       overrideUrl ? null : (_detection?.tabId ?? null),
    userInputField,
  });
  setWebAnalyzeState(false);

  if (result.success) {
    updateCreditsDisplay(result.creditsRemaining);
    showWebResult('success', 'Analysis started! View results in your Zilvo Dashboard.');
  } else {
    showWebResult('error', result.error || 'Analysis failed. Please try again.');
  }
}

function setWebAnalyzeState(on) {
  const btn    = $('web-analyze-btn');
  const manBtn = $('web-manual-btn');
  if (btn) btn.disabled = on;
  if (manBtn) manBtn.disabled = on;
  $('web-analyze-text').textContent     = on ? 'Analyzing…' : 'Analyze Website';
  $('web-analyze-spinner').style.display = on ? 'inline-block' : 'none';
}

function showWebResult(type, text) {
  const card = $('web-result-card');
  const msg  = $('web-result-msg');
  card.classList.remove('hidden');
  msg.className   = `result-msg result-${type}`;
  msg.textContent = text;
}

function hideWebResult() {
  $('web-result-card').classList.add('hidden');
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
// MANUAL TAB (CSV bulk upload)
// ═══════════════════════════════════════════════════════════════════════════════

let _bulkLinkedInUrls = [];
let _bulkWebsiteUrls  = [];
let _bulkRunning      = false;

function initManualTab() {
  $('li-csv-input').addEventListener('change',  e => handleCsvUpload(e, 'linkedin'));
  $('web-csv-input').addEventListener('change', e => handleCsvUpload(e, 'website'));
  $('li-csv-clear-btn').addEventListener('click',  () => clearBulkCsv('linkedin'));
  $('web-csv-clear-btn').addEventListener('click', () => clearBulkCsv('website'));
  $('li-csv-example-btn').addEventListener('click', () => downloadExampleCsv('linkedin'));
  $('web-csv-example-btn').addEventListener('click', () => downloadExampleCsv('website'));
  $('bulk-run-btn').addEventListener('click', handleBulkAnalyze);
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

function handleCsvUpload(e, type) {
  const file = e.target.files[0];
  if (!file) return;

  const isLinkedIn = type === 'linkedin';
  const errorEl    = $(isLinkedIn ? 'li-csv-error' : 'web-csv-error');
  errorEl.textContent = '';

  const reader = new FileReader();
  reader.onload = ev => {
    const allUrls = parseUrlsFromCsv(ev.target.result);

    if (isLinkedIn) {
      _bulkLinkedInUrls = allUrls.filter(u => isValidLinkedInCompanyUrl(u));
      const skipped = allUrls.length - _bulkLinkedInUrls.length;
      if (skipped > 0) errorEl.textContent = `${skipped} row(s) skipped — not valid LinkedIn company URLs.`;
      renderBulkPreview('li', _bulkLinkedInUrls, 'LinkedIn');
    } else {
      _bulkWebsiteUrls = allUrls.filter(u => u.startsWith('http'));
      const skipped = allUrls.length - _bulkWebsiteUrls.length;
      if (skipped > 0) errorEl.textContent = `${skipped} row(s) skipped — not valid URLs.`;
      renderBulkPreview('web', _bulkWebsiteUrls, 'website');
    }

    updateBulkRunBtn();
  };
  reader.onerror = () => { errorEl.textContent = 'Failed to read file.'; };
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
  const hasData = _bulkLinkedInUrls.length > 0 || _bulkWebsiteUrls.length > 0;
  const total   = _bulkLinkedInUrls.length + _bulkWebsiteUrls.length;
  $('bulk-run-btn').classList.toggle('hidden', !hasData);
  $('bulk-run-text').textContent = hasData ? `Analyze All (${total})` : 'Analyze All';
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

  const batchId = `bulk-${Date.now().toString(36)}`;

  _bulkRunning = true;
  $('bulk-run-btn').disabled           = true;
  $('bulk-run-spinner').style.display  = 'inline-block';
  $('bulk-run-text').textContent       = 'Analyzing…';
  $('bulk-progress-card').classList.remove('hidden');
  $('bulk-dashboard-link').classList.add('hidden');
  $('bulk-progress-fill').style.width  = '0%';
  $('bulk-progress-label').textContent = `0 / ${jobs.length} completed`;

  // Build per-item rows
  const listEl = $('bulk-results-list');
  listEl.innerHTML = '';
  const itemEls = jobs.map((job, i) => {
    const li = document.createElement('li');
    li.className = 'bulk-result-item';
    li.innerHTML = `
      <span class="bulk-status-dot bulk-dot-pending"></span>
      <span class="bulk-item-url" title="${job.url}">${truncateUrl(job.url)}</span>
      <span class="bulk-item-badge bulk-badge-pending">Pending</span>
    `;
    listEl.appendChild(li);
    return li;
  });

  let done = 0;
  for (let i = 0; i < jobs.length; i++) {
    const job    = jobs[i];
    const itemEl = itemEls[i];

    itemEl.querySelector('.bulk-status-dot').className   = 'bulk-status-dot bulk-dot-active';
    itemEl.querySelector('.bulk-item-badge').className   = 'bulk-item-badge bulk-badge-active';
    itemEl.querySelector('.bulk-item-badge').textContent = 'Analyzing…';
    itemEl.scrollIntoView({ block: 'nearest' });

    let result;
    try {
      if (job.type === 'linkedin') {
        result = await chrome.runtime.sendMessage({
          action:        'ANALYZE_COMPANY_URL',
          linkedinUrl:   job.url,
          token:         auth.token,
          userInputField: job.url,
          batchId,
        });
      } else {
        result = await chrome.runtime.sendMessage({
          action:        'ANALYZE_WEBSITE',
          websiteUrl:    job.url,
          linkedinUrl:   null,
          token:         auth.token,
          tabId:         null,
          userInputField: job.url,
          batchId,
        });
      }
    } catch (err) {
      result = { success: false, error: err.message };
    }

    done++;
    $('bulk-progress-fill').style.width  = `${Math.round((done / jobs.length) * 100)}%`;
    $('bulk-progress-label').textContent = `${done} / ${jobs.length} completed`;

    if (result.success) {
      itemEl.querySelector('.bulk-status-dot').className   = 'bulk-status-dot bulk-dot-done';
      itemEl.querySelector('.bulk-item-badge').className   = 'bulk-item-badge bulk-badge-done';
      itemEl.querySelector('.bulk-item-badge').textContent = 'Done';
      if (result.creditsRemaining != null) updateCreditsDisplay(result.creditsRemaining);
    } else {
      itemEl.querySelector('.bulk-status-dot').className   = 'bulk-status-dot bulk-dot-error';
      itemEl.querySelector('.bulk-item-badge').className   = 'bulk-item-badge bulk-badge-error';
      itemEl.querySelector('.bulk-item-badge').textContent = 'Error';
      itemEl.title = result.error || 'Analysis failed';
    }
  }

  _bulkRunning = false;
  $('bulk-run-btn').disabled           = false;
  $('bulk-run-spinner').style.display  = 'none';
  $('bulk-run-text').textContent       = `Analyze All (${jobs.length})`;
  
  // Set the dashboard link to point directly to the jobs page so they can download the CSV batch
  $('bulk-dashboard-link').href = `${ZILVO_APP}/tools/company-intelligence/jobs`;
  $('bulk-dashboard-link').classList.remove('hidden');
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
  initTabBar();
  initManualTab();
  initTabWatcher();
  await initAuth();
})();
