/**
 * background.js — Service Worker
 *
 * Orchestrates the full LinkedIn → website screenshot pipeline:
 *   1. Open LinkedIn company page in a background tab
 *   2. Inject an extractor to pull company name + website URL
 *   3. Open the company website in a temporary popup window
 *   4. Wait for full page load
 *   5. Capture a full-page screenshot via Chrome DevTools Protocol
 *   6. Download the PNG, save a history entry, broadcast status to popup
 *
 * All communication with popup.js uses chrome.runtime.sendMessage / onMessage.
 */

import { sleep, normalizeLinkedInUrl, isRetryableError } from './helpers/utils.js';
import { API, apiUrl, ZILVO_APP } from './helpers/constants.js';
import { getStoredAuth, updateStoredCredits } from './helpers/auth.js';

// Open the side panel (right-side panel) when the toolbar icon is clicked.
// Falls back silently in environments where the sidePanel API isn't available.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// ─── Auto-scrape: detect LinkedIn company pages as they load ──────────────────
// Tracks recently auto-scraped canonical URLs to prevent duplicate submissions
// within a 5-minute cooldown window.
const _recentlyScraped = new Map(); // canonicalUrl → timestamp
const AUTO_SCRAPE_COOLDOWN_MS = 5 * 60 * 1000;

// Tab IDs opened by the extension itself for manual analysis — skip auto-scrape for these.
const _managedTabIds = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url) return;
  if (_managedTabIds.has(tabId)) return; // opened by us — manual analysis handles it
  autoScrapeLinkedInPage(tabId, tab.url).catch(() => {});
});

async function autoScrapeLinkedInPage(tabId, url) {
  const liMatch = url.match(/linkedin\.com\/company\/([a-zA-Z0-9\-_.%]+)/);
  if (!liMatch) return;

  const slug         = liMatch[1].replace(/\/$/, '');
  const canonicalUrl = `https://www.linkedin.com/company/${slug}/`;

  // Cooldown: don't re-submit the same company within 5 minutes
  const lastTs = _recentlyScraped.get(canonicalUrl);
  if (lastTs && Date.now() - lastTs < AUTO_SCRAPE_COOLDOWN_MS) return;

  const auth = await getStoredAuth();
  if (!auth?.token) {
    // Show badge so the user knows a LinkedIn page was detected but they need to sign in
    _setBadge(tabId, 'LI', '#f59e0b');
    return;
  }

  // Signal analysis in progress
  _setBadge(tabId, '...', '#6c63ff');

  // Store in-progress state so popup can reflect it immediately
  await _setSessionScrape({ tabId, linkedinUrl: canonicalUrl, status: 'IN_PROGRESS' });
  broadcast({ action: 'CI_AUTO_STATUS', status: 'IN_PROGRESS', linkedinUrl: canonicalUrl });

  // Brief settle only — extractUntilFound() below is what waits for LinkedIn's
  // React content, so a long fixed sleep here just delayed every analysis.
  await sleep(TAB_SETTLE_DELAY);

  // Confirm tab is still on the same page (user may have navigated away)
  try {
    const current = await chrome.tabs.get(tabId);
    if (!current.url?.includes(slug)) {
      chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
      return;
    }
  } catch { return; }

  _recentlyScraped.set(canonicalUrl, Date.now());

  const result = await analyzeLinkedInCompany(tabId, auth.token, canonicalUrl);

  // Only a SUCCESSFUL run earns the cooldown. Keeping it after a failure meant
  // the stored ERROR was replayed into the panel on every open, and no reload
  // could retry for five minutes.
  if (!result.success) _recentlyScraped.delete(canonicalUrl);

  if (result.success) {
    _setBadge(tabId, '✓', '#4caf50');
    if (result.creditsRemaining != null) await updateStoredCredits(result.creditsRemaining);
    await _setSessionScrape({ tabId, linkedinUrl: canonicalUrl, status: 'DONE', ...result, timestamp: Date.now() });
    broadcast({ action: 'CI_AUTO_STATUS', status: 'DONE', linkedinUrl: canonicalUrl, ...result });
  } else {
    _setBadge(tabId, '!', '#ef5350');
    await _setSessionScrape({ tabId, linkedinUrl: canonicalUrl, status: 'ERROR', error: result.error, timestamp: Date.now() });
    // Carry the URL: without it the panel knows an auto-analysis failed but not
    // WHICH company, so it cannot offer to run it again.
    broadcast({ action: 'CI_AUTO_STATUS', status: 'ERROR', linkedinUrl: canonicalUrl, error: result.error });
  }

  // Auto-clear badge after 8 s
  setTimeout(() => { chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}); }, 8_000);
}

// ── Storage helpers ──────────────────────────────────────────────────────────
// Reads and writes go through helpers/auth.js. The background used to keep its
// own copies that hit chrome.storage directly, which would now skip the
// origin check getStoredAuth() enforces — a foreign token would stay live here
// while the popup rejected it.
const _AUTH_KEY = 'zilvo_auth';
// The extraction the web app asked us to open, held until the panel reads it.
const _PENDING_LIST_KEY = 'zilvo_pending_list';

async function _setSessionScrape(data) {
  try { await chrome.storage.session.set({ lastCIScrape: data }); } catch { /* session API may be unavailable */ }
}

