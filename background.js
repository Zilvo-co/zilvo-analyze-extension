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

import { sleep, normalizeLinkedInUrl } from './helpers/utils.js';

// ─── Zilvo API ────────────────────────────────────────────────────────────────
// const ZILVO_API = 'http://localhost:3000';
const ZILVO_API = 'https://www.zilvo.co';

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

  const auth = await _getAuthFromStorage();
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

  // Wait for LinkedIn React content to finish rendering
  await sleep(LINKEDIN_RENDER_DELAY);

  // Confirm tab is still on the same page (user may have navigated away)
  try {
    const current = await chrome.tabs.get(tabId);
    if (!current.url?.includes(slug)) {
      chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
      return;
    }
  } catch { return; }

  _recentlyScraped.set(canonicalUrl, Date.now());

  const result = await analyzeLinkedInCompany(tabId, auth.token);

  if (result.success) {
    _setBadge(tabId, '✓', '#4caf50');
    if (result.creditsRemaining != null) await _updateStoredCredits(result.creditsRemaining);
    await _setSessionScrape({ tabId, linkedinUrl: canonicalUrl, status: 'DONE', ...result, timestamp: Date.now() });
    broadcast({ action: 'CI_AUTO_STATUS', status: 'DONE', linkedinUrl: canonicalUrl, ...result });
  } else {
    _setBadge(tabId, '!', '#ef5350');
    await _setSessionScrape({ tabId, linkedinUrl: canonicalUrl, status: 'ERROR', error: result.error, timestamp: Date.now() });
    broadcast({ action: 'CI_AUTO_STATUS', status: 'ERROR', error: result.error });
  }

  // Auto-clear badge after 8 s
  setTimeout(() => { chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}); }, 8_000);
}

// ── Storage helpers (background-side, avoids re-importing helpers/auth.js) ────
const _AUTH_KEY = 'zilvo_auth';

async function _getAuthFromStorage() {
  const r = await chrome.storage.local.get(_AUTH_KEY);
  return r[_AUTH_KEY] ?? null;
}

async function _updateStoredCredits(credits) {
  const r    = await chrome.storage.local.get(_AUTH_KEY);
  const auth = r[_AUTH_KEY];
  if (!auth) return;
  await chrome.storage.local.set({ [_AUTH_KEY]: { ...auth, user: { ...auth.user, credits } } });
}

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
const LINKEDIN_RENDER_DELAY  = 3_500;    // extra wait after "complete" for React content
const WEBSITE_RENDER_DELAY   = 2_000;    // extra wait after "complete" for CSS / lazy images
const RETRY_LIMIT            = 2;        // total attempts (1 original + 1 retry)
const RETRY_BACKOFF_MS       = 2_500;    // wait between retry attempts

// ─── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  routeMessage(message, sendResponse);
  return true; // keep the channel open for async responses
});

async function routeMessage(message, sendResponse) {
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
        sendResponse(await analyzeLinkedInCompany(message.tabId, message.token));
        break;

      case 'ANALYZE_COMPANY_URL':
        sendResponse(await analyzeLinkedInUrl(message.linkedinUrl, message.token));
        break;

      case 'ANALYZE_WEBSITE':
        sendResponse(await analyzeWebsiteUrl(message.websiteUrl, message.linkedinUrl, message.token, message.tabId));
        break;

      // ── Web-app auth sync (content_zilvo.js) ─────────────────────────────
      case 'ZILVO_SYNC_AUTH':
        await chrome.storage.local.set({ [_AUTH_KEY]: { token: message.token, user: message.user } });
        broadcast({ action: 'ZILVO_AUTH_SYNCED', user: message.user, token: message.token });
        sendResponse({ success: true });
        break;

      case 'ZILVO_SYNC_LOGOUT':
        await chrome.storage.local.remove(_AUTH_KEY);
        broadcast({ action: 'ZILVO_AUTH_SYNCED', loggedOut: true });
        sendResponse({ success: true });
        break;

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

/** Resolves when the tab reaches status "complete", or rejects on timeout/removal. */
function waitForTabLoad(tabId, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) return reject(new Error('Tab not found'));
      if (tab.status === 'complete') return resolve(tab);

      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        reject(new Error(`Tab load timeout after ${timeout / 1000}s`));
      }, timeout);

      function onUpdated(id, info) {
        if (id !== tabId || info.status !== 'complete') return;
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
    const res = await fetch(`${ZILVO_API}/api/auth/login`, {
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

async function analyzeLinkedInCompany(tabId, token) {
  let liData;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func:   linkedInCIExtractorFn,
    });
    liData = result?.result;
  } catch {
    return { success: false, error: 'Could not read the LinkedIn page. Make sure it is fully loaded.' };
  }

  if (!liData) return { success: false, error: 'Failed to extract LinkedIn data.' };

  if (!liData.websiteUrl) {
    return {
      success: false,
      error:   'No website URL found on this LinkedIn page. The company may not have listed a website.',
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
  });
}

