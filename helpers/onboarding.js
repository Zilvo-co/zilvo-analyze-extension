// First-install onboarding: open the Zilvo getting-started guide for this extension.
// Only on a fresh install, never on updates or Chrome restarts.
export const GETTING_STARTED_URL = "https://zilvo.co/tools/company-analyzer/getting-started/";

export function onboardingUrlFor(reason) {
  return reason === "install" ? GETTING_STARTED_URL : null;
}