function _setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
}

// ─── Tunable constants ────────────────────────────────────────────────────────
const LINKEDIN_LOAD_TIMEOUT  = 30_000;   // max ms to wait for LinkedIn tab to reach "complete"
const WEBSITE_LOAD_TIMEOUT   = 30_000;   // max ms to wait for company website tab
const LINKEDIN_SOFT_DEADLINE = 10_000;   // give up WAITING and extract anyway (SPA may never report "complete")
const WEBSITE_SOFT_DEADLINE  = 12_000;   // ditto for company websites
const WEBSITE_RENDER_DELAY   = 2_000;    // extra wait after "complete" for CSS / lazy images
const TAB_SETTLE_DELAY       = 1_000;    // brief pause before the first extraction attempt
const RETRY_LIMIT            = 2;        // total attempts (1 original + 1 retry)
const RETRY_BACKOFF_MS       = 2_500;    // wait between retry attempts

// Extraction polls instead of sleeping a fixed amount and hoping. LinkedIn
// hydrates the About panel AFTER the tab reports "complete", so a single shot
// at a fixed offset succeeded or failed run to run depending on nothing but
// network speed and tab throttling — the whole reason analysis was flaky.
const EXTRACT_POLL_INTERVAL  = 500;      // re-run the extractor this often
const EXTRACT_POLL_SHORT     = 5_000;    // first look: is this view going to have the field at all?
const EXTRACT_POLL_TIMEOUT   = 15_000;   // full budget once we are on a view that should have it

// ─── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  routeMessage(message, sender, sendResponse);
  return true; // keep the channel open for async responses
});

/**
 * True when a content-script message came from the web app this build is
 * configured against.
 *
 * `sender.origin` is filled in by Chrome from the frame that actually sent the
 * message, so a page cannot forge it — which is why the check lives here and
 * not in content_zilvo.js.
 */
function isAppOrigin(sender) {
  const origin = sender?.origin ?? (sender?.url ? new URL(sender.url).origin : '');
  return origin === ZILVO_APP;
}

