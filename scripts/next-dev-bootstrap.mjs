import { createNextVersionFetch } from "./lib/next-version-fetch.mjs";

// Installed only in the Next development child and its fork. Product BFF release fetches retain
// their own transport, deadlines and release verification.
globalThis.fetch = createNextVersionFetch(globalThis.fetch.bind(globalThis), () => {
  console.error("[dev:next] Optional framework version metadata timed out; status is unknown.");
});
