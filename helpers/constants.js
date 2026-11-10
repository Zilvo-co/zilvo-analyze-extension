/**
 * helpers/constants.js
 *
 * Re-export only. Every Zilvo URL lives in ../shared/zilvo-urls.js, which the
 * React extension under src/ reads too — edit the environment THERE, not here.
 * This file exists so the legacy extension's existing imports keep working.
 */
export {
  ZILVO_ENV,
  ZILVO_API,
  ZILVO_APP,
  ZILVO_SITE,
  API,
  APP,
  apiUrl,
  appUrl,
  analysisResultUrl,
  TOKEN_ORIGINS,
  TOKEN_COOKIE_DOMAINS,
} from '../shared/zilvo-urls.js';
