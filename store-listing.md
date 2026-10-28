# Chrome Web Store listing — Zilvo Analyze (v1.1.1)

Copy-paste ready. Store fields marked **[required]**.

---

## Name **[required]**

```
Zilvo Analyze
```

## Short description (search result summary, max 132) **[required]**

From `manifest.json` → `description`. Current value (95 chars) is valid:

```
Company Intelligence: analyze companies from LinkedIn or any website and send data to Zilvo AI.
```

Recommended replacement (132 max — changing this requires rebuilding the zip):

```
Analyze LinkedIn companies, websites and lists. Get structured company profiles and ICP fit scores in Zilvo.
```

## Category

`Productivity` (alternative: `Tools`)

## Language

`English (United States)`

## Detailed description **[required]**

```
Zilvo Analyze turns any company — a LinkedIn page, a company website, or an entire prospect list — into a structured company profile scored against your Ideal Customer Profile, without ever leaving the browser.

Built for sales, go-to-market and research teams who need to qualify companies fast, and for anyone who already works in Zilvo.

WHAT YOU CAN DO
• Analyze a LinkedIn company page — open any linkedin.com/company/... page and the extension detects it automatically. One click sends it for analysis.
• Analyze a company website — open the site, or paste a URL.
• Bulk analyze from CSV — upload a list of LinkedIn company URLs or websites, download a ready-made example file, and run the whole batch in one go.
• Score an extracted list — pick a project from your Zilvo workspace and score every company already in an extraction. No CSV export, no re-upload.
• Choose your ICP — select which positioning every result is scored against. Set it once and it becomes your default across Zilvo.
• Results in one place — analyses, history and credit usage live in your Zilvo workspace, so nothing is lost when you close the panel.

HOW IT WORKS
1. Click the Zilvo icon to open the side panel and sign in with your Zilvo account.
2. Open a LinkedIn company page or a website, or paste a URL or upload a CSV.
3. Pick your ICP and press Analyze. The result is saved to your workspace and your credit balance updates automatically.

WHAT YOU GET
• Company classification — what the business does, industry, business model, products and services.
• ICP fit scoring against your own positioning.
• Batch qualification of prospect and account lists.
• One workflow for LinkedIn pages, websites and existing extractions.

CREDITS
Zilvo Analyze runs on a pay-as-you-go credit wallet. Credits are charged only when an analysis is actually executed, and every charge is computed on Zilvo's servers.

PRIVACY
Your sign-in session is kept in your browser's local extension storage. The company details and page content you submit are sent over HTTPS to Zilvo (api.zilvo.co) solely to produce the analysis you asked for, and are stored in your account so you can review them later. The extension does not collect your browsing history and does not sell data. Full policy: https://zilvo.co/privacy-policy

REQUIREMENTS
• A Zilvo account with available credits.
• Chrome 114 or newer (side panel support).

Zilvo is independent of LinkedIn and Google. LinkedIn is a trademark of Microsoft Corporation.

SUPPORT
Questions or feedback: hello@zilvo.co — https://zilvo.co
```

## Single purpose statement **[required]**

```
Analyze a company the user selects — from a LinkedIn company page, any company website, or a list they upload — and return a structured company profile scored against the user's Ideal Customer Profile in their Zilvo workspace.
```

## Permission justifications **[required — one per permission]**

`storage`

```
Storage holds the extension's own state, locally, on the user's device. No page content and no browsing history is stored.

chrome.storage.local:
• zilvo_auth — the Zilvo session (token, account name/email, credit balance), so the panel stays signed in between opens and each API request can be authorised. It is kept in sync with the Zilvo web app, so signing in or out on zilvo.co updates the extension.
• zilvoIcpId — the ICP the user selected, so analyses are scored against the same positioning next time.
• zilvo_pending_list — which extraction the user asked to analyse, so the panel opens on it.
• liManualUrl / webManualUrl — the last URL the user typed, so it is not lost when the panel closes.

chrome.storage.session holds only the most recent scrape result for the current browser session and is discarded when Chrome closes.

Nothing is written to the user's tabs or to any third-party storage, and uninstalling the extension removes all of it.
```

`tabs`

```
Reads the active tab's URL to detect whether the user is on a LinkedIn company page or a company website they want to analyze, and opens a background tab for a URL the user explicitly submits.
```

`activeTab`

```
Temporary access to the current tab when the user clicks Analyze, so the read-only company extractor can run in that tab only. Access is scoped to the user's action and revoked on navigation. Used for the "analyze the company I'm looking at" flow without standing access to that site.
```