async function routeMessage(message, sender, sendResponse) {
  try {
    switch (message.action) {
      // ── Company Intelligence ──────────────────────────────────────────────
      case 'ZILVO_LOGIN':
        sendResponse(await zilvoLogin(message.email, message.password));
        break;

      case 'GET_TAB_DETECTION':
        sendResponse(await getTabDetection());
        break;

      case 'ANALYZE_COMPANY':
        sendResponse(await analyzeLinkedInCompany(message.tabId, message.token, message.userInputField, message.batchId));
        break;

      case 'ANALYZE_COMPANY_URL':
        sendResponse(await analyzeLinkedInUrl(message.linkedinUrl, message.token, message.userInputField, message.batchId, message.run));
        break;

      case 'ANALYZE_WEBSITE':
        sendResponse(await analyzeWebsiteUrl(message.websiteUrl, message.linkedinUrl, message.token, message.tabId, message.userInputField, message.batchId));
        break;

      // ── Web-app auth sync (content_zilvo.js) ─────────────────────────────
      // Both sync cases are origin-gated: the content script runs on production
      // and localhost alike, and only the host this build talks to may touch
      // the session. Otherwise a localhost tab silently replaces a production
      // token (or logs the user out of one environment by visiting the other).
      case 'ZILVO_SYNC_AUTH':
        if (!isAppOrigin(sender)) {
          console.warn('[Zilvo] ignoring auth sync from', sender?.origin, '— this build talks to', ZILVO_APP);
          sendResponse({ success: false, error: 'origin mismatch' });
          break;
        }
        await chrome.storage.local.set({
          [_AUTH_KEY]: { token: message.token, user: message.user, origin: ZILVO_APP },
        });
        broadcast({ action: 'ZILVO_AUTH_SYNCED', user: message.user, token: message.token });
        sendResponse({ success: true });
        break;

      case 'ZILVO_SYNC_LOGOUT':
        if (!isAppOrigin(sender)) {
          console.warn('[Zilvo] ignoring logout sync from', sender?.origin, '— this build talks to', ZILVO_APP);
          sendResponse({ success: false, error: 'origin mismatch' });
          break;
        }
        await chrome.storage.local.remove(_AUTH_KEY);
        broadcast({ action: 'ZILVO_AUTH_SYNCED', loggedOut: true });
        sendResponse({ success: true });
        break;

      // "Open in Zilvo Analyze" from an extraction page in the web app.
      case 'ZILVO_OPEN_ANALYZE': {
        if (!isAppOrigin(sender)) {
          sendResponse({ success: false, opened: false, error: 'origin mismatch' });
          break;
        }
        // Remember which list was asked for, so the panel lands on it whether it
        // opens now or the user clicks the toolbar icon a moment later. This is
        // the part that always works.
        await chrome.storage.local.set({
          [_PENDING_LIST_KEY]: {
            extractionId: message.extractionId,
            extractionName: message.extractionName,
            at: Date.now(),
          },
        });

        // Chrome only allows sidePanel.open() in response to a user gesture, and
        // a gesture in the PAGE does not always carry into the extension. Try,
        // and report honestly whether it worked — the page shows written
        // instructions when it did not.
        let opened = false;
        try {
          // sender.tab can be absent (e.g. the message ever arrives from a
          // non-tab context) — treat that as "could not open", not a crash.
          if (sender?.tab?.id == null) throw new Error('no sender tab');
          await chrome.sidePanel.open({ tabId: sender.tab.id });
          opened = true;
        } catch (err) {
          console.info('[Zilvo] sidePanel.open refused (needs a user gesture):', err?.message);
        }
        // Already-open panels pick the list up immediately.
        broadcast({ action: 'ZILVO_OPEN_LIST', extractionId: message.extractionId });
        sendResponse({ success: true, opened });
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown action: ${message.action}` });
    }
  } catch (err) {
    console.error('[Zilvo]', err);
    sendResponse({ success: false, error: err.message });
  }
}


// ─── Tab / Window management ──────────────────────────────────────────────────

/** Creates an inactive background tab (doesn't steal focus). */
function createBackgroundTab(url) {
  return chrome.tabs.create({ url, active: false });
}

/**
 * True for the blank page a tab shows before its real navigation starts.
 *
 * chrome.tabs.create can hand back a tab that already reports status
 * "complete" for its placeholder, so waiting on status alone resolved
 * INSTANTLY and the extractor then ran against an empty document. That is
 * indistinguishable from "the page had no website on it".
 */
function isPlaceholderUrl(url) {
  return !url || /^(about:blank|about:newtab|chrome:\/\/newtab)/i.test(url);
}

/**
 * Resolves when the tab reaches status "complete" ON A REAL PAGE, or rejects on
 * timeout/removal. The placeholder check is what makes "complete" trustworthy.
 */
function waitForTabLoad(tabId, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) return reject(new Error('Tab not found'));
      if (tab.status === 'complete' && !isPlaceholderUrl(tab.url)) return resolve(tab);

      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        reject(new Error(`Tab load timeout after ${timeout / 1000}s`));
      }, timeout);

      function onUpdated(id, info, updatedTab) {
        if (id !== tabId || info.status !== 'complete') return;
        if (isPlaceholderUrl(updatedTab?.url)) return; // placeholder settling — the real navigation is still coming
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        chrome.tabs.get(tabId, t => resolve(t));
      }

      function onRemoved(id) {
        if (id !== tabId) return;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        reject(new Error('Tab was closed before it finished loading'));
      }

      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    });
  });
}

async function safeCloseTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
}

// ─── Status broadcasting ──────────────────────────────────────────────────────

/**
 * Sends a status update to the popup. Swallows errors silently because
 * the popup may not be open at the time of the broadcast.
 */
function broadcast(data) {
  chrome.runtime.sendMessage({ action: 'STATUS_UPDATE', ...data }).catch(() => {});
}

// ─── Company Intelligence ─────────────────────────────────────────────────────

async function zilvoLogin(email, password) {
  try {
    const res = await fetch(apiUrl(API.login), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.error || 'Login failed.' };
    return { success: true, token: data.token, user: data.user };
  } catch {
    return { success: false, error: 'Network error. Check your connection.' };
  }
}

async function getTabDetection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return { type: 'UNKNOWN', tabId: null };

    const url = tab.url;

    // Check if it's a LinkedIn company page
    const liMatch = url.match(/linkedin\.com\/company\/([a-zA-Z0-9\-_.%]+)/);
    if (liMatch) {
      const slug = liMatch[1].replace(/\/$/, '');
      return {
        type:        'LINKEDIN_COMPANY',
        tabId:       tab.id,
        linkedinUrl: `https://www.linkedin.com/company/${slug}/`,
        websiteUrl:  null,
        currentUrl:  url,
      };
    }

    // Try to find a LinkedIn company link on the current website
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          for (const a of document.querySelectorAll('a[href]')) {
            const m = a.href?.match?.(/linkedin\.com\/company\/([a-zA-Z0-9\-_.%]+)/);
            if (m) return `https://www.linkedin.com/company/${m[1].replace(/\/$/, '')}/`;
          }
          return null;
        },
      });
      return {
        type:        result?.result ? 'WEBSITE_WITH_LINKEDIN' : 'WEBSITE',
        tabId:       tab.id,
        linkedinUrl: result?.result || null,
        websiteUrl:  url,
        currentUrl:  url,
      };
    } catch {
      // chrome:// pages or restricted pages
      return { type: 'UNKNOWN', tabId: tab.id, currentUrl: url };
    }
  } catch {
    return { type: 'UNKNOWN', tabId: null };
  }
}

/** `https://www.linkedin.com/company/<slug>/about/` for any company URL. */
function aboutUrlFor(url) {
  const m = (url || '').match(/linkedin\.com\/company\/([a-zA-Z0-9\-_.%]+)/);
  return m ? `https://www.linkedin.com/company/${m[1].replace(/\/$/, '')}/about/` : null;
}

function isAboutView(url) {
  return /\/company\/[^/]+\/about\/?$/.test((url || '').replace(/[?#].*$/, ''));
}

/** Runs the extractor inside an already-open tab. */
async function extractFromTab(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func:   linkedInCIExtractorFn,
    });
    return res?.result ?? null;
  } catch (err) {
    console.warn('[Zilvo] executeScript on tab', tabId, 'failed:', err.message);
    return null;
  }
}

