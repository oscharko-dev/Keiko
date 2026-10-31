import assert from "node:assert/strict";
import { join } from "node:path";
import { URL } from "node:url";
import { readPrivateFile } from "./lab-client.mjs";
import { jsonRequest } from "./chat-read.mjs";

function read(context, path) {
  return jsonRequest(
    context.origin,
    context.cookie,
    "browser-lifecycle-observe",
    path,
    undefined,
    "GET",
  );
}
function chatPath(context, chat) {
  return `/api/chats?id=${encodeURIComponent(chat.id)}&projectPath=${encodeURIComponent(context.projectPath)}`;
}
async function credentials(context) {
  return (await read(context, "/api/atlassian-connectors/credentials")).credentials;
}
async function reloadHub(page) {
  const loaded = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/atlassian-connectors/credentials",
  );
  await page.reload();
  assert.equal((await loaded).status(), 200);
  const hub = page.getByRole("region", { name: /Local Knowledge/ });
  await hub.waitFor({ state: "visible" });
  return hub;
}
async function save(page, card, button) {
  const response = page.waitForResponse(
    (item) =>
      item.request().method() === "PATCH" &&
      new URL(item.url()).pathname.startsWith("/api/atlassian-connectors/credentials/"),
  );
  await card.getByRole("button", { name: button, exact: true }).click();
  assert.equal((await response).status(), 200);
}
async function rename(page, card, context, identity) {
  await card.getByRole("button", { name: "Rename Pod", exact: true }).click();
  await card
    .getByRole("form", { name: "Rename Jira Pod", exact: true })
    .getByLabel("Label", { exact: true })
    .fill("Renamed browser Jira");
  await save(page, card, "Save name");
  const renamed = (await credentials(context)).find((item) => item.authRef === identity.authRef);
  assert.equal(renamed.displayName, "Renamed browser Jira");
  assert.equal(renamed.livePod.podId, identity.livePod.podId);
  const hub = await reloadHub(page);
  const persisted = hub.getByTestId("acx-connector").filter({ hasText: "Renamed browser Jira" });
  await persisted.waitFor({ state: "visible" });
  const afterReload = (await credentials(context)).find(
    (item) => item.authRef === identity.authRef,
  );
  assert.equal(afterReload.displayName, "Renamed browser Jira");
  assert.equal(afterReload.livePod.podId, identity.livePod.podId);
  return { credential: renamed, reloaded: true };
}
async function rotate(page, card, context, identity) {
  await card.getByRole("button", { name: "Replace token", exact: true }).click();
  const token = readPrivateFile(join(context.session.directory, "secrets", "editor-token")).trim();
  assert.notEqual(
    token,
    readPrivateFile(join(context.session.directory, "secrets", "api-token")).trim(),
  );
  await card.getByLabel("New API token", { exact: true }).fill(token);
  await save(page, card, "Save token");
  const rotated = (await credentials(context)).find((item) => item.authRef === identity.authRef);
  assert.equal(rotated.livePod.podId, identity.livePod.podId);
  assert.ok(rotated.livePod.authenticationGeneration > identity.livePod.authenticationGeneration);
  assert.equal(rotated.livePod.verificationStatus, "unverified");
  await card
    .getByText("Verify this connection before using it in Chat.", { exact: true })
    .waitFor();
  const hub = await reloadHub(page);
  const persisted = hub.getByTestId("acx-connector").filter({ hasText: "Renamed browser Jira" });
  await persisted
    .getByText("Verify this connection before using it in Chat.", { exact: true })
    .waitFor();
  const afterReload = (await credentials(context)).find(
    (item) => item.authRef === identity.authRef,
  );
  assert.equal(afterReload.livePod.podId, identity.livePod.podId);
  assert.equal(
    afterReload.livePod.authenticationGeneration,
    rotated.livePod.authenticationGeneration,
  );
  assert.equal(afterReload.livePod.verificationStatus, "unverified");
  return { credential: rotated, reloaded: true };
}
async function reverify(page, card, context, identity) {
  await card.getByRole("button", { name: "Verify connection", exact: true }).click();
  await card.locator('[data-status="ok"]').waitFor();
  const verified = (await credentials(context)).find((item) => item.authRef === identity.authRef);
  assert.equal(verified.livePod.verificationStatus, "ok");
  assert.equal(
    verified.livePod.authenticationGeneration,
    identity.livePod.authenticationGeneration,
  );
  const hub = await reloadHub(page);
  const persisted = hub.getByTestId("acx-connector").filter({ hasText: "Renamed browser Jira" });
  await persisted.locator('[data-status="ok"]').waitFor();
  const afterReload = (await credentials(context)).find(
    (item) => item.authRef === identity.authRef,
  );
  assert.equal(afterReload.livePod.verificationStatus, "ok");
  assert.equal(
    afterReload.livePod.authenticationGeneration,
    identity.livePod.authenticationGeneration,
  );
  return true;
}
async function remove(page, card, context, identity, chat) {
  await card.getByRole("button", { name: "Remove Pod", exact: true }).click();
  const dialog = card.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Keep Pod", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Remove Pod", exact: true }).click();
  await card.waitFor({ state: "detached" });
  assert.equal(
    (await credentials(context)).some((item) => item.authRef === identity.authRef),
    false,
  );
  const current = await read(context, chatPath(context, chat));
  assert.equal(current.chats[0].jiraPodBinding, undefined);
  const hub = await reloadHub(page);
  await hub
    .getByText("No Jira Pods yet. Create one to connect Jira to a Chat.", { exact: true })
    .waitFor();
  assert.equal(
    (await credentials(context)).some((item) => item.authRef === identity.authRef),
    false,
  );
  const afterReload = await read(context, chatPath(context, chat));
  assert.equal(afterReload.chats[0].jiraPodBinding, undefined);
  return true;
}

