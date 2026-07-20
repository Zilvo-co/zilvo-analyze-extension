import { extractLinkedInData } from '../content/linkedin';
import { extractWebsiteContent } from '../content/website';
import { classifyCompany } from '../utils/api';
import { waitForTabComplete, sleep, normalizeLinkedInUrl } from '../utils/helpers';
import { getZilvoBaseUrl } from '../config';
import type { AppSettings, ClassificationResult, LinkedInData, ExtractedContent, ProgressStep } from '../types';

const LINKEDIN_RENDER_DELAY = 3_500;
const WEBSITE_RENDER_DELAY = 2_000;

async function getSettings(): Promise<AppSettings> {
  return new Promise(resolve => {
    chrome.storage.local.get({ apiKey: '', model: 'claude-haiku-4-5-20251001' }, items => {
      resolve(items as AppSettings);
    });
  });
}

function sendProgress(step: ProgressStep, message: string) {
  chrome.runtime.sendMessage({ type: 'CLASSIFICATION_PROGRESS', step, message }).catch(() => {});
}

async function openBackgroundTab(url: string): Promise<number> {
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) throw new Error('Failed to create tab');
  await waitForTabComplete(tab.id);
  return tab.id;
}

async function closeTab(tabId: number) {
  await chrome.tabs.remove(tabId).catch(() => {});
}

async function classifyPipeline(linkedinUrl: string): Promise<{
  result: ClassificationResult;
  companyName: string | null;
  websiteUrl: string | null;
}> {
  const settings = await getSettings();
  let linkedInTabId: number | null = null;
  let websiteTabId: number | null = null;

  try {
    sendProgress('opening_linkedin', 'Opening LinkedIn company page…');
    linkedInTabId = await openBackgroundTab(normalizeLinkedInUrl(linkedinUrl));
    await sleep(LINKEDIN_RENDER_DELAY);

    sendProgress('extracting_linkedin', 'Extracting company website URL…');
    const [liResult] = await chrome.scripting.executeScript({
      target: { tabId: linkedInTabId },
      func: extractLinkedInData,
    });
    const linkedInData = liResult.result as LinkedInData;
    await closeTab(linkedInTabId);
    linkedInTabId = null;

    if (!linkedInData.websiteUrl) {
      throw new Error(linkedInData.error ?? 'Could not find company website URL on LinkedIn page');
    }

    sendProgress('opening_website', `Opening ${linkedInData.websiteUrl}…`);
    websiteTabId = await openBackgroundTab(linkedInData.websiteUrl);
    await sleep(WEBSITE_RENDER_DELAY);

    sendProgress('extracting_content', 'Extracting page content…');
    const [wsResult] = await chrome.scripting.executeScript({
      target: { tabId: websiteTabId },
      func: extractWebsiteContent,
    });
    const content = wsResult.result as ExtractedContent;
    await closeTab(websiteTabId);
    websiteTabId = null;

    sendProgress('classifying', 'Running AI classification…');
    const result = await classifyCompany(content, settings);

    return { result, companyName: linkedInData.companyName, websiteUrl: linkedInData.websiteUrl };
  } finally {
    if (linkedInTabId) await closeTab(linkedInTabId);
    if (websiteTabId) await closeTab(websiteTabId);
  }
}

// ── Company Intelligence pipeline ────────────────────────────────────────────

async function getZilvoAuth(): Promise<{ token: string } | null> {
  return new Promise(resolve => {
    chrome.storage.local.get({ zilvoToken: '' }, items => {
      resolve(items.zilvoToken ? { token: items.zilvoToken as string } : null);
    });
  });
}


function sendCIProgress(step: string, message: string) {
  chrome.runtime.sendMessage({ type: 'CI_PROGRESS', step, message }).catch(() => {});
}

async function extractWithRetry(tabId: number, maxRetries = 2): Promise<import('../types').LinkedInData> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractLinkedInData,
    });
    const data = result.result as import('../types').LinkedInData;
    if (data.websiteUrl || attempt === maxRetries) return data;
    await sleep(2000);
  }
  return { companyName: null, websiteUrl: null, error: 'Could not find website URL after retries' };
}

