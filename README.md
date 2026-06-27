# Zilvo Analyze — LinkedIn Website Screenshot

A production-ready Chrome Extension (Manifest V3) that:

1. Takes a LinkedIn company URL
2. Extracts the company's website URL from the LinkedIn About page
3. Opens the website in a temporary window
4. Captures a screenshot
5. Saves it to `Downloads/zilvo-screenshots/`

---

## Folder structure

```
zilvo-analyze-extension/
├── manifest.json            # MV3 extension manifest
├── background.js            # Service worker — orchestrates the full pipeline
├── popup.html               # Extension popup UI
├── popup.js                 # Popup controller (ES module)
├── styles.css               # Dark-mode popup styles
├── content/
│   └── linkedin.js          # Standalone LinkedIn extractor (reference / debug)
├── helpers/
│   ├── utils.js             # URL validation, filename sanitiser, CSV export
│   └── storage.js           # chrome.storage.local wrapper
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── scripts/
    └── generate-icons.py    # Regenerates PNG icons from scratch
```

---

## Install in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder (`zilvo-analyze-extension/`)
5. The Zilvo icon appears in the toolbar

> Tip: pin the extension by clicking the puzzle-piece icon → pin Zilvo Analyze.

---

## Usage

### Single URL

1. Click the toolbar icon to open the popup
2. Paste a LinkedIn company URL:
   `https://www.linkedin.com/company/openai/`
3. Click **Capture Screenshot**
4. Watch the progress steps update in real time
5. The PNG is saved to `Downloads/zilvo-screenshots/<company-name>.png`

### Bulk URLs

1. Open the **Bulk Processing** panel
2. Paste one LinkedIn URL per line
3. Click **Process All URLs**
4. A progress bar tracks each capture; a 3-second pause between requests
   prevents LinkedIn rate-limiting

### Screenshot History

- All completed captures are recorded in the **Screenshot History** panel
- **Export CSV** downloads a spreadsheet with company name, LinkedIn URL,
  website URL, filename, and capture date
- **Clear** removes all stored history

---

## How extraction works

The background service worker:

1. Opens `https://www.linkedin.com/company/{slug}/about/` in a background tab
2. Waits for the tab to reach `status: "complete"`, then waits an extra 3.5 s
   for LinkedIn's React content to render
3. Injects `linkedInExtractorFn` via `chrome.scripting.executeScript`
4. The injected function tries **five extraction strategies** in order:
   - `[data-field="website"] a` — LinkedIn's own field attribute
   - `a[data-tracking-control-name*="website"]` — tracking attribute
   - `dt` "Website" label → sibling `dd` link
   - External links inside known about-section CSS classes
   - Any link whose text / aria-label contains "website" / "visit site"
5. LinkedIn tracking redirect URLs (`l.linkedin.com/l.php?url=…`) are decoded
   to the real destination before being returned
6. Returns `{ name, websiteUrl }` — an error message if nothing is found

> **Login required:** LinkedIn will redirect to the login wall if you are not
> signed in. Sign in to LinkedIn in your Chrome profile and the extension will
> work automatically.

---

## How screenshot capture works

1. The company website is opened via `chrome.windows.create` in a 1280×800
   popup window
2. The extension waits for `status: "complete"`, then waits 2 s for fonts and
   lazy-loaded images
3. `chrome.tabs.captureVisibleTab(windowId)` captures the viewport as a PNG
4. The window is immediately closed
5. `chrome.downloads.download` saves the file to
   `Downloads/zilvo-screenshots/{company}.png`

> A brief popup window will appear while the screenshot is taken — this is
> required because `captureVisibleTab` needs a visible, non-minimised window.

---

## Error handling

| Scenario | Behaviour |
|---|---|
| Invalid LinkedIn URL | Inline validation error before any request |
| LinkedIn not loaded in time | Timeout error after 30 s |
| Login wall detected | Clear message asking user to sign in |
| Website URL not found | Error with explanation; no screenshot attempted |
| Website load timeout | Error after 30 s |
| Screenshot capture failure | Error surfaced in popup |
| Transient network errors | Auto-retry once with 2.5 s backoff |

---

## Permissions used

| Permission | Why |
|---|---|
| `tabs` | Create / close / query tabs |
| `activeTab` | Needed alongside scripting |
| `scripting` | `executeScript` to inject extractor into LinkedIn |
| `storage` | Persist screenshot history |
| `downloads` | Save PNG files |
| `windows` | Create popup window for screenshot capture |
| `https://*.linkedin.com/*` | Host permission for script injection |
| `<all_urls>` | Capture screenshots of any company website |

---

## Regenerate icons

```bash
python3 scripts/generate-icons.py
```

The script produces solid 6c63ff (purple) PNG icons with a white Z glyph at
all required sizes (16, 32, 48, 128 px).