/**
 * Re-runs the extractor until it produces a website URL, or `timeout` elapses.
 *
 * Replaces `await sleep(3_500); extractOnce()`. That fixed offset landed before
 * LinkedIn had hydrated whenever the network was cold or the tab was throttled,
 * and nothing tried again — the same company succeeded or failed run to run for
 * no reason the user could see. Polling returns the moment the field appears
 * (so a warm page is FASTER than the old fixed wait) and keeps looking when it
 * does not.
 *
 * Returns the last successful extraction even without a website, so callers can
 * still use companyName / industry and can tell "page unreadable" (null) apart
 * from "page read, no website on it".
 */
async function extractUntilFound(tabId, timeout = EXTRACT_POLL_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let last = null;

  for (;;) {
    const data = await extractFromTab(tabId);
    if (data) {
      last = data;
      if (data.websiteUrl) return data;
    }
    if (Date.now() + EXTRACT_POLL_INTERVAL >= deadline) return last;
    await sleep(EXTRACT_POLL_INTERVAL);
  }
}

/**
 * Waits for a tab to load, but never longer than `softDeadline`.
 *
 * LinkedIn's SPA frequently never reports status "complete" in an inactive
 * background tab, so the wait has to be capped. The load error is deliberately
 * swallowed: whatever HAS rendered is still worth extracting from, and the
 * poll above is what decides whether the data actually arrived.
 */
async function waitForTabOrDeadline(tabId, timeout, softDeadline) {
  await Promise.race([
    waitForTabLoad(tabId, timeout).catch(() => {}),
    sleep(softDeadline),
  ]);
}

/**
 * Opens `url` in an inactive tab that auto-scrape will ignore.
 *
 * The tab is created BLANK and registered before it is navigated. Creating it
 * on the target URL and registering afterwards left a window in which the
 * tab's "complete" event fired first — auto-scrape then saw an unmanaged
 * LinkedIn tab and started a SECOND analysis of the same company, charging the
 * user twice and closing the tab out from under the first one.
 */
async function createManagedTab(url) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  _managedTabIds.add(tab.id);
  try {
    await chrome.tabs.update(tab.id, { url });
  } catch (err) {
    // The caller never receives the id, so its finally block cannot clean up —
    // do it here or the blank tab is orphaned in the user's window.
    _managedTabIds.delete(tab.id);
    await safeCloseTab(tab.id);
    throw err;
  }
  return tab.id;
}

/** Opens the About view in a background tab and extracts from there. */
async function extractFromAboutTab(aboutUrl) {
  let tabId = null;
  try {
    tabId = await createManagedTab(aboutUrl);
    await waitForTabOrDeadline(tabId, LINKEDIN_LOAD_TIMEOUT, LINKEDIN_SOFT_DEADLINE);
    await sleep(TAB_SETTLE_DELAY);
    return await extractUntilFound(tabId, EXTRACT_POLL_TIMEOUT);
  } catch (err) {
    console.warn('[Zilvo] About-tab extraction failed:', err.message);
    return null;
  } finally {
    if (tabId) { _managedTabIds.delete(tabId); await safeCloseTab(tabId); }
  }
}

/**
 * True when a failed attempt is worth repeating.
 *
 * Only TRANSIENT failures qualify — an unreadable page, a load timeout, a
 * network blip. Two cases are deliberately excluded:
 *
 *   • Anything the server answered (`result.status` is set). A 4xx repeats
 *     itself, and re-POSTing after a 5xx risks submitting an analysis the
 *     server already accepted and charged for.
 *   • "No website URL found". extractUntilFound() already polled the About
 *     view for the full budget, so this is now evidence the company has not
 *     listed a website — not evidence we looked too early. Retrying it only
 *     doubled the time to report a true negative and doubled the LinkedIn page
 *     loads, which is what gets a bulk run rate-limited into auth walls.
 */
function isRetryableFailure(result) {
  if (!result || result.success || result.status) return false;
  return isRetryableError({ message: result.error || '' });
}

/**
 * Analyze with the retry RETRY_LIMIT / RETRY_BACKOFF_MS have always described.
 *
 * Those constants were declared and never referenced, so a single transient
 * miss — a page that had not hydrated, a LinkedIn interstitial, a network
 * blip — became a hard failure with no second chance.
 */
async function analyzeLinkedInCompany(tabId, token, userInputField, batchId, run = {}) {
  let result;
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    result = await analyzeLinkedInCompanyOnce(tabId, token, userInputField, batchId, run);
    if (!isRetryableFailure(result)) return result;
    if (attempt < RETRY_LIMIT) {
      console.warn(`[Zilvo] attempt ${attempt}/${RETRY_LIMIT} failed — ${result.error} — retrying in ${RETRY_BACKOFF_MS}ms`);
      await sleep(RETRY_BACKOFF_MS);
    }
  }
  return result;
}