// CI pipeline — if the website URL is already known (extracted by the popup from the current tab),
// skip opening LinkedIn and go straight to backend submission.
// The backend handles website fetching + OpenAI analysis server-side.
async function runCIPipeline(msg: import('../types').AnalyzeForCIMessage): Promise<{ jobId: string }> {
  const auth = await getZilvoAuth();
  if (!auth) throw new Error('Not logged in to Zilvo. Please log in from the extension.');

  let resolvedWebsite = msg.websiteUrl;
  let resolvedName    = msg.companyName;

  // Only open a background LinkedIn tab if we don't already have the website URL
  if (msg.linkedinUrl && !resolvedWebsite) {
    sendCIProgress('opening_linkedin', 'Opening LinkedIn company page…');
    const liTabId = await openBackgroundTab(normalizeLinkedInUrl(msg.linkedinUrl));
    await sleep(LINKEDIN_RENDER_DELAY);

    sendCIProgress('extracting_linkedin', 'Extracting company website URL…');
    const liData = await extractWithRetry(liTabId);
    await closeTab(liTabId);

    if (liData.websiteUrl) resolvedWebsite = liData.websiteUrl;
    if (liData.companyName && !resolvedName) resolvedName = liData.companyName;
    if (!resolvedWebsite) throw new Error('Could not find website URL on LinkedIn page.');
  }

  if (!resolvedWebsite) throw new Error('No website URL available for analysis.');

  // Submit to backend — server fetches content + runs OpenAI analysis
  sendCIProgress('analyzing', 'Analyzing company with AI…');
  const baseUrl = await getZilvoBaseUrl();
  const saveRes = await fetch(`${baseUrl}/api/company-intelligence/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${auth.token}`,
    },
    body: JSON.stringify({
      linkedinUrl:           msg.linkedinUrl            || undefined,
      websiteUrl:            resolvedWebsite,
      companyName:           resolvedName               || undefined,
      linkedinIndustry:      msg.linkedinIndustry       || undefined,
      linkedinEmployeeCount: msg.linkedinEmployeeCount  || undefined,
      linkedinFollowerCount: msg.linkedinFollowerCount  || undefined,
      linkedinCountry:       msg.linkedinCountry        || undefined,
      linkedinCity:          msg.linkedinCity           || undefined,
      pageContent:           msg.pageContent            || undefined,
      userInputField:        msg.userInputField         || undefined,
      batchId:               msg.batchId               || undefined,
    }),
  });

  if (!saveRes.ok) {
    const errData = await saveRes.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((errData.error as string) || `Analysis failed (${saveRes.status})`);
  }

  const saved = await saveRes.json() as { jobId: string };
  return { jobId: saved.jobId };
}

// ── Website ↔ Extension auth sync ────────────────────────────────────────────
// Messages arrive from zilvoSync.ts content script running on zilvo.co pages.

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'websiteLogin') {
    const { token, user } = request as {
      token: string;
      user?: { name?: string; email?: string; credits?: number };
    };
    if (!token) return;
    const name  = user?.name  || user?.email || '';
    const email = user?.email || '';
    chrome.storage.local.set({ zilvoToken: token, zilvoName: name, zilvoEmail: email }, () => {
      chrome.runtime
        .sendMessage({ action: 'authStateChanged', loggedIn: true, token, name, email })
        .catch(() => {});
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'websiteLogout') {
    chrome.storage.local.remove(['zilvoToken', 'zilvoName', 'zilvoEmail'], () => {
      chrome.runtime
        .sendMessage({ action: 'authStateChanged', loggedIn: false })
        .catch(() => {});
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'extensionLogout') {
    const token = (request as { token?: string }).token;

    getZilvoBaseUrl().then(baseUrl => {
      const logoutCall = token
        ? fetch(`${baseUrl}/api/auth/logout`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          }).catch(console.error)
        : Promise.resolve();

      const domains = ['zilvo.co', 'www.zilvo.co', 'app.zilvo.co'];
      const clearCookies = async () => {
        for (const domain of domains) {
          const cookies = await chrome.cookies.getAll({ domain });
          for (const cookie of cookies) {
            const protocol = cookie.secure ? 'https' : 'http';
            await chrome.cookies
              .remove({ url: `${protocol}://${domain}${cookie.path}`, name: cookie.name })
              .catch(() => {});
          }
        }
      };

      Promise.all([logoutCall, clearCookies()]).then(() => {
        chrome.tabs.query(
          { url: ['https://zilvo.co/*', 'https://www.zilvo.co/*', 'https://app.zilvo.co/*', 'http://localhost:3000/*'] },
          tabs => {
            for (const tab of tabs) {
              if (tab.id) chrome.tabs.sendMessage(tab.id, { action: 'clearWebsiteAuth' }).catch(() => {});
            }
          }
        );
      });
    });

    sendResponse({ ok: true });
    return true;
  }
});

// ── CI & Classify pipeline message handlers ───────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ANALYZE_FOR_CI') {
    runCIPipeline(message as import('../types').AnalyzeForCIMessage)
      .then(({ jobId }) => {
        chrome.runtime.sendMessage({ type: 'CI_COMPLETE', jobId }).catch(() => {});
        sendResponse({ ok: true, jobId });
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        chrome.runtime.sendMessage({ type: 'CI_ERROR', error }).catch(() => {});
        sendResponse({ ok: false, error });
      });

    return true;
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'CLASSIFY_COMPANY') return;

  classifyPipeline(message.linkedinUrl as string)
    .then(({ result, companyName, websiteUrl }) => {
      chrome.runtime.sendMessage({
        type: 'CLASSIFICATION_COMPLETE',
        result,
        companyName,
        websiteUrl,
      }).catch(() => {});
      sendResponse({ ok: true });
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      chrome.runtime.sendMessage({ type: 'CLASSIFICATION_ERROR', error }).catch(() => {});
      sendResponse({ ok: false, error });
    });

  return true;
});