// Opens a URL in a hidden background tab, injects the content extractor, returns the text.
async function scrapeWebsiteInBackground(url) {
  let siteTabId = null;
  try {
    const tab = await createBackgroundTab(url);
    siteTabId = tab.id;
    await waitForTabLoad(siteTabId, WEBSITE_LOAD_TIMEOUT);
    await sleep(WEBSITE_RENDER_DELAY);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: siteTabId, allFrames: false },
      func:   websiteContentExtractorFn,
    });
    const content = res?.result || '';
    console.log('[Zilvo] website scrape:', content ? `${content.length} chars` : 'empty');
    return content || undefined;
  } catch (err) {
    console.warn('[Zilvo] scrapeWebsiteInBackground failed:', err.message);
    return undefined;
  } finally {
    if (siteTabId) await safeCloseTab(siteTabId);
  }
}

async function analyzeLinkedInUrl(linkedinUrl, token) {
  let tabId = null;
  try {
    // Use base company URL — avoids the /about/ redirect and loads faster in background tabs
    const match = linkedinUrl.match(/linkedin\.com\/company\/([a-zA-Z0-9\-_.%]+)/);
    if (!match) return { success: false, error: 'Invalid LinkedIn company URL.' };
    const url = `https://www.linkedin.com/company/${match[1]}/`;

    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    _managedTabIds.add(tabId); // prevent auto-scrape from double-processing this tab

    // LinkedIn's SPA often won't fire status=complete in an inactive background tab.
    // Race: proceed as soon as the tab completes OR after 10s, whichever is first.
    await Promise.race([
      waitForTabLoad(tabId, 60_000).catch(() => {}),
      sleep(10_000),
    ]);
    await sleep(3_500); // wait for React to render company data

    return await analyzeLinkedInCompany(tabId, token);
  } catch (err) {
    return { success: false, error: err.message || 'Failed to load LinkedIn page.' };
  } finally {
    if (tabId) {
      _managedTabIds.delete(tabId);
      await safeCloseTab(tabId);
    }
  }
}

async function analyzeWebsiteUrl(websiteUrl, linkedinUrl, token, tabId) {
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

  return callZilvoAnalyze({ token, websiteUrl, linkedinUrl: linkedinUrl || undefined, pageContent });
}

async function callZilvoAnalyze({
  token, linkedinUrl, websiteUrl,
  companyName, linkedinIndustry, linkedinEmployeeCount, linkedinFollowerCount,
  pageContent,
}) {
  let res;
  try {
    res = await fetch(`${ZILVO_API}/api/company-intelligence/analyze`, {
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
      }),
    });
  } catch (err) {
    console.error('[Zilvo] fetch failed:', err);
    return { success: false, error: `Cannot reach Zilvo server: ${err.message}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { success: false, error: `Server error (HTTP ${res.status}) — unexpected response format.` };
  }

  if (!res.ok) return { success: false, error: data.error || `Analysis failed (${res.status})` };
  return { success: true, jobId: data.jobId, creditsRemaining: data.creditsRemaining };
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
    try {
      const p = new URL(url);
      if (p.hostname === 'l.linkedin.com') return decodeURIComponent(p.searchParams.get('url') || url);
      if (p.hostname.endsWith('linkedin.com') && p.pathname === '/redir/redirect') {
        const t = p.searchParams.get('url');
        if (t) return decodeURIComponent(t);
      }
      return url;
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

  // ── Tracking link fallback: website ──────────────────────────────────────────
  if (!websiteUrl) {
    const links = [...document.querySelectorAll(
      'a[href*="l.linkedin.com/l.php"], a[href*="/redir/redirect"]'
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

  return {
    companyName:   companyName   || null,
    linkedinUrl:   location.href,
    industry:      industry      || null,
    employeeCount: employeeCount || null,
    followerCount: followerCount || null,
    websiteUrl:    websiteUrl    || null,
  };
}