async function analyzeLinkedInCompanyOnce(tabId, token, userInputField, batchId, run = {}) {
  // Short first look. If this tab is the company HOME view the Website field
  // will NEVER appear on it however long we wait, so spending the full poll
  // budget here would only delay the /about/ fallback that does have the data.
  let liData = await extractUntilFound(tabId, EXTRACT_POLL_SHORT);

  if (!liData) return { success: false, error: 'Could not read the LinkedIn page. Make sure it is fully loaded.' };

  // The Website field only exists on the /about/ view. Auto-scrape fires when
  // the company HOME tab reaches "complete", so the extractor ran against a DOM
  // that never contained a website — and we told the user the company had not
  // listed one while their screen showed it. Check /about/ before believing it.
  if (!liData.websiteUrl && isAboutView(liData.linkedinUrl)) {
    // Already on the right view — the field is simply still rendering. Spend
    // the rest of the budget here rather than opening a redundant second tab.
    liData = await extractUntilFound(tabId, EXTRACT_POLL_TIMEOUT - EXTRACT_POLL_SHORT) || liData;
  }

  if (!liData.websiteUrl && !isAboutView(liData.linkedinUrl)) {
    const aboutUrl = aboutUrlFor(liData.linkedinUrl || userInputField);
    if (aboutUrl) {
      console.log('[Zilvo] no website on', liData.linkedinUrl, '— retrying on', aboutUrl);
      const retry = await extractFromAboutTab(aboutUrl);
      if (retry?.websiteUrl) {
        liData = { ...liData, ...retry, linkedinUrl: liData.linkedinUrl };
      }
    }
  }

  if (!liData.websiteUrl) {
    // Dump what the page actually looked like, so the next failure explains
    // itself instead of needing another round of guessing at selectors.
    console.error('[Zilvo] website extraction failed —', liData.debug || '(no debug payload)');
    return {
      success: false,
      error:   'No website URL found on this LinkedIn page. Open the company\u2019s About tab and retry, or paste the website URL in the Website tab.',
    };
  }

  // Open the company website in a background tab and scrape its DOM content
  const pageContent = await scrapeWebsiteInBackground(liData.websiteUrl);

  return callZilvoAnalyze({
    token,
    linkedinUrl:           liData.linkedinUrl,
    websiteUrl:            liData.websiteUrl,
    companyName:           liData.companyName           || undefined,
    linkedinIndustry:      liData.industry              || undefined,
    linkedinEmployeeCount: liData.employeeCount         || undefined,
    linkedinFollowerCount: liData.followerCount         || undefined,
    pageContent,
    userInputField:        userInputField               || liData.linkedinUrl,
    batchId,
    ...run,
  });
}

// Opens a URL in a hidden background tab, injects the content extractor, returns the text.
async function scrapeWebsiteInBackground(url) {
  let siteTabId = null;
  try {
    const tab = await createBackgroundTab(url);
    siteTabId = tab.id;
    // Cap the wait instead of throwing at 30 s. A slow site used to yield NO
    // page content at all; partially rendered content is worth far more to the
    // analysis than nothing.
    await waitForTabOrDeadline(siteTabId, WEBSITE_LOAD_TIMEOUT, WEBSITE_SOFT_DEADLINE);
    await sleep(WEBSITE_RENDER_DELAY);

    // Confirm the tab actually left its placeholder. Without this a tab that
    // never navigated was scraped as an empty document and reported as a site
    // with no content.
    const current = await chrome.tabs.get(siteTabId).catch(() => null);
    if (!current || isPlaceholderUrl(current.url)) {
      console.warn('[Zilvo] website tab never navigated away from', current?.url ?? '(gone)');
      return undefined;
    }

    const [res] = await chrome.scripting.executeScript({
      target: { tabId: siteTabId, allFrames: false },
      func:   websiteContentExtractorFn,
    });
    const content = res?.result || '';
    console.log('[Zilvo] website scrape:', current.url, content ? `${content.length} chars` : 'empty');
    return content || undefined;
  } catch (err) {
    console.warn('[Zilvo] scrapeWebsiteInBackground failed:', err.message);
    return undefined;
  } finally {
    if (siteTabId) await safeCloseTab(siteTabId);
  }
}

async function analyzeLinkedInUrl(linkedinUrl, token, userInputField, batchId, run = {}) {
  let tabId = null;
  try {
    // Load /about/ directly. The base URL renders the company HOME view, which
    // does not carry the Website field — extracting from it failed for every
    // company whose website is only listed on About.
    const match = linkedinUrl.match(/linkedin\.com\/company\/([a-zA-Z0-9\-_.%]+)/);
    if (!match) return { success: false, error: 'Invalid LinkedIn company URL.' };
    const url = `https://www.linkedin.com/company/${match[1].replace(/\/$/, '')}/about/`;

    tabId = await createManagedTab(url); // registered before navigating — see createManagedTab

    // LinkedIn's SPA often won't fire status=complete in an inactive background
    // tab, so the wait is capped. extractUntilFound() downstream is what waits
    // for the company data itself.
    await waitForTabOrDeadline(tabId, LINKEDIN_LOAD_TIMEOUT, LINKEDIN_SOFT_DEADLINE);
    await sleep(TAB_SETTLE_DELAY);

    return await analyzeLinkedInCompany(tabId, token, userInputField || linkedinUrl, batchId, run);
  } catch (err) {
    return { success: false, error: err.message || 'Failed to load LinkedIn page.' };
  } finally {
    if (tabId) {
      _managedTabIds.delete(tabId);
      await safeCloseTab(tabId);
    }
  }
}

