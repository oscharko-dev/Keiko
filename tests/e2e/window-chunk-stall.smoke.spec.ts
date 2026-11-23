// Window chunk stall regression smoke (dev CI run 35438847738).
//
// WebKit's network process crashed while the Chat History window's chunk was loading: every request
// in flight failed without an error event, the bundler kept the lost chunk request pending, and the
// window waited on "Loading…" until the journey timed out. A chunk request that never answers is
// that incident. The window must say it did not finish loading and offer the reload that requests
// the chunk fresh, and the reloaded workspace must open the window it restored.
//
// Tagged @smoke so every engine in the required browser lanes proves the recovery.

import { expect, test } from "@playwright/test";
import { openChatComposer } from "./support/chat-composer.js";

test("window chunk @smoke — a chunk request that never answers offers a reload that recovers the window", async ({
  page,
}) => {
  let lost = 0;
  // The journeys run against the release build, whose chunk files carry hashed names (#4123); a
  // development bundler names the module in the file name instead. The Chat History window's chunk
  // is the one that names the panel in its URL or registers the panel's export.
  await page.route(/\/_next\/static\/chunks\/[^?#]+\.js(?:[?#]|$)/u, async (route) => {
    if (lost === 0 && route.request().url().includes("ChatHistoryPanel")) {
      // Never answered, as in the incident: the request stays pending and no error event fires.
      lost += 1;
      return;
    }
    const response = await route.fetch();
    if (lost === 0 && (await response.text()).includes('["ChatHistoryPanel",')) {
      lost += 1;
      return;
    }
    await route.fulfill({ response });
  });

  await openChatComposer(page);

  expect(lost).toBe(1);
  await expect(page.locator("[data-window-chunk]")).toHaveCount(0);
});