> Note: `activeTab` is redundant while `<all_urls>` is a host permission — nothing in the code depends on it. Remove it for a leaner review, unless website analysis is moving to `optional_host_permissions` (then it becomes the mechanism that unlocks a site on the user's gesture).

`scripting`

```
Scripting runs two small, read-only extractor functions inside the page the user chose to analyze. Nothing on the page is modified and no remote code is executed: both functions ship inside the package and are passed to scripting.executeScript as a function reference (func:), never as a string.

1) LinkedIn extractor — reads the visible company name, industry, employee count, follower count and the company's website link from a LinkedIn company page. Top frame only (allFrames: false).

2) Website extractor — reads the visible headings, paragraphs and links of the company website the user submitted, capped at 8,000 characters, so the analysis can describe what the business does.

3) Link scan — on a company website the user is viewing, checks whether it links to a LinkedIn company page, so the panel can offer that page for analysis.

Injection happens only after an explicit user action (Analyze). The extension does not inject on page load and runs nothing in the background.
```

`sidePanel`

```
The product's entire interface runs in Chrome's side panel — there is no popup window. The panel is declared in the manifest (side_panel.default_path = popup.html) and the sidePanel permission is what allows the extension to control it.

setPanelBehavior({ openPanelOnActionClick: true }) makes the toolbar icon open the side panel instead of a popup. This is how every user starts the extension.

sidePanel.open({ tabId }) is called when the user clicks "Open in Zilvo Analyze" on an extraction page inside the Zilvo web app, so the panel opens beside that tab and lands directly on the list they chose.

The permission only controls where the extension's own UI is displayed. No page content is read or modified through it, and no data is collected. Without it the extension would have no interface at all.
```

`host_permissions` — `https://*.linkedin.com/*`

```
Reads the LinkedIn company page the user chooses to analyze. When a linkedin.com/company/... page is in the user's active tab, the extension injects its read-only extractor (only after the user clicks Analyze) to read the visible company name, industry, employee count, follower count and the company's website link. No member or profile data is read, no other LinkedIn pages are visited, and nothing is scraped in the background or through automated browsing.
```

`host_permissions` — `https://zilvo.co/*`, `https://www.zilvo.co/*`

```
Runs the auth-bridge content script on Zilvo's own website so the extension mirrors the session the user already has there: it reads the token and user object that the Zilvo web app stores in its own localStorage, passes them to the extension, and clears them when the user signs out. Also used to open the Zilvo sign-in and account pages.
```

`host_permissions` — `https://app.zilvo.co/*`

```
Runs the same auth bridge on the Zilvo application so signing in or out in the web app immediately updates the extension, and receives the "Open in Zilvo Analyze" request from an extraction page so the side panel opens on the list the user selected. Only the session token and user object the app itself stores are read; no analysis data is read from the page.
```

`host_permissions` — `https://api.zilvo.co/*`

```
The extension's only backend. Sends the analysis the user requested (POST /api/company-intelligence/analyze) with the user's own bearer token, and reads back the result, the credit balance and the user's saved ICPs. Always over HTTPS, only for an action the user started, and no other server is contacted.
```

`host_permissions` — `<all_urls>`

```
Company Analyze accepts any company website, so the domains cannot be known in advance. Access happens only through an action the user starts:

• the user opens a site and clicks Analyze, or types, pastes or uploads a URL or CSV;
• the extension then loads that one page, reads its visible text (headings, paragraphs, links — capped at 8,000 characters) and closes the tab;
• on a site the user is already viewing, it performs a read-only scan for a link to the company's LinkedIn page.

There is no background crawling, no reading of tabs the user did not act on, no history and no analytics. A fixed domain list is impossible because the target is whichever company the user chooses to research.
```

`host_permissions` — `http://localhost:3000/*`, `http://localhost:3001/*`

```
Chrome requires a single static manifest, so the Zilvo web app's local environment (localhost:3000 and localhost:3001) is declared alongside production. The same auth-bridge content script runs there, so a session created in the locally hosted Zilvo app syncs to the extension while the analyze flow is tested. These two entries grant access only to a server running on the user's own machine; they give no access to any other website.
```

> Kept as-is per decision to ship the manifest unchanged. Note that a reviewer may still ask about localhost in a production build — the wording above is the honest answer, so use it if they do.

## Remote code **[required]**

```
No, I am not using remote code.
```

All JavaScript ships inside the package. The extension exchanges only data (JSON) with `api.zilvo.co`.

## Data usage / privacy practices **[required]**

Data collected — declare at minimum:

| Category | Why |
|---|---|
| **Authentication information** | Sign-in session token and account email, stored locally and sent to Zilvo to authenticate API calls |
| **Website content** | Public page content of the company the user chose to analyze, sent to Zilvo to generate the analysis |

Consider also declaring **Personally identifiable information** (account email/name) and **Web history** (the URL of the page the user asks to analyze) if your compliance view is conservative — it matches sections 3.6/3.8 of the Zilvo privacy policy. Under-declaring is a common cause of review rejection.

Certify all three required statements:

- Data is **not** sold to third parties — ✔ true
- Data is **not** used for purposes unrelated to the single purpose — ✔ true
- Data is **not** used for creditworthiness or lending — ✔ true

## Privacy policy URL **[required]**

```
https://zilvo.co/privacy-policy
```

Already live and section **5.5 Zilvo Company Analyze** covers this extension. Optional but recommended: add an explicit sentence naming "Zilvo Analyze Chrome Extension" next to section 5.5, plus the local-storage note in 7.5, so a reviewer can match policy to product in one click.

## Support / homepage URLs

```
Homepage:  https://zilvo.co
Support:   https://zilvo.co/contact   (or mailto:hello@zilvo.co)
```

## Graphic assets

- Store icon 128×128 — ✔ have `icons/icon128.png`
- At least **1 screenshot**, 1280×800 or 640×400 — side panel open on a LinkedIn company page, and the results/ICP view
- Small promo tile 440×280 — optional, needed for featured placement

## "What's new" (release notes for 1.1.1)

```
• Refreshed side panel UI.
• Choose which ICP each analysis is scored against, from the panel.
• Analysis now runs only on an explicit click — no credits spent on page load.
• Clearer credit and result states while a job is running.
```
