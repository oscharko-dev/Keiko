import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { readPrivateFile } from "./lab-client.mjs";
import { connectPodFromPanel, readyChip } from "./browser-connections.mjs";
import { consentCardCount, establishedReadGrant } from "./read-grant.mjs";

function stage(value) {
  console.log(JSON.stringify({ operation: "jira-chat-live-browser", stage: value }));
}
export async function openBrowser(chat) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    locale: "en-US",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.addInitScript(
    ({ id, title }) => {
      const seeded = "keiko.jira-browser-fixture.seeded.v1";
      if (globalThis.window.sessionStorage.getItem(seeded) !== "true") {
        globalThis.window.localStorage.setItem(
          "keiko.workspace.v4",
          JSON.stringify([
            {
              id: "jira-browser-chat",
              type: "chat",
              x: 32,
              y: 30,
              w: 1000,
              h: 900,
              z: 10,
              cfg: { chatId: id, title },
              max: false,
            },
          ]),
        );
        globalThis.window.localStorage.removeItem("keiko.conns.v1");
        globalThis.window.sessionStorage.setItem(seeded, "true");
      }
    },
    { id: chat.id, title: chat.title },
  );
  return { browser, page };
}
export async function createPod(page, session) {
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  const hub = page.getByRole("region", { name: /Local Knowledge/ });
  await hub.getByRole("button", { name: "Create Jira Pod", exact: true }).click();
  stage("hub-open");
  const form = hub.getByTestId("acx-add-form");
  await form.getByLabel("Label", { exact: true }).fill("Browser Jira");
  await form.getByLabel("Base URL", { exact: true }).fill("https://127.0.0.1:18443");
  await form
    .getByLabel("API token", { exact: true })
    .fill(readPrivateFile(join(session.directory, "secrets", "api-token")).trim());
  await form.getByRole("button", { name: "Create Jira Pod", exact: true }).click();
  const verify = hub.getByTestId("acx-connector").filter({ hasText: "Browser Jira" });
  // A new Pod is unverified, so its one visible repair action is "Verify connection".
  await verify.getByRole("button", { name: "Verify connection", exact: true }).click();
  await readyChip(verify).waitFor();
  stage("pod-verified");
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
}
async function connectAndSend(page) {
  const chat = page.getByRole("region", {
    name: /Synthetic Jira browser Chat/,
  });
  await connectPodFromPanel(page, chat, "Browser Jira");
  stage("chat-connected");
  await chat
    .getByRole("textbox", { name: "Chat message", exact: true })
    .fill(
      "Use the Jira projects tool to read the connected Jira project list. Reply with the returned project keys only.",
    );
  stage("prompt-entered");
  await chat.getByRole("button", { name: "Send message", exact: true }).click();
  stage("message-sent");
  return chat;
}
const FAILED_TURNS = new Set(["failed", "cancelled"]);
/** The read happens without any card: every poll of the turn finds none, and the grant is the server's. */
async function confirmCompleted(observe, region) {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const { messages } = await observe();
    const user = messages.find((item) => item.role === "user");
    assert.equal(await consentCardCount(region), 0);
    establishedReadGrant(user);
    if (user?.turnState === "completed") {
      assert.ok(establishedReadGrant(user), "The server establishes the read grant itself");
      const read = user.toolTranscript?.exchanges.find(
        (item) => item.call.name === "jira_projects",
      );
      assert.equal(read?.result?.status, "completed");
      assert.ok(read.result.data.items.some((item) => item.key === "KEIKO"));
      assert.ok(
        messages.some((item) => item.role === "assistant" && item.content.includes("KEIKO")),
      );
      return;
    }
    if (FAILED_TURNS.has(user?.turnState)) throw new TypeError("Browser Chat did not complete");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  }
  throw new TypeError("Browser Chat completion timed out");
}
export async function runBrowserRead({ origin, fragment, chat, session, observe }) {
  const { browser, page } = await openBrowser(chat);
  try {
    await page.goto(origin + fragment);
    stage("page-open");
    await createPod(page, session);
    const region = await connectAndSend(page);
    await confirmCompleted(observe, region);
    await region.getByText("Completed", { exact: true }).waitFor();
    await region.getByText("KEIKO", { exact: true }).waitFor();
    await region.screenshot({ path: join(session.directory, "browser-read.png") });
    stage("completed");
  } catch (error) {
    await page.screenshot({ path: join(session.directory, "browser-read-failure.png") });
    throw error;
  } finally {
    await browser.close();
  }
}
