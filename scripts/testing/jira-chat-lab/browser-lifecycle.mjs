import assert from "node:assert/strict";
import { join } from "node:path";
import { URL } from "node:url";
import { readPrivateFile } from "./lab-client.mjs";
import { jsonRequest } from "./chat-read.mjs";
import {
  assertPodNotConnected,
  checked,
  closeConnectors,
  openConnectors,
  podSwitch,
} from "./browser-connections.mjs";
import { establishedReadGrant } from "./read-grant.mjs";

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
/** The card's quiet "…" menu holds every action that is not the one visible repair action. */
async function menuAction(card, label) {
  await card.getByRole("button", { name: /^More actions:/u }).click();
  await card.getByRole("menuitem", { name: label, exact: true }).click();
}
function readyChip(card) {
  return card.getByTestId("acx-pod-state").filter({ hasText: /^Ready$/u });
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
  await menuAction(card, "Rename Pod");
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
  await menuAction(card, "Replace token");
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
  await card.getByText("Verify the connection before using this Pod.", { exact: true }).waitFor();
  await card
    .getByTestId("acx-pod-state")
    .filter({ hasText: /^Not verified yet$/u })
    .waitFor();
  const hub = await reloadHub(page);
  const persisted = hub.getByTestId("acx-connector").filter({ hasText: "Renamed browser Jira" });
  await persisted
    .getByText("Verify the connection before using this Pod.", { exact: true })
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
  // The token replacement left the Pod unverified, so "Verify connection" is the visible action.
  await card.getByRole("button", { name: "Verify connection", exact: true }).click();
  await readyChip(card).waitFor();
  const verified = (await credentials(context)).find((item) => item.authRef === identity.authRef);
  assert.equal(verified.livePod.verificationStatus, "ok");
  assert.equal(
    verified.livePod.authenticationGeneration,
    identity.livePod.authenticationGeneration,
  );
  const hub = await reloadHub(page);
  const persisted = hub.getByTestId("acx-connector").filter({ hasText: "Renamed browser Jira" });
  await readyChip(persisted).waitFor();
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
  await menuAction(card, "Remove Pod");
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
  await hub.getByText("No Jira Pods yet.", { exact: true }).waitFor();
  assert.equal(
    (await credentials(context)).some((item) => item.authRef === identity.authRef),
    false,
  );
  const afterReload = await read(context, chatPath(context, chat));
  assert.equal(afterReload.chats[0].jiraPodBinding, undefined);
  return true;
}

/** The read grant the server established for the completed turn; no human decision created it. */
function establishedGrant(completed) {
  const grant = establishedReadGrant(completed.messages.find((message) => message.role === "user"));
  assert.ok(grant, "The server establishes the read grant itself");
  assert.equal(grant.state, "granted");
  return grant;
}

/** The retired consent route is gone for good: it can neither read nor revive a grant. */
async function assertConsentRouteRetired(page, context, grant) {
  const path = `/api/atlassian-connectors/action-approvals/${encodeURIComponent(grant.grantId)}/chat-read-consent`;
  assert.equal((await page.request.get(context.origin + path)).status(), 404);
}

async function confirmDisconnectedChat(page, region, connection) {
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  await region.waitFor({ state: "visible" });
  await assertPodNotConnected(page, region, "Renamed browser Jira");
  if (connection !== "dropdown") {
    await page.locator(".conn-path:not(.conn-temp)").waitFor({ state: "detached" });
    await page.getByText(/Jira Pod unavailable/u).waitFor();
  }
}

/** The Chat's Connectors panel shows the renamed Pod still switched on for this Chat. */
async function confirmRenamedConnection(page, region) {
  const toggle = page.getByRole("button", { name: "Local Knowledge", exact: true });
  await toggle.click();
  await openConnectors(page, region);
  await checked(page, podSwitch(page, "Renamed browser Jira")).waitFor();
  await closeConnectors(region);
  await toggle.click();
  await page.getByRole("region", { name: /Local Knowledge/ }).waitFor({ state: "visible" });
}

/** Executes only explicit visible lifecycle controls; confirms public custody and Chat state independently. */
export async function qualifyBrowserLifecycle(page, context, chat, completed, connection) {
  const identity = (await credentials(context)).find((item) => item.displayName === "Browser Jira");
  assert.ok(identity?.livePod);
  const grant = establishedGrant(completed);
  await assertConsentRouteRetired(page, context, grant);
  const region = page.getByRole("region", { name: /Synthetic Jira browser Chat/ });
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  const hub = page.getByRole("region", { name: /Local Knowledge/ });
  const initialCard = hub.getByTestId("acx-connector").filter({ hasText: "Browser Jira" });
  const renameResult = await rename(page, initialCard, context, identity);
  const renamed = renameResult.credential;
  await confirmRenamedConnection(page, region);
  const card = hub.getByTestId("acx-connector").filter({ hasText: "Renamed browser Jira" });
  const rotationResult = await rotate(page, card, context, renamed);
  const rotated = rotationResult.credential;
  const current = await read(context, chatPath(context, chat));
  assert.equal(current.chats[0].jiraPodBinding.podId, identity.livePod.podId);
  assert.equal(
    current.chats[0].jiraPodBinding.authenticationGeneration,
    rotated.livePod.authenticationGeneration,
  );
  // The grant belongs to the superseded authentication generation, so it cannot cover the new
  // token: the Chat's binding moved on while the grant the server established did not.
  assert.ok(grant.authenticationGeneration < rotated.livePod.authenticationGeneration);
  assert.equal(
    current.chats[0].jiraPodBinding.authenticationGeneration,
    rotated.livePod.authenticationGeneration,
  );
  await assertConsentRouteRetired(page, context, grant);
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
    readGrantEstablishedByServer: true,
    reverified: true,
    removed: true,
    chatDisconnected: true,
  };
}
