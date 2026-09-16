import { extractLinkedInData } from '../content/linkedin';
import { extractWebsiteContent } from '../content/website';
import { classifyCompany } from '../utils/api';
import { waitForTabComplete, sleep, normalizeLinkedInUrl } from '../utils/helpers';
import { zilvoFetch, logout as zilvoLogout } from '../utils/zilvoApi';
import { getActiveToken, clearAllTokens, adoptToken } from '../utils/authToken';
import { TOKEN_ORIGINS, TOKEN_RESET_VERSION, getAppOrigins, API } from '../config';
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
  // Never read chrome.storage directly — getActiveToken() is the one resolver
  // the popup uses too, so /api/company-intelligence/analyze and /api/credits
  // always send the SAME token.
  const token = await getActiveToken();
  return token ? { token } : null;
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

  // Submit to backend — server fetches content + runs OpenAI analysis.
  // The billable `ci.analyze` action is charged SERVER-SIDE here; do not charge
  // client-side. zilvoFetch surfaces 401 (session expired) / 402 (insufficient
  // credits) as typed errors.
  sendCIProgress('analyzing', 'Analyzing company with AI…');
  const { zilvoIcpId } = await chrome.storage.local.get({ zilvoIcpId: '' });
  const saved = await zilvoFetch<{ jobId: string }>(
    API.analyze,
    {
      method: 'POST',
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
        icpId:                 (zilvoIcpId as string)     || undefined,
      }),
    },
    auth.token
  );
  return { jobId: saved.jobId };
}

// One-time purge on install, and on update whenever TOKEN_RESET_VERSION has
// changed — so the move to app.zilvo.co / api.zilvo.co cannot carry a legacy
// token forward, while ordinary version bumps do not log anyone out.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  chrome.storage.local.get({ zilvoTokenResetVersion: '' }, ({ zilvoTokenResetVersion }) => {
    if (zilvoTokenResetVersion === TOKEN_RESET_VERSION) return;
    console.log('[Zilvo] token reset —', zilvoTokenResetVersion || 'none', '→', TOKEN_RESET_VERSION);
    clearAllTokens()
      .then(() => chrome.storage.local.set({ zilvoTokenResetVersion: TOKEN_RESET_VERSION }))
      .catch(console.error);
  });
});

// ── Website ↔ Extension auth sync ────────────────────────────────────────────
// Messages arrive from zilvoSync.ts content script running on zilvo.co pages.

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'websiteLogin') {
    const { token, user } = request as {
      token: string;
      user?: { name?: string; email?: string; credits?: number };
    };
    if (!token) return;
    // adoptToken rejects an expired token and refuses to let a stale tab
    // re-syncing on focus overwrite a newer session.
    adoptToken(token, user)
      .then(ok => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // The popup asks for the token instead of reading chrome.storage, so it sends
  // the same token as the analyze pipeline.
  if (request.action === 'getActiveToken') {
    getActiveToken()
      .then(token => sendResponse({ token: token || null }))
      .catch(() => sendResponse({ token: null }));
    return true;
  }

  if (request.action === 'websiteLogout') {
    (async () => {
      // The content script runs on the marketing and legacy hosts too, and
      // those never hold a token — so "no token here" is only a logout when it
      // comes from the host that actually owns the login. Otherwise merely
      // opening zilvo.co would sign out a popup-authenticated user, and the
      // logout tombstone would make that permanent.
      const senderUrl = _sender.tab?.url || '';
      const appOrigins = await getAppOrigins();
      const fromAppOrigin = appOrigins.some(pattern => {
        const origin = pattern.replace(/\/\*$/, '');
        return senderUrl.startsWith(origin);
      });
      if (!fromAppOrigin) {
        console.log('[Zilvo] websiteLogout — ignoring non-app origin:', senderUrl || '(unknown)');
        sendResponse({ ok: false, ignored: true });
        return;
      }
      await clearAllTokens().catch(console.error);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (request.action === 'extensionLogout') {
    const token = (request as { token?: string }).token;

    (async () => {
      // Invalidate server-side with the same token everything else uses.
      // Resolved BEFORE the purge — afterwards there is nothing left to read.
      const authToken = token || (await getActiveToken());

      // Await the whole purge before responding. Replying first and letting the
      // wipe run detached let MV3 shut the service worker down mid-purge, which
      // is how a half-cleared session survived a logout.
      await Promise.all([
        authToken ? zilvoLogout(authToken).catch(console.error) : Promise.resolve(),
        clearAllTokens().catch(console.error),
      ]);

      // Storage, localStorage and cookies are gone; now redirect the open tabs.
      const tabs = await chrome.tabs.query({ url: TOKEN_ORIGINS }).catch(() => [] as chrome.tabs.Tab[]);
      await Promise.all(
        tabs.map(tab =>
          tab.id
            ? chrome.tabs.sendMessage(tab.id, { action: 'clearWebsiteAuth' }).catch(() => {})
            : Promise.resolve()
        )
      );

      sendResponse({ ok: true });
    })();

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
        // Forward the typed fields (401/402 + required/remaining) so the popup can
        // render an actionable prompt (re-auth / top-up) instead of a bare string.
        const e = err as { code?: number; required?: number; remaining?: number };
        // Expired session → purge every copy of the token, otherwise the stale
        // localStorage copy gets re-adopted on the very next call.
        if (e?.code === 401) clearAllTokens().catch(console.error);
        chrome.runtime
          .sendMessage({ type: 'CI_ERROR', error, code: e?.code, required: e?.required, remaining: e?.remaining })
          .catch(() => {});
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
