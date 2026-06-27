import type { ExtractedContent } from '../types';

// Self-contained — injected into company website tabs via chrome.scripting.executeScript({ func }).
// Handles React, Next.js, Vue, Angular SPAs (content already rendered by the time we inject).
export function extractWebsiteContent(): ExtractedContent {
  const title = document.title || '';

  const metaDescription =
    (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content ||
    (document.querySelector('meta[property="og:description"]') as HTMLMetaElement | null)?.content ||
    (document.querySelector('meta[name="twitter:description"]') as HTMLMetaElement | null)?.content ||
    '';

  function getHeadings(tag: string, limit: number): string[] {
    return Array.from(document.querySelectorAll(tag))
      .map(el => (el as HTMLElement).innerText?.trim() ?? '')
      .filter(t => t.length > 1 && t.length < 200)
      .slice(0, limit);
  }

  const h1s = getHeadings('h1', 5);
  const h2s = getHeadings('h2', 10);

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME', 'HEADER', 'FOOTER', 'NAV']);
  const textParts: string[] = [];
  let totalLen = 0;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return NodeFilter.FILTER_REJECT;
      }
      const text = (node.textContent ?? '').trim();
      return text.length >= 15 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode()) && totalLen < 5000) {
    const text = (node.textContent ?? '').trim();
    if (text) { textParts.push(text); totalLen += text.length + 1; }
  }

  return {
    title,
    metaDescription,
    h1s,
    h2s,
    bodyText: textParts.join(' ').substring(0, 5000),
    url: window.location.href,
  };
}