async function analyzeWebsiteUrl(websiteUrl, linkedinUrl, token, tabId, userInputField, batchId) {
  if (!websiteUrl) return { success: false, error: 'No website URL provided.' };

  let pageContent;
  if (tabId) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func:   websiteContentExtractorFn,
      });
      pageContent = res?.result || undefined;
      console.log('[Zilvo] page scrape:', pageContent ? `${pageContent.length} chars` : 'empty — falling back to server fetch');
    } catch (err) {
      console.warn('[Zilvo] executeScript failed:', err.message);
    }
  }

  return callZilvoAnalyze({ token, websiteUrl, linkedinUrl: linkedinUrl || undefined, pageContent, userInputField: userInputField || websiteUrl, batchId });
}

async function callZilvoAnalyze({
  token, linkedinUrl, websiteUrl,
  companyName, linkedinIndustry, linkedinEmployeeCount, linkedinFollowerCount,
  pageContent, userInputField, batchId,
  // Run-level context: where this job came from and which project's ICP scores it.
  source, sourceExtractionId, projectId,
}) {
  // The popup mirrors the selected ICP into storage. Read it here, at send
  // time, so every analyze path (LinkedIn, website, bulk) picks it up without
  // each call site having to thread it through.
  //
  // EXCEPT when the run is pinned to a Project (the Extracted Lists flow):
  // the promise there is "your Project contains the ICP Zilvo will use", so
  // the header's global ICP picker must not override it. The backend resolves
  // the ICP from projectId when icpId is absent.
  const { zilvoIcpId: storedIcpId } = await chrome.storage.local.get({ zilvoIcpId: '' });
  const icpId = projectId ? '' : storedIcpId;

  let res;
  try {
    res = await fetch(apiUrl(API.analyze), {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        linkedinUrl,
        websiteUrl,
        companyName,
        linkedinIndustry,
        linkedinEmployeeCount,
        linkedinFollowerCount,
        pageContent,
        userInputField,
        batchId,
        // Set when the run came from a LinkedIn extraction, so the job carries
        // its source label and is scored against the project the user picked.
        source,
        sourceExtractionId,
        projectId,
        // Which positioning to score fit against, chosen in the popup. Omitted
        // when unset so the backend falls back to the account default ICP.
        icpId: icpId || undefined,
      }),
    });
  } catch (err) {
    console.error('[Zilvo] fetch failed:', err);
    return { success: false, error: `Cannot reach Zilvo server: ${err.message}` };
  }

  // Read the body ONCE as text. Going straight to res.json() meant that any
  // non-JSON failure (an HTML error page, a proxy 502, an empty body) threw the
  // whole body away and reported "unexpected response format" with no reason.
  const raw = await res.text().catch(() => '');

  if (!res.ok) {
    const error = extractApiError(raw, res.status);
    console.error(
      '[Zilvo] analyze failed —', res.status, res.statusText,
      '\n  url:  ', apiUrl(API.analyze),
      '\n  body: ', raw.slice(0, 1000) || '(empty)'
    );
    return { success: false, error, status: res.status };
  }

  try {
    const data = JSON.parse(raw);
    return { success: true, jobId: data.jobId, creditsRemaining: data.creditsRemaining };
  } catch {
    console.error('[Zilvo] analyze returned 2xx with an unreadable body:', raw.slice(0, 1000) || '(empty)');
    return { success: false, error: `Server returned an unreadable response (HTTP ${res.status}).`, status: res.status };
  }
}

/**
 * Pull a human-readable reason out of an API error body.
 *
 * The old code only read `data.error`, so any other shape ({ message }, a
 * nested { error: { message } }, a validation { errors: [...] }) silently
 * became a bare "Analysis failed (500)". When the body is not JSON at all the
 * raw text is far more useful than a generic sentence, so a trimmed snippet is
 * surfaced instead of being discarded.
 */
function extractApiError(raw, status) {
  const text = (raw || '').trim();
  if (!text) return `Analysis failed (HTTP ${status}) — the server returned an empty response.`;

  try {
    const data = JSON.parse(text);
    const reason =
      (typeof data?.error === 'string' ? data.error : null) ||
      data?.error?.message ||
      data?.message ||
      data?.detail ||
      (Array.isArray(data?.errors)
        ? data.errors.map(e => e?.message || e).filter(Boolean).join('; ')
        : null);
    if (reason) return String(reason);
    return `Analysis failed (HTTP ${status}) — ${text.slice(0, 300)}`;
  } catch {
    // Not JSON: an HTML error page, a proxy message, a stack trace.
    const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return `Analysis failed (HTTP ${status}) — ${plain.slice(0, 300)}`;
  }
}

/**
 * Website content extractor — injected into the active website tab.
 * Collects visible text from h1–h6, p, a, and leaf span/div nodes.
 * Must be completely self-contained (no closure variables).
 */
