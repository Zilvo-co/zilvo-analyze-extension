export const ZILVO_API_DEFAULT = 'https://app.zilvo.co';

export function getZilvoBaseUrl(): Promise<string> {
  return new Promise(resolve => {
    chrome.storage.local.get({ zilvoBaseUrl: ZILVO_API_DEFAULT }, items => {
      resolve(items.zilvoBaseUrl as string);
    });
  });
}
