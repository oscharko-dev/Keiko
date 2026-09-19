import { expect, type Page } from "@playwright/test";

// Opens a new chat composer the way a person does: Chat History, then New.
//
// Dev CI run 35438847738 lost the Chat History window's chunk to a WebKit network process crash:
// every request in flight failed without an error event, and the window waited on "Loading…" until
// the journey timed out. The product now reports such a stalled chunk and offers the reload that
// requests it fresh (WindowChunkFallback). This helper takes that product recovery once, as a person
// would; a chunk that stalls again after the reload still fails the journey.
export async function openChatComposer(page: Page): Promise<void> {
  await page.goto("/");
  const chatHistory = page.getByRole("button", { name: "Chat History", exact: true });
  await chatHistory.click();
  const newChat = page.getByRole("button", { name: "New", exact: true });
  const reload = page.getByRole("button", { name: "Reload Keiko", exact: true });
  await expect(newChat.or(reload)).toBeVisible({ timeout: 30_000 });
  if (await reload.isVisible()) {
    const reloaded = page.waitForEvent("load");
    await reload.click();
    await reloaded;
    // The reload restores the Chat History window the workspace persisted; that restore is part
    // of the recovery, so the helper never reopens (and thereby toggles) the window itself.
  }
  await newChat.click();
  await expect(page.getByRole("textbox", { name: "Chat message" }).first()).toBeVisible();
}