function websiteContentExtractorFn() {
  try {
    const seen  = new Set();
    const parts = [];
    const MAX   = 8000;

    function addText(tag, el) {
      try {
        const text = (el.innerText || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length < 3 || seen.has(text)) return;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
        seen.add(text);
        if (/^h[1-6]$/.test(tag)) {
          parts.push(`[${tag.toUpperCase()}] ${text}`);
        } else if (tag === 'a') {
          const href = el.href && !el.href.startsWith('javascript') ? ` (${el.href})` : '';
          parts.push(`[A] ${text}${href}`);
        } else {
          parts.push(text);
        }
      } catch { /* skip this element */ }
    }

    for (const tag of ['h1','h2','h3','h4','h5','h6','p','a']) {
      for (const el of document.querySelectorAll(tag)) addText(tag, el);
    }

    const BLOCK = 'h1,h2,h3,h4,h5,h6,p,div,section,article,main,header,footer,nav,ul,ol,li,table';
    for (const tag of ['span','div']) {
      for (const el of document.querySelectorAll(tag)) {
        if (!el.querySelector(BLOCK)) addText(tag, el);
      }
    }

    return parts.join('\n').slice(0, MAX);
  } catch (e) {
    return '';
  }
}

/**
 * LinkedIn CI Extractor — injected into the active LinkedIn company tab.
 * Must be completely self-contained (no closure variables).
 * Extracts: company name, LinkedIn URL, industry, employee count, follower count, website URL.
 */
