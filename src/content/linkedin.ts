import type { LinkedInData } from '../types';

// Self-contained — injected into LinkedIn tabs via chrome.scripting.executeScript({ func }).
// Must not reference any module-level variables or imports at runtime.
export function extractLinkedInData(): LinkedInData {
  function decodeTrackingUrl(url: string): string {
    try {
      const p = new URL(url);
      if (p.hostname === 'l.linkedin.com') {
        return decodeURIComponent(p.searchParams.get('url') || url);
      }
      return url;
    } catch { return url; }
  }

  function isExternal(url: string): boolean {
    try { return !new URL(url).hostname.endsWith('linkedin.com'); }
    catch { return false; }
  }

  let companyName: string | null = null;
  const nameSelectors = [
    'h1.org-top-card-summary__title',
    '.org-top-card-summary__title',
    'h1[class*="org-top-card"]',
    '.top-card-layout__title',
    'h1',
  ];
  for (const sel of nameSelectors) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) { companyName = el.textContent.trim(); break; }
  }

  // Strategy 1: data-field="website"
  for (const sel of ['[data-field="website"] a', 'a[data-field="website"]']) {
    const el = document.querySelector(sel) as HTMLAnchorElement | null;
    if (el) {
      const href = decodeTrackingUrl(el.href);
      if (isExternal(href)) return { companyName, websiteUrl: href };
    }
  }

  // Strategy 2: tracking control name
  for (const el of document.querySelectorAll<HTMLAnchorElement>('a[data-tracking-control-name*="website"]')) {
    const href = decodeTrackingUrl(el.href);
    if (isExternal(href)) return { companyName, websiteUrl: href };
  }

  // Strategy 3: dt "Website" label → sibling dd
  for (const dt of document.querySelectorAll('dt')) {
    if (/^website$/i.test(dt.textContent?.trim() ?? '')) {
      let sib = dt.nextElementSibling;
      while (sib && sib.tagName !== 'DT') {
        const a = sib.querySelector('a[href]') as HTMLAnchorElement | null;
        if (a) {
          const href = decodeTrackingUrl(a.href);
          if (isExternal(href)) return { companyName, websiteUrl: href };
        }
        sib = sib.nextElementSibling;
      }
    }
  }

  // Strategy 4: any external link near "website" text
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const context = a.closest('li, dd, div')?.textContent?.toLowerCase() ?? '';
    if (context.includes('website')) {
      const href = decodeTrackingUrl(a.href);
      if (isExternal(href)) return { companyName, websiteUrl: href };
    }
  }

  return { companyName, websiteUrl: null, error: 'Website URL not found on LinkedIn page' };
}

