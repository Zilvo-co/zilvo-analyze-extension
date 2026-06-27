export function normalizeLinkedInUrl(url: string): string {
  const trimmed = url.trim();
  const withProtocol = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname.includes('linkedin.com')) throw new Error('Not a LinkedIn URL');
    parsed.protocol = 'https:';
    return parsed.origin + parsed.pathname.replace(/\/$/, '');
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'Not a LinkedIn URL') throw e;
    throw new Error('Invalid LinkedIn URL');
  }
}

export function isValidLinkedInCompanyUrl(url: string): boolean {
  try {
    return /linkedin\.com\/company\//i.test(normalizeLinkedInUrl(url));
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForTabComplete(tabId: number, timeout = 30_000): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeout);

    function listener(id: number, info: chrome.tabs.TabChangeInfo) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}
