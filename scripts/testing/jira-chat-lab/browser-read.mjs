import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { workspaceStorageArgs } from "../../lib/workspace-storage-fixture.mjs";
import { labSessionConnection, readPrivateFile } from "./lab-client.mjs";
import { assertVerifiedPod, connectPodFromPanel, verifyPodAction } from "./browser-connections.mjs";
import { consentCardCount, establishedReadGrant } from "./read-grant.mjs";

function stage(value) {
  console.log(JSON.stringify({ operation: "jira-chat-live-browser", stage: value }));
}
export async function openBrowser(chat, origin) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1100 },
    locale: "en-US",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  if (chat !== undefined)
    await page.addInitScript(
      ({ argument: { id, title }, storageKeys }) => {
        const seeded = "keiko.jira-browser-fixture.seeded.v1";
        if (globalThis.window.sessionStorage.getItem(seeded) !== "true") {
          globalThis.window.localStorage.setItem(
            storageKeys.workspace,
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
          globalThis.window.localStorage.removeItem(storageKeys.connections);
          globalThis.window.sessionStorage.setItem(seeded, "true");
        }
      },
      await workspaceStorageArgs(page, { id: chat.id, title: chat.title }),
    );
  return { browser, page };
}
async function createPodThroughForm(page, hub, session, options, label) {
  const tokenFile = options.tokenFile ?? join(session.directory, "secrets", "api-token");
  await hub.getByRole("button", { name: "Create Jira Pod", exact: true }).click();
  stage("hub-open");
  const form = hub.getByTestId("acx-add-form");
  await form.getByLabel("Label", { exact: true }).fill(label);
  await form
    .getByLabel("Base URL", { exact: true })
    .fill(labSessionConnection(session).httpsOrigin);
  await form.getByLabel("API token", { exact: true }).fill(readPrivateFile(tokenFile).trim());
  await options.onPhase?.({ phase: "pod-creation-may-have-started" });
  return verifyPodAction(page, () =>
    form.getByRole("button", { name: "Create Jira Pod", exact: true }).click(),
  );
}
/** Reuse a recorded verified Pod by identity; creation still goes through the existing UI. */
export async function createPod(page, session, options = {}) {
  const label = options.label ?? "Browser Jira";
  const trigger = page.getByRole("button", { name: "Local Knowledge", exact: true });
  await trigger.click();
  const hub = page.getByRole("region", { name: /Local Knowledge/ });
  try {
    const identity =
      options.podId === undefined
        ? await createPodThroughForm(page, hub, session, options, label)
        : { podId: options.podId };
    const card = hub.getByTestId("acx-connector").filter({
      has: hub.getByText(label, { exact: true }),
    });
    assert.equal(await card.count(), 1, "The verified Pod has one exact Hub card");
    const credential = await assertVerifiedPod(page, card, { ...identity, displayName: label });
    assert.ok(
      (await card.getAttribute("data-auth-ref")) === credential.authRef,
      "The observed Hub card is the verified native Pod",
    );
    const pod = { podId: credential.livePod.podId };
    await options.onPod?.(pod);
    stage("pod-verified");
    return pod;
  } finally {
    await trigger.click();
  }
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
  const { browser, page } = await openBrowser(chat, origin);
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