async function existingGrant(page, context, completed) {
  const id = completed.messages.find((message) => message.role === "user").toolTranscript.readGrant
    .grantId;
  const path = `/api/atlassian-connectors/action-approvals/${encodeURIComponent(id)}/chat-read-consent`;
  const response = await page.request.get(context.origin + path);
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).approval.state, "granted");
  return path;
}

async function confirmDisconnectedChat(page, region, connection) {
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  await region.waitFor({ state: "visible" });
  await region.getByText("Tool access", { exact: true }).waitFor();
  await region.locator('details[data-testid="jira-chat-connection"] summary').waitFor();
  await region
    .locator("summary")
    .filter({ hasText: "Renamed browser Jira" })
    .waitFor({ state: "detached" });
  if (connection !== "dropdown") {
    await page.locator(".conn-path:not(.conn-temp)").waitFor({ state: "detached" });
    await page.getByText(/Jira Pod unavailable/u).waitFor();
  }
}

/** Executes only explicit visible lifecycle controls; confirms public custody and Chat state independently. */
export async function qualifyBrowserLifecycle(page, context, chat, completed, connection) {
  const identity = (await credentials(context)).find((item) => item.displayName === "Browser Jira");
  assert.ok(identity?.livePod);
  const consentPath = await existingGrant(page, context, completed);
  const region = page.getByRole("region", { name: /Synthetic Jira browser Chat/ });
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  const hub = page.getByRole("region", { name: /Local Knowledge/ });
  const initialCard = hub.getByTestId("acx-connector").filter({ hasText: "Browser Jira" });
  const renameResult = await rename(page, initialCard, context, identity);
  const renamed = renameResult.credential;
  await region
    .locator("summary")
    .filter({ hasText: "Renamed browser Jira" })
    .waitFor({ state: "attached" });
  const card = hub.getByTestId("acx-connector").filter({ hasText: "Renamed browser Jira" });
  const rotationResult = await rotate(page, card, context, renamed);
  const rotated = rotationResult.credential;
  const current = await read(context, chatPath(context, chat));
  assert.equal(current.chats[0].jiraPodBinding.podId, identity.livePod.podId);
  assert.equal(
    current.chats[0].jiraPodBinding.authenticationGeneration,
    rotated.livePod.authenticationGeneration,
  );
  const invalidated = await page.request.get(context.origin + consentPath);
  assert.equal(invalidated.status(), 404);
  assert.equal((await invalidated.json()).error.code, "CHAT_READ_CONSENT_UNAVAILABLE");
  const reloadedAfterReverification = await reverify(page, card, context, rotated);
  const reloadedAfterRemoval = await remove(page, card, context, identity, chat);
  await confirmDisconnectedChat(page, region, connection);
  return {
    renamed: true,
    rotated: true,
    reloadedAfterRename: renameResult.reloaded,
    reloadedAfterTokenReplacement: rotationResult.reloaded,
    reloadedAfterReverification,
    reloadedAfterRemoval,
    oldGrantInvalidated: true,
    reverified: true,
    removed: true,
    chatDisconnected: true,
  };
}
