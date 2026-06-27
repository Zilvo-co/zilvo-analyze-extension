/**
 * helpers/utils.js
 * Shared utility functions used across the extension.
 */

/**
 * Validates that a URL is a LinkedIn company page.
 * Accepts: https://www.linkedin.com/company/{slug}[/...]
 */
export function isValidLinkedInCompanyUrl(url) {
  try {
    const parsed = new URL(url.trim());
    return (
      (parsed.hostname === 'www.linkedin.com' || parsed.hostname === 'linkedin.com') &&
      /^\/company\/[a-zA-Z0-9\-_.%]+/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Normalizes any LinkedIn company URL to the /about/ sub-page,
 * which consistently surfaces the website field.
 */
export function normalizeLinkedInUrl(url) {
  const match = url.match(/linkedin\.com\/company\/([a-zA-Z0-9\-_.%]+)/);
  if (!match) throw new Error('Cannot parse LinkedIn company slug from URL');
  return `https://www.linkedin.com/company/${match[1]}/about/`;
}

/**
 * Converts a company name into a safe filename (no spaces or special chars).
 * e.g. "OpenAI, Inc." → "openai-inc"
 */
export function sanitizeFilename(name) {
  return String(name || 'screenshot')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'screenshot';
}

/** Simple async sleep helper. */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Decodes LinkedIn's l.linkedin.com tracking redirect URLs to the real URL.
 * e.g. https://l.linkedin.com/l.php?url=https%3A%2F%2Fopenai.com → https://openai.com
 */
export function decodeLinkedInTrackingUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'l.linkedin.com') {
      const target = parsed.searchParams.get('url');
      if (target) return decodeURIComponent(target);
    }
    if (parsed.hostname.endsWith('linkedin.com') && parsed.pathname === '/redir/redirect') {
      const target = parsed.searchParams.get('url');
      if (target) return decodeURIComponent(target);
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Formats a Unix timestamp (ms) into a human-readable local date/time string.
 */
export function formatTimestamp(ts) {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

/**
 * Converts a history array into CSV text ready for download.
 */
export function historyToCSV(history) {
  const headers = ['Company Name', 'LinkedIn URL', 'Website URL', 'Filename', 'Date'];
  const escape = v => `"${String(v || '').replace(/"/g, '""')}"`;
  const rows = history.map(h => [
    escape(h.companyName),
    escape(h.linkedinUrl),
    escape(h.websiteUrl),
    escape(h.filename),
    escape(formatTimestamp(h.timestamp))
  ].join(','));
  return [headers.join(','), ...rows].join('\r\n');
}

/**
 * Checks whether an error message indicates a transient (retryable) failure.
 */
export function isRetryableError(error) {
  const retryableKeywords = ['timeout', 'network', 'load', 'failed to fetch'];
  const msg = (error?.message || '').toLowerCase();
  return retryableKeywords.some(k => msg.includes(k));
}