function linkedInCIExtractorFn() {
  function decodeTrackingUrl(url) {
    // LinkedIn wraps outbound links in a redirector and has changed its shape
    // more than once: l.linkedin.com/?url=, /redir/redirect?url=, and now
    // /safety/go?url= (the SDUI About page). Matching on specific paths meant
    // an unrecognised wrapper stayed a linkedin.com URL, so isExternal()
    // rejected it and the company's website looked absent. Unwrap ANY
    // linkedin.com URL carrying a `url` parameter, repeatedly.
    try {
      let current = url;
      for (let i = 0; i < 3; i++) {
        const p = new URL(current);
        if (!p.hostname.endsWith('linkedin.com')) break;
        let target = p.searchParams.get('url') || p.searchParams.get('redirect');
        if (!target) break;
        // searchParams already percent-decodes; only decode again when the
        // wrapper double-encoded it. Decoding twice corrupts %-escapes.
        if (!/^https?:\/\//i.test(target)) {
          try { target = decodeURIComponent(target); } catch { /* leave as-is */ }
        }
        if (!/^https?:\/\//i.test(target) || target === current) break;
        current = target;
      }
      return current;
    } catch { return url; }
  }

  function isExternal(url) {
    try { return !new URL(url).hostname.endsWith('linkedin.com'); } catch { return false; }
  }

  const SOCIAL = /\b(twitter|x\.com|facebook|instagram|youtube|tiktok|pinterest|snapchat)\b/i;

  // ── Company name ─────────────────────────────────────────────────────────────
  let companyName = null;
  for (const sel of [
    'h1.org-top-card-summary__title', '.org-top-card-summary__title',
    'h1[class*="org-top-card"]', '.top-card-layout__title', 'h1',
  ]) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) { companyName = el.textContent.trim(); break; }
  }

  let industry = null, employeeCount = null, followerCount = null, websiteUrl = null;

  // ── Embedded JSON state (Voyager — most comprehensive) ───────────────────────
  function findInObj(obj, keys, depth) {
    if (depth > 8 || !obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
      for (const item of obj) { const r = findInObj(item, keys, depth + 1); if (r) return r; }
      return null;
    }
    for (const k of keys) {
      if (typeof obj[k] === 'string' && obj[k]) return obj[k];
      if (typeof obj[k] === 'number' && obj[k]) return String(obj[k]);
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') { const r = findInObj(v, keys, depth + 1); if (r) return r; }
    }
    return null;
  }

  for (const code of document.querySelectorAll('code')) {
    const t = code.textContent.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) continue;
    try {
      const obj = JSON.parse(t);
      if (!industry) {
        const v = findInObj(obj, ['industryName', 'industry'], 0);
        if (v) industry = Array.isArray(v) ? v[0] : String(v);
      }
      if (!employeeCount) {
        const v = findInObj(obj, ['staffCountRange', 'headcount'], 0);
        if (v) {
          employeeCount = typeof v === 'object'
            ? `${v.start || 0}–${v.end || '+'} employees`
            : String(v) + ' employees';
        }
      }
      if (!followerCount) {
        const v = findInObj(obj, ['followersCount', 'followerCount', 'numFollowers'], 0);
        if (v) followerCount = Number(v).toLocaleString() + ' followers';
      }
      if (!websiteUrl) {
        const v = findInObj(obj, ['websiteUrl', 'website', 'companyWebsite', 'homepageUrl'], 0);
        if (v && isExternal(v) && !SOCIAL.test(v)) websiteUrl = v;
      }
    } catch { /* malformed JSON */ }
  }

  // ── JSON-LD fallback ──────────────────────────────────────────────────────────
  if (!websiteUrl || !industry) {
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(el.textContent);
        const nodes = [d, ...(d['@graph'] || [])];
        for (const n of nodes) {
          if (!industry && n.industry) industry = n.industry;
          if (!websiteUrl) {
            const candidates = [
              ...(Array.isArray(n.sameAs) ? n.sameAs : n.sameAs ? [n.sameAs] : []),
              n.url,
            ].filter(Boolean);
            for (const c of candidates) {
              if (isExternal(c) && !SOCIAL.test(c)) { websiteUrl = c; break; }
            }
          }
        }
      } catch { /* malformed JSON-LD */ }
    }
  }

  // ── DOM fallback: employee count ──────────────────────────────────────────────
  if (!employeeCount) {
    for (const a of document.querySelectorAll('a[href*="/search/results/people/"]')) {
      const t = a.textContent.trim().replace(/\s+/g, ' ');
      if (/\d.*employee/i.test(t)) { employeeCount = t; break; }
    }
  }

  // ── DOM fallback: follower count ──────────────────────────────────────────────
  if (!followerCount) {
    for (const el of document.querySelectorAll('.org-top-card-summary-info-list__info-item, [class*="follower"]')) {
      const t = el.textContent.trim();
      if (/\d[\d,]* followers?/i.test(t)) {
        followerCount = t.match(/[\d,]+ followers?/i)?.[0] || t;
        break;
      }
    }
  }

  // ── DOM fallback: the "Website" field shown on the About tab ─────────────────
  // LinkedIn renders it as a PLAIN external anchor:
  //   <dt>Website</dt><dd><a href="https://news.microsoft.com/">…</a></dd>
  // Nothing above sees that. The <code> Voyager blocks are absent on the modern
  // app shell, JSON-LD carries the LinkedIn URL rather than the company's, and
  // the tracking-link scan below only accepts l.linkedin.com / redir hrefs — so
  // a page plainly showing a website still reported "no website URL found".
  if (!websiteUrl) {
    // The label is NOT always a <dt>/<h3>. LinkedIn's current About page is
    // server-driven (isSdui=true) with obfuscated class names and renders
    //   <div><div><p>Website</p></div><div><a href=…><p>https://…</p></a></div></div>
    // so the anchor is not a sibling of the label — it is a sibling of the
    // label's WRAPPER. Match the label by text, then climb.
    const labels = [...document.querySelectorAll('dt, h3, h4, p, span, .text-heading-small')]
      .filter(el => /^website$/i.test((el.textContent || '').trim()));

    for (const label of labels) {
      let node = label;
      for (let up = 0; up < 4 && node && !websiteUrl; up++) {
        let sib = node.nextElementSibling;
        for (let n = 0; sib && n < 3 && !websiteUrl; n++) {
          for (const a of sib.querySelectorAll('a[href]')) {
            const href = decodeTrackingUrl(a.href);
            if (isExternal(href) && !SOCIAL.test(href)) { websiteUrl = href; break; }
          }
          sib = sib.nextElementSibling;
        }
        node = node.parentElement;
      }
      if (websiteUrl) break;
    }
  }

  // ── Tracking link fallback: website ──────────────────────────────────────────
  if (!websiteUrl) {
    const links = [...document.querySelectorAll(
      'a[href*="l.linkedin.com"], a[href*="/redir/redirect"], a[href*="/safety/go"], a[href*="url="]'
    )];
    for (const a of links) {
      if (/about_website|website|homepage/i.test(a.href)) {
        const d = decodeTrackingUrl(a.href);
        if (isExternal(d) && !SOCIAL.test(d)) { websiteUrl = d; break; }
      }
    }
    if (!websiteUrl) {
      for (const a of links) {
        const d = decodeTrackingUrl(a.href);
        if (isExternal(d) && !SOCIAL.test(d)) { websiteUrl = d; break; }
      }
    }
  }

  // ── Last resort: an anchor whose visible TEXT is a URL ───────────────────────
  // On the About tab the website link's label is the URL itself. That is a
  // strong signal, and keying on it avoids grabbing sponsored or nav links.
  if (!websiteUrl) {
    const URLISH = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i;
    for (const a of document.querySelectorAll('a[href]')) {
      if (!URLISH.test((a.textContent || '').trim())) continue;
      const href = decodeTrackingUrl(a.href);
      if (isExternal(href) && !SOCIAL.test(href)) { websiteUrl = href; break; }
    }
  }

  // When nothing was found, report what the page actually looked like. Without
  // this a failure is indistinguishable from "the company has no website".
  let debug;
  if (!websiteUrl) {
    const externals = [...new Set([...document.querySelectorAll('a[href]')]
      .map(a => a.href)
      .filter(h => isExternal(h)))];
    debug = {
      url:           location.href,
      title:         document.title,
      anchors:       document.querySelectorAll('a[href]').length,
      trackingLinks: document.querySelectorAll('a[href*="l.linkedin.com/l.php"], a[href*="/redir/redirect"]').length,
      codeBlocks:    document.querySelectorAll('code').length,
      ldJson:        document.querySelectorAll('script[type="application/ld+json"]').length,
      labels:        [...document.querySelectorAll('dt, h3, .text-heading-small')]
                       .map(e => (e.textContent || '').trim())
                       .filter(t => t && t.length < 40)
                       .slice(0, 25),
      externalHrefs: externals.slice(0, 15),
    };
  }

  return {
    companyName:   companyName   || null,
    linkedinUrl:   location.href,
    industry:      industry      || null,
    employeeCount: employeeCount || null,
    followerCount: followerCount || null,
    websiteUrl:    websiteUrl    || null,
    debug,
  };
}
