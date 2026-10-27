import { expect, test } from "@playwright/test";
import {
  api,
  counts,
  createAndConnect,
  currentChat,
  fixture,
  messages,
  openJiraChat,
  send,
} from "./support/jira-chat-4081.js";

test("ordinary Chat requires read consent and exact write approval through real MCP", async ({
  page,
}) => {
  const region = await openJiraChat(page, "approval");
  await createAndConnect(page, region, "Jira approval fixture");
  const before = counts();
  await send(region, "JIRA_E2E_READ: read the connected Jira projects.");
  const allow = region.getByRole("button", { name: "Allow reading", exact: true });
  await expect(allow).toBeVisible();
  expect(counts().projects).toBe(before.projects);
  await allow.click();
  await expect.poll(() => counts().projects).toBe(before.projects + 1);
  await expect(region.getByText("JIRA_E2E_DONE", { exact: true })).toBeVisible();
  await send(region, "JIRA_E2E_COMMENT: add the synthetic approval fixture comment.");
  const approval = region.getByRole("button", { name: "Approve this action", exact: true });
  await expect(approval).toBeEnabled();
  await expect(region.getByLabel("Proposed action details")).toHaveValue(
    /Synthetic browser approval fixture/u,
  );
  expect(counts().writes).toBe(before.writes);
  await approval.click();
  await expect(region.getByText("Jira change confirmed", { exact: true })).toBeVisible();
  expect(counts().writes).toBe(before.writes + 1);
  expect(counts().confirmations).toBe(before.confirmations + 1);
  expect(counts().leaks).toBe(0);
  const stored = await messages(page, fixture().chats.approval.id);
  const write = stored
    .flatMap((message) => message.toolTranscript?.exchanges ?? [])
    .find((exchange) => exchange.call.name === "jira_comment");
  expect(write?.mutationOutcome).toBe("succeeded");
  expect(write?.approval?.state).toBe("claimed");
});

test("a forged decision and a disconnected Chat cannot dispatch the pending write", async ({
  page,
}) => {
  const region = await openJiraChat(page, "revocation");
  await createAndConnect(page, region, "Jira revoked fixture");
  const before = counts();
  await send(region, "JIRA_E2E_COMMENT: add the synthetic approval fixture comment.");
  await region.getByRole("button", { name: "Allow reading", exact: true }).click();
  await expect(
    region.getByRole("button", { name: "Approve this action", exact: true }),
  ).toBeEnabled();
  const chatId = fixture().chats.revocation.id;
  const stored = await messages(page, chatId);
  const approval = stored
    .flatMap((message) => message.toolTranscript?.exchanges ?? [])
    .find((exchange) => exchange.approval)?.approval;
  if (approval === undefined) throw new Error("Missing persisted exact-action approval");
  const path = `/api/atlassian-connectors/action-approvals/${approval.approvalId}/chat-write-approval`;
  const forged = await api(page, path, "POST", {
    decision: "approve",
    actionDigest: "0".repeat(64),
  });
  expect(forged.status).toBe(409);
  expect(counts().writes).toBe(before.writes);
  const current = await currentChat(page, chatId);
  const disconnected = await api(page, `/api/chats?id=${chatId}`, "PATCH", {
    jiraPodId: null,
    expectedGroundingScopeIdentity: current.groundingScopeIdentity,
  });
  expect(disconnected.status).toBe(200);
  const stale = await api(page, path, "POST", {
    decision: "approve",
    actionDigest: approval.actionDigest,
  });
  expect(stale.status).toBe(404);
  await expect
    .poll(
      async () =>
        (await messages(page, chatId)).find((message) => message.role === "user")?.turnState,
    )
    .toBe("cancelled");
  expect(counts().writes).toBe(before.writes);
  expect(counts().confirmations).toBe(before.confirmations);
  await expect(region.getByText("Jira change confirmed", { exact: true })).toHaveCount(0);
});

test("a bound unverified model shows actionable unavailability without provider or Jira effects", async ({
  page,
}) => {
  const region = await openJiraChat(page, "unavailable");
  await createAndConnect(page, region, "Jira unavailable fixture");
  const before = counts();
  await send(region, "JIRA_E2E_READ: read the connected Jira projects.");
  await expect(region.getByText("Model capability unavailable", { exact: true })).toBeVisible();
  await expect(region.getByText(/For Jira access, run the tool-calling check/u)).toBeVisible();
  expect(counts()).toEqual(before);
  await expect(region.getByRole("button", { name: "Allow reading", exact: true })).toHaveCount(0);
});