// Richer extraction for Company Intelligence — runs on the currently open LinkedIn page.
// Extracts company name, website, industry, employee count, follower count.
export function extractLinkedInCompanyData(): import('../types').LinkedInCompanyData {
  function decodeTrackingUrl(url: string): string {
    try {
      const p = new URL(url);
      if (p.hostname === 'l.linkedin.com') return decodeURIComponent(p.searchParams.get('url') || url);
      return url;
    } catch { return url; }
  }

  function isExternal(url: string): boolean {
    try { return !new URL(url).hostname.endsWith('linkedin.com'); }
    catch { return false; }
  }

  function getText(selector: string): string | null {
    return document.querySelector(selector)?.textContent?.trim() || null;
  }

  const linkedinUrl = window.location.href.split('?')[0].replace(/\/$/, '');

  // Company name
  let companyName: string | null = null;
  for (const sel of [
    'h1.org-top-card-summary__title',
    '.org-top-card-summary__title',
    'h1[class*="org-top-card"]',
    '.top-card-layout__title',
    'h1',
  ]) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) { companyName = el.textContent.trim(); break; }
  }

  // Website URL
  let websiteUrl: string | null = null;
  for (const sel of ['[data-field="website"] a', 'a[data-field="website"]']) {
    const el = document.querySelector(sel) as HTMLAnchorElement | null;
    if (el) { const href = decodeTrackingUrl(el.href); if (isExternal(href)) { websiteUrl = href; break; } }
  }
  if (!websiteUrl) {
    for (const el of document.querySelectorAll<HTMLAnchorElement>('a[data-tracking-control-name*="website"]')) {
      const href = decodeTrackingUrl(el.href);
      if (isExternal(href)) { websiteUrl = href; break; }
    }
  }
  if (!websiteUrl) {
    for (const dt of document.querySelectorAll('dt')) {
      if (/^website$/i.test(dt.textContent?.trim() ?? '')) {
        let sib = dt.nextElementSibling;
        while (sib && sib.tagName !== 'DT') {
          const a = sib.querySelector('a[href]') as HTMLAnchorElement | null;
          if (a) { const href = decodeTrackingUrl(a.href); if (isExternal(href)) { websiteUrl = href; break; } }
          sib = sib.nextElementSibling;
        }
        if (websiteUrl) break;
      }
    }
  }

  // Industry
  let industry: string | null = null;
  for (const sel of [
    '.org-top-card-summary__industry',
    '[data-field="industry"]',
    '.top-card-layout__industry',
  ]) {
    const val = getText(sel);
    if (val) { industry = val; break; }
  }
  // Fallback: look for industry in about section
  if (!industry) {
    for (const dt of document.querySelectorAll('dt')) {
      if (/^industry$/i.test(dt.textContent?.trim() ?? '')) {
        industry = dt.nextElementSibling?.textContent?.trim() || null;
        break;
      }
    }
  }

  // Employee count — strategy 1: exact count from "See all X employees" link on people page
  let employeeCount: string | null = null;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/people/"]')) {
    const text = a.textContent?.trim() || '';
    const numMatch = text.match(/([\d,]+)\s+employees?/i);
    if (numMatch) { employeeCount = numMatch[1].replace(/,/g, ''); break; }
  }
  // Strategy 2: data-field="staff_count" or known class selectors
  if (!employeeCount) {
    for (const sel of [
      '[data-field="staff_count"]',
      '.org-top-card-summary-info-list__info-item',
      '.org-about-company-module__company-size-definition-text',
    ]) {
      for (const el of document.querySelectorAll(sel)) {
        const text = el.textContent?.trim() || '';
        if (/employee/i.test(text) && /\d/.test(text)) { employeeCount = text; break; }
      }
      if (employeeCount) break;
    }
  }
  // Strategy 3: any text containing "employees"
  if (!employeeCount) {
    for (const el of document.querySelectorAll('span, div, li')) {
      const t = el.textContent?.trim() || '';
      if (/\d[\d,]*\s*[-–]?\s*\d*[\d,]*\s*employees?/i.test(t) && t.length < 80) {
        employeeCount = t; break;
      }
    }
  }

  // Follower count
  let followerCount: string | null = null;
  const all = document.querySelectorAll('span, div, li, p');
  for (const el of all) {
    const t = el.textContent?.trim() || '';
    if (/[\d,]+\s*followers?/i.test(t) && t.length < 60) {
      followerCount = t; break;
    }
  }

  // Headquarters — for country and city
  let headquarters: string | null = null;
  for (const dt of document.querySelectorAll('dt')) {
    if (/^headquarters$/i.test(dt.textContent?.trim() ?? '')) {
      headquarters = dt.nextElementSibling?.textContent?.trim() || null;
      break;
    }
  }
  let city: string | null = null;
  let country: string | null = null;
  if (headquarters) {
    const parts = headquarters.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      city = parts[0];
      country = parts[parts.length - 1];
    } else if (parts.length === 1) {
      country = parts[0];
    }
  }

  return { companyName, websiteUrl, linkedinUrl, industry, employeeCount, followerCount, country, city };
}
