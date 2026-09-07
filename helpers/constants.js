/**
 * helpers/constants.js
 * Common constant configurations for the extension.
 */

// ZILVO_API — where the REST API lives (fetch calls only).
// ZILVO_APP — where the web app lives (login, signup, dashboards): every URL
//             that gets OPENED IN A TAB. These are DIFFERENT hosts; opening a
//             page on the API host is a 404.
// For local dev point both at 'http://localhost:3000'.

// export const ZILVO_API = 'http://localhost:3000';
export const ZILVO_API = 'https://api.zilvo.co';

// export const ZILVO_APP = 'http://localhost:3000';
export const ZILVO_APP = 'https://app.zilvo.co';
