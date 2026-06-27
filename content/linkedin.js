/**
 * content/linkedin.js
 *
 * Standalone content-script version of the LinkedIn extractor.
 * This file is NOT auto-injected via the manifest — it exists as a
 * reference / alternative injection path.
 *
 * The primary extraction path uses chrome.scripting.executeScript with
 * the inline func in background.js, which avoids message-passing timing issues.
 *
 * This file is useful for:
 *   • Manual debugging in DevTools (paste into console)
 *   • Future auto-inject scenarios where background injection isn't possible
 */

(() => {
  'use strict';

  function decodeTrackingUrl(url) {
    try {
      const p = new URL(url);
      if (p.hostname === 'l.linkedin.com') {
        return decodeURIComponent(p.searchParams.get('url') || url);
      }
      return url;
    } catch { return url; }
  }

  function isExternal(url) {
    try { return !new URL(url).hostname.endsWith('linkedin.com'); }
    catch { return false; }
  }

  function extractData() {
    let companyName = null;
    const nameSelectors = [
      'h1.org-top-card-summary__title',
      '.org-top-card-summary__title',
      'h1[class*="org-top-card"]',
      '.top-card-layout__title',
      'h1'
    ];
    for (const sel of nameSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) { companyName = el.textContent.trim(); break; }
    }

    // Strategy 1: data-field attribute
    for (const sel of ['[data-field="website"] a', 'a[data-field="website"]']) {
      const el = document.querySelector(sel);
      if (el) {
        const href = decodeTrackingUrl(el.href);
        if (isExternal(href)) return { name: companyName, websiteUrl: href };
      }
    }

    // Strategy 2: tracking control name
    for (const el of document.querySelectorAll('a[data-tracking-control-name*="website"]')) {
      const href = decodeTrackingUrl(el.href);
      if (isExternal(href)) return { name: companyName, websiteUrl: href };
    }

    // Strategy 3: dt "Website" label
    for (const dt of document.querySelectorAll('dt')) {
      if (/^website$/i.test(dt.textContent.trim())) {
        let sib = dt.nextElementSibling;
        while (sib && sib.tagName !== 'DT') {
          const a = sib.querySelector('a[href]');
          if (a) {
            const href = decodeTrackingUrl(a.href);
            if (isExternal(href)) return { name: companyName, websiteUrl: href };
          }
          sib = sib.nextElementSibling;
        }
      }
    }

    return { name: companyName, websiteUrl: null, error: 'Website URL not found' };
  }

  // Respond to background.js requests
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'EXTRACT_LINKEDIN_DATA') {
      sendResponse(extractData());
    }
    return true;
  });
})();
