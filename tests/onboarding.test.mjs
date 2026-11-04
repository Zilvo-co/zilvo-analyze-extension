import test from "node:test";
import assert from "node:assert/strict";
import { onboardingUrlFor, GETTING_STARTED_URL } from "../helpers/onboarding.js";

test("fresh install opens the getting-started page", () => {
  assert.equal(onboardingUrlFor("install"), GETTING_STARTED_URL);
  assert.equal(GETTING_STARTED_URL, "https://zilvo.co/tools/company-analyzer/getting-started/");
});

test("updates and other reasons open nothing", () => {
  for (const r of ["update", "chrome_update", "shared_module_update", undefined]) assert.equal(onboardingUrlFor(r), null);
});
