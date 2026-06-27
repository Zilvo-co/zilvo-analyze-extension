/**
 * helpers/storage.js
 * Thin wrapper around chrome.storage.local for screenshot history management.
 */

const HISTORY_KEY = 'zilvo_screenshot_history';
const MAX_ENTRIES = 100;

/**
 * Retrieves the full screenshot history array (newest first).
 * Returns an empty array if nothing is stored yet.
 */
export async function getHistory() {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  return result[HISTORY_KEY] ?? [];
}

/**
 * Prepends a new entry to the history, capping at MAX_ENTRIES.
 * @param {Object} entry - { linkedinUrl, websiteUrl, companyName, filename, timestamp }
 * @returns {Array} The updated history array.
 */
export async function saveHistoryEntry(entry) {
  const history = await getHistory();
  const updated = [entry, ...history].slice(0, MAX_ENTRIES);
  await chrome.storage.local.set({ [HISTORY_KEY]: updated });
  return updated;
}

/**
 * Removes all history entries from storage.
 */
export async function clearHistory() {
  await chrome.storage.local.remove(HISTORY_KEY);
}

/**
 * Removes a single history entry by its 0-based index.
 */
export async function removeHistoryEntry(index) {
  const history = await getHistory();
  history.splice(index, 1);
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}
