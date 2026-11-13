const listeners = [];
const storage = { zilvo_guest_token: 'guest-token' };
const messages = [];
const noop = () => {};
const base = {
  runtime: { lastError: undefined, onMessage: { addListener: (fn) => listeners.push(fn) }, onInstalled: { addListener: noop }, onStartup: { addListener: noop }, sendMessage: (m) => { messages.push(m); return Promise.resolve(); }, getPlatformInfo: () => Promise.resolve({}), setUninstallURL: noop },
  storage: { local: { get: (keys, cb) => { const list = Array.isArray(keys) ? keys : [keys]; const out = {}; for (const k of list) if (k in storage) out[k] = storage[k]; if (cb) { cb(out); return; } return Promise.resolve(out); }, set: (obj, cb) => { Object.assign(storage, obj); if (cb) cb(); return Promise.resolve(); }, remove: (keys, cb) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete storage[k]; if (cb) cb(); return Promise.resolve(); } }, onChanged: { addListener: noop } },
  tabs: { query: () => Promise.resolve([]), create: () => Promise.resolve({}), onActivated: { addListener: noop }, onUpdated: { addListener: noop }, get: () => Promise.resolve(null), update: () => Promise.resolve({}) },
  sidePanel: { setPanelBehavior: () => Promise.resolve() },
  action: { onClicked: { addListener: noop } },
  notifications: { onButtonClicked: { addListener: noop }, onClicked: { addListener: noop }, create: noop },
  downloads: { download: () => Promise.resolve(1) },
  cookies: { get: () => Promise.resolve(null) },
  scripting: { executeScript: () => Promise.resolve([]) },
  webRequest: { onBeforeSendHeaders: { addListener: noop }, onCompleted: { addListener: noop }, onErrorOccurred: { addListener: noop }, onHeadersReceived: { addListener: noop } },
  alarms: { create: noop, onAlarm: { addListener: noop } },
};
globalThis.chrome = new Proxy(base, { get(t, k) { return k in t ? t[k] : { addListener: noop, removeListener: noop, create: noop, clear: noop }; } });

let poll = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/api/public/company-analyzer/bulk')) {
    const body = JSON.parse(opts.body);
    // 5 submitted, 4 unique (one duplicate host), all 4 accepted.
    const accepted = ['a.com', 'b.com', 'c.com', 'd.com'].map((h, i) => ({ jobId: `job-${i}`, website: `https://${h}`, status: 'queued' }));
    return { ok: true, status: 200, text: async () => JSON.stringify({ accepted, rejected: [], counts: { submitted: body.urls.length, unique: 4, duplicates: 1, accepted: 4, quotaRejected: 0 }, limit: 10, used: 4, remaining: 6 }) };
  }
  if (u.includes('/api/public/company-analyzer/results')) {
    poll += 1;
    const done = poll >= 2;
    const results = ['job-0', 'job-1', 'job-2', 'job-3'].map((id, i) => ({
      jobId: id,
      status: done ? 'done' : i === 0 ? 'done' : i === 1 ? 'processing' : 'queued',
      companyName: `Co ${i}`,
      error: null,
    }));
    return { ok: true, status: 200, text: async () => JSON.stringify({ results, finished: done, quota: { remaining: 6 } }) };
  }
  return { ok: false, status: 404, text: async () => '{}' };
};

await import('./background.js');
const msg = { action: 'START_BULK_WEBSITE', urls: ['https://a.com', 'https://www.a.com', 'https://b.com', 'https://c.com', 'https://d.com'], fileName: 'test.csv', guest: true };
let responded = null;
for (const fn of listeners) fn(msg, { origin: 'chrome-extension://x' }, (r) => { responded = r; });
await new Promise(r => setTimeout(r, 9000));
console.log('response:', responded);
console.log('rows:', (storage.zilvoBulkRows || []).map(r => ({ url: r.url, kind: r.kind, label: r.label })));
console.log('last:', storage.zilvoBulkLast ? { phase: storage.zilvoBulkLast.phase, guestCounts: storage.zilvoBulkLast.guestCounts } : null);
console.log('active:', storage.zilvoBulkActive);
console.log('quota broadcasts:', messages.filter(m => m.action === 'guestQuotaUpdated'));
