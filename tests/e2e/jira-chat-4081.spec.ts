import { expect, test, type Page, type Locator } from "@playwright/test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";
import { parseJiraDraftReference } from "@oscharko-dev/keiko-connectors";
import { join } from "node:path";
import { jiraAccessibilityJourney } from "./support/jira-chat-4081-accessibility.js";
import {
  api,
  counts,
  createAndConnect,
  currentChat,
  fixture,
  messages,
  openJiraChat,
  selectAskForApproval,
  send,
} from "./support/jira-chat-4081.js";

test("ordinary Chat restores a pending approval and completed receipt without duplicate writes", async ({
  page,
}) => {
  const region = await openJiraChat(page, "approval");
  await createAndConnect(page, region, "Jira approval fixture");
  await selectAskForApproval(page, region);
  const before = counts();
  await send(region, "JIRA_E2E_READ: read the connected Jira projects.");
  await expect.poll(() => counts().projects).toBe(before.projects + 1);
  await expect(region.getByText("JIRA_E2E_DONE", { exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "Allow reading", exact: true })).toHaveCount(0);
  await send(region, "JIRA_E2E_COMMENT: add the synthetic approval fixture comment.");
  const approval = region.getByRole("button", { name: "Approve this action", exact: true });
  await expect(approval).toBeEnabled();
  const details = region.getByRole("group", { name: "Proposed action details" });
  await expect(details).toContainText("Synthetic browser approval fixture");
  await expect(details).not.toContainText(/[{}]/u);
  expect(counts().writes).toBe(before.writes);
  const pending = (await messages(page, fixture().chats.approval.id))
    .flatMap((message) => message.toolTranscript?.exchanges ?? [])
    .find((exchange) => exchange.call.name === "jira_comment")?.approval;
  if (pending === undefined) throw new Error("Missing persisted pending write approval");
  const approvalCard = region.getByRole("region", { name: "Review Jira action", exact: true });
  const pendingText = await approvalCard.innerText();
  await page.reload();
  await expect.poll(() => approvalCard.innerText()).toBe(pendingText);
  await expect(approval).toBeEnabled();
  const restoredApproval = (await messages(page, fixture().chats.approval.id))
    .flatMap((message) => message.toolTranscript?.exchanges ?? [])
    .find((exchange) => exchange.call.name === "jira_comment")?.approval;
  expect(restoredApproval).toMatchObject({
    approvalId: pending.approvalId,
    actionDigest: pending.actionDigest,
    state: "pending",
  });
  expect(counts().writes).toBe(before.writes);
  expect(counts().confirmations).toBe(before.confirmations);
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
  const receipt = region
    .getByRole("region", { name: "Jira action", exact: true })
    .filter({ hasText: "Jira change confirmed" });
  const receiptText = await receipt.innerText();
  await page.reload();
  await expect.poll(() => receipt.innerText()).toBe(receiptText);
  await expect(approval).toHaveCount(0);
  // An already-used approval is retained by the actual server registry across page reload;
  // replaying the human decision cannot start a second native write.
  const repeated = await api(
    page,
    `/api/atlassian-connectors/chat-write-approval/${pending.approvalId}`,
    "POST",
    { decision: "approve", actionDigest: pending.actionDigest },
  );
  expect(repeated.status).toBe(409);
  expect(counts().writes).toBe(before.writes + 1);
  expect(counts().confirmations).toBe(before.confirmations + 1);
});

test("Stop revokes a restored pending approval and permits a fresh read without writing", async ({
  page,
}) => {
  const region = await openJiraChat(page, "pending-stop");
  await createAndConnect(page, region, "Jira pending Stop fixture");
  await selectAskForApproval(page, region);
  const before = counts();
  await send(region, "JIRA_E2E_COMMENT: add the synthetic approval fixture comment.");
  await expect(
    region.getByRole("button", { name: "Approve this action", exact: true }),
  ).toBeEnabled();
  const pending = (await messages(page, fixture().chats["pending-stop"].id))
    .flatMap((message) => message.toolTranscript?.exchanges ?? [])
    .find((exchange) => exchange.approval?.state === "pending")?.approval;
  if (pending === undefined) throw new TypeError("Missing pending Stop fixture approval");
  await page.reload();
  await expect(
    region.getByRole("button", { name: "Approve this action", exact: true }),
  ).toBeEnabled();
  await region.getByRole("button", { name: "Cancel response", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await messages(page, fixture().chats["pending-stop"].id)).find((message) =>
          message.toolTranscript?.exchanges.some(
            (exchange) => exchange.approval?.approvalId === pending.approvalId,
          ),
        )?.turnState,
    )
    .toBe("cancelled");
  const replay = await api(
    page,
    `/api/atlassian-connectors/chat-write-approval/${pending.approvalId}`,
    "POST",
    { decision: "approve", actionDigest: pending.actionDigest },
  );
  expect(replay.status).toBe(409);
  expect(counts().writes).toBe(before.writes);
  await send(region, "JIRA_E2E_READ: read the connected Jira projects.");
  await expect.poll(() => counts().projects).toBe(before.projects + 1);
  expect(counts().writes).toBe(before.writes);
});

test("a forged decision and a disconnected Chat cannot dispatch the pending write", async ({
  page,
}) => {
  const region = await openJiraChat(page, "revocation");
  await createAndConnect(page, region, "Jira revoked fixture");
  await selectAskForApproval(page, region);
  const before = counts();
  await send(region, "JIRA_E2E_COMMENT: add the synthetic approval fixture comment.");
  await expect(
    region.getByRole("button", { name: "Approve this action", exact: true }),
  ).toBeEnabled();
  const chatId = fixture().chats.revocation.id;
  const stored = await messages(page, chatId);
  const approval = stored
    .flatMap((message) => message.toolTranscript?.exchanges ?? [])
    .find((exchange) => exchange.approval)?.approval;
  if (approval === undefined) throw new Error("Missing persisted exact-action approval");
  const path = `/api/atlassian-connectors/chat-write-approval/${approval.approvalId}`;
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
  await expect(
    region.getByText("Choose an available Chat model that supports the required capabilities.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(counts()).toEqual(before);
  await expect(region.getByRole("button", { name: "Allow reading", exact: true })).toHaveCount(0);
});

test.describe("Jira surfaces accessibility and visual evidence", () => {
  // Local, committed axe-core injection only; the product server retains its real CSP.
  test.use({ bypassCSP: true });
  for (const locale of ["en", "de"] as const) {
    test(`${locale} Jira Hub, connectors, exact approval and result across visual modes`, async ({
      page,
    }, info) => {
      // Eight presentation variants per state share one real read/write journey per locale.
      test.setTimeout(240_000);
      await jiraAccessibilityJourney(page, locale, info);
    });
  }
});

for (const locale of ["en", "de"] as const) {
  test(`${locale} restores the exact interrupted draft batch from the persisted Chat store`, async ({
    page,
  }) => {
    const before = counts();
    const region = await openJiraChat(page, `batch-reload-${locale}`, locale);
    const label =
      locale === "en" ? "You stopped it after 2 of 4 issues" : "Abgebrochen nach 2 von 4 Vorgängen";
    const bar = region.getByRole("progressbar", { name: label, exact: true });
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("aria-valuenow", "2");
    await expect(bar).toHaveAttribute("aria-valuemax", "4");
    const card = region.locator('[data-stopped="true"]');
    await expect(card).toHaveCount(1);
    const text = await card.innerText();
    const stored = await messages(page, fixture().chats[`batch-reload-${locale}`].id);
    expect(stored[0]?.turnState).toBe("cancelled");
    expect(stored[0]?.toolTranscript?.exchanges[0]?.batchProgress).toEqual({
      phase: "drafting",
      draftedCount: 2,
      plannedCount: 4,
      coveredRequirementCount: 3,
      requirementCount: 8,
      failedCount: 0,
    });
    await page.reload();
    await expect.poll(() => card.innerText()).toBe(text);
    await expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(await messages(page, fixture().chats[`batch-reload-${locale}`].id)).toEqual(stored);
    expect(counts()).toEqual(before);
  });
}

async function selectBacklogSource(
  page: Page,
  region: Locator,
  chatId = fixture().chats.backlog.id,
): Promise<void> {
  const source = region.getByRole("combobox", { name: "Grounding mode", exact: true });
  await source.click();
  await page
    .getByRole("option", { name: /^Knowledge Pod: Migration browser requirements(?:,|$)/u })
    .click();
  await expect
    .poll(async () => {
      const selected = (await currentChat(page, chatId)).localKnowledgeScopes?.[0];
      return selected?.kind === "capsule" ? selected.capsuleId : undefined;
    })
    .toBe(fixture().backlogPod.id);
}

async function reviewBacklogPreview(region: Locator): Promise<Locator> {
  await expect(
    region.getByRole("group", { name: "Issues to create (2 of 2 selected)", exact: true }),
  ).toBeVisible();
  const preview = region.getByRole("group", {
    name: "Issues to create (2 of 2 selected)",
    exact: true,
  });
  const expand = preview.getByRole("button", { name: "Show more", exact: true });
  while ((await expand.count()) > 0) await expand.first().click();
  for (const criterion of fixture().backlogPod.criteria)
    await expect(preview).toContainText(criterion);
  const pipeline = region.getByRole("region", { name: "Progress", exact: true });
  const earlier = pipeline.getByRole("button", { name: /Show \d+ earlier calls/u });
  if (await earlier.count()) await earlier.click();
  for (const step of ["Read source", "Read requirements", "Review meaning"]) {
    await expect(
      pipeline.getByRole("listitem", { name: new RegExp(`${step}.*Done`, "u") }),
    ).toBeVisible();
  }
  await expect(pipeline.locator('li[data-state="approval"]')).toHaveCount(1);
  await expect(pipeline.locator('li[data-state="active"]')).toHaveCount(0);
  await expect(pipeline.locator('li[data-state="upcoming"]')).toHaveCount(1);
  return pipeline;
}

function expectCreatedBacklog(): void {
  const stateDirectory = process.env.KEIKO_E2E_JIRA_STATE;
  if (stateDirectory === undefined)
    throw new TypeError("Missing private Jira fixture state directory");
  const created = JSON.parse(readFileSync(join(stateDirectory, "backlog-issues.json"), "utf8")) as {
    readonly key: string;
    readonly fields: {
      readonly description: string;
      readonly issuetype: { readonly id: string };
      readonly customfield_17702?: string;
    };
  }[];
  expect(created).toHaveLength(2);
  expect(created.map((issue) => issue.fields.issuetype.id)).toEqual(["10002", "10003"]);
  for (const [index, issue] of created.entries()) {
    for (const criterion of fixture().backlogPod.criteria.slice(index * 2, index * 2 + 2))
      expect(issue.fields.description).toContain(criterion);
    expect(issue.fields.description).toContain("Keiko traceability");
  }
  expect(created[1]?.fields.customfield_17702).toBe(created[0]?.key);
}

function stagedBacklogReference(
  message: ChatMessage | undefined,
): NonNullable<ReturnType<typeof parseJiraDraftReference>> {
  const call = message?.toolTranscript?.exchanges.find(
    (exchange) => exchange.call.name === "jira_draft",
  )?.call;
  const reference = call === undefined ? undefined : parseJiraDraftReference(call.arguments);
  if (reference === undefined) throw new TypeError("Missing actual staged draft reference");
  return reference;
}

test("Knowledge sources become reviewed Epic and Task drafts through UI approval and reconcile without duplicate writes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const region = await openJiraChat(page, "backlog");
  await createAndConnect(page, region, "Jira backlog fixture");
  await selectAskForApproval(page, region);
  await selectBacklogSource(page, region);
  const before = counts();
  await send(
    region,
    "JIRA_E2E_BACKLOG: Create a reviewed Epic and Task draft from the selected Knowledge Pod, preserving every original acceptance criterion. Show the draft for approval before writing.",
  );
  const approve = region.getByRole("button", { name: "Approve this action", exact: true });
  await expect(approve).toBeEnabled();
  expect(counts().writes).toBe(before.writes);
  const pipeline = await reviewBacklogPreview(region);
  const pending = (await messages(page, fixture().chats.backlog.id)).find(
    (message) => message.role === "user",
  );
  expect(pending?.toolTranscript?.exchanges.map((exchange) => exchange.call.name)).toEqual([
    "knowledge_documents",
    "knowledge_documents",
    "knowledge_requirements",
    "knowledge_review",
    "jira_create_fields",
    "jira_create_fields",
    "jira_draft_stage",
    "jira_draft",
  ]);
  expect(
    pending?.toolTranscript?.exchanges.filter((exchange) => exchange.approval?.state === "pending"),
  ).toHaveLength(1);
  await expectBacklogReload(page, region, pending);
  await expect(approve).toBeEnabled();
  expect(counts().writes).toBe(before.writes);
  await approve.click();
  await expect(
    region.getByText("JIRA_E2E_BACKLOG_DONE: the reviewed backlog is verified.", { exact: true }),
  ).toBeVisible();
  expect(counts().writes).toBe(before.writes + 2);
  expectCreatedBacklog();
  await expect(
    pipeline.locator(
      'li[data-state="active"], li[data-state="approval"], li[data-state="upcoming"]',
    ),
  ).toHaveCount(0);
  const writes = counts().writes;
  await send(
    region,
    `JIRA_E2E_REPLAY: Reconcile this exact reviewed staged draft again. ${JSON.stringify(stagedBacklogReference(pending))}`,
  );
  await expect(approve).toBeEnabled();
  expect(counts().writes).toBe(writes);
  await approve.click();
  await expect(
    region.getByText("JIRA_E2E_BACKLOG_DONE: the reviewed backlog is verified.", { exact: true }),
  ).toHaveCount(2);
  expect(counts().writes).toBe(writes);
  expect(counts().leaks).toBe(0);
  const completed = await messages(page, fixture().chats.backlog.id);
  const finalUser = completed.filter((message) => message.role === "user").at(-1);
  expect(finalUser?.turnState).toBe("completed");
  const replay = finalUser?.toolTranscript?.exchanges.find(
    (exchange) => exchange.call.name === "jira_draft",
  );
  expect(replay).toMatchObject({
    mutationOutcome: "not-dispatched",
    result: { status: "completed", data: { existingCount: 2, createdCount: 0, failedCount: 0 } },
  });
});

function deadlineStatePath(file: string): string {
  const directory = process.env.KEIKO_E2E_JIRA_STATE;
  if (directory === undefined) throw new TypeError("Missing private Jira fixture state directory");
  return join(directory, file);
}

function createdBacklogKeys(): readonly string[] {
  const issues = JSON.parse(readFileSync(deadlineStatePath("backlog-issues.json"), "utf8")) as {
    readonly key: string;
  }[];
  return issues.map((issue) => issue.key);
}

async function expectDeadlineReceipt(page: Page, region: Locator, key: string): Promise<void> {
  await expect(
    region.getByText("Jira accepted the change; confirmation incomplete", { exact: true }),
  ).toBeVisible();
  const stored = await messages(page, fixture().chats.deadline.id);
  const user = stored.find((message) => message.role === "user");
  const draft = user?.toolTranscript?.exchanges.find(
    (exchange) => exchange.call.name === "jira_draft",
  );
  expect(draft).toMatchObject({
    result: { status: "timeout", data: null },
    mutationOutcome: "succeeded-unconfirmed",
    draftProgress: {
      items: expect.arrayContaining([
        expect.objectContaining({ issueKey: key, state: "uncertain" }),
      ]),
    },
  });
  await expect(region.getByText("Jira change confirmed", { exact: true })).toHaveCount(0);
  await expect(region.locator('[data-role="assistant"] .chat-msg-content')).toContainText(key);
  // The readable outcome names the accepted issue and links to it in Jira.
  const outcome = region.getByRole("list", { name: "Jira issues", exact: true }).last();
  await expect(outcome).toContainText(key);
  const link = outcome.getByRole("link", { name: new RegExp(`^${key}\\b`, "u") });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", new RegExp(`/browse/${key}$`, "u"));
  await expect(link).toHaveAttribute("target", "_blank");
  const receipt = region
    .getByRole("region", { name: "Jira action", exact: true })
    .filter({
      hasText: "Jira accepted the change; confirmation incomplete",
    })
    .last();
  const results = receipt.getByRole("list", { name: "Jira results", exact: true });
  await expect(results).toContainText(key);
  await expect(results.getByText("Uncertain", { exact: true })).toBeVisible();
  await expect(receipt.locator("pre")).toHaveCount(0);
}

async function reconcileDeadlineDraft(page: Page, region: Locator, writes: number): Promise<void> {
  const stored = await messages(page, fixture().chats.deadline.id);
  const pending = stored.find((message) => message.role === "user");
  await send(
    region,
    `JIRA_E2E_REPLAY: Reconcile this exact reviewed staged draft again. ${JSON.stringify(stagedBacklogReference(pending))}`,
  );
  const approve = region.getByRole("button", { name: "Approve this action", exact: true });
  await expect(approve).toBeEnabled();
  expect(counts().writes).toBe(writes);
  await approve.click();
  await expect(
    region.getByText("JIRA_E2E_BACKLOG_DONE: the reviewed backlog is verified.", { exact: true }),
  ).toBeVisible();
  expect(counts().writes).toBe(writes + 1);
  const completed = (await messages(page, fixture().chats.deadline.id))
    .filter((message) => message.role === "user")
    .at(-1);
  const replay = completed?.toolTranscript?.exchanges.find(
    (exchange) => exchange.call.name === "jira_draft",
  );
  expect(replay?.result?.data).toMatchObject({ existingCount: 1, createdCount: 1, failedCount: 0 });
}

test("a deadline preserves the accepted Jira key in UI and reload, then a new approved turn reconciles without duplication", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const region = await openJiraChat(page, "deadline");
  await createAndConnect(page, region, "Jira deadline fixture");
  await selectAskForApproval(page, region);
  await selectBacklogSource(page, region, fixture().chats.deadline.id);
  const before = counts();
  const priorKeys = createdBacklogKeys();
  const key = `KEIKO-${String(priorKeys.length + 1)}`;
  const control = deadlineStatePath("draft-deadline.json");
  writeFileSync(control, JSON.stringify({ holdKey: key }));
  try {
    await send(
      region,
      "JIRA_E2E_BACKLOG JIRA_E2E_DEADLINE: Create a reviewed Epic and Task draft from the selected Knowledge Pod. Show the draft for approval before writing.",
    );
    const approve = region.getByRole("button", { name: "Approve this action", exact: true });
    await expect(approve).toBeEnabled();
    await reviewBacklogPreview(region);
    expect(counts().writes).toBe(before.writes);
    await approve.click();
    await expect.poll(() => counts().writes).toBe(before.writes + 1);
    await expectDeadlineReceipt(page, region, key);
    const batchReceipt = region
      .getByRole("region", { name: "Jira action", exact: true })
      .filter({ hasText: "Jira accepted the change; confirmation incomplete" })
      .last();
    const batchText = await batchReceipt.innerText();
    const expiredCounts = counts();
    await page.reload();
    await expectDeadlineReceipt(page, region, key);
    await expect.poll(() => batchReceipt.innerText()).toBe(batchText);
    expect(counts()).toEqual(expiredCounts);
  } finally {
    rmSync(control, { force: true });
  }
  await reconcileDeadlineDraft(page, region, before.writes + 1);
  expect(createdBacklogKeys()).toEqual([
    ...priorKeys,
    key,
    `KEIKO-${String(priorKeys.length + 2)}`,
  ]);
  expect(counts().leaks).toBe(0);
});

async function expectBacklogReload(
  page: Page,
  region: Locator,
  pending: ChatMessage | undefined,
): Promise<void> {
  if (pending === undefined) throw new TypeError("Missing persisted backlog approval");
  const draftCard = region.getByRole("region", { name: "Review Jira action", exact: true });
  const expandedDraftText = await draftCard.innerText();
  // Expansion is local presentation state. Compare both equivalent views and the entire saved
  // transcript so a view reset cannot conceal missing draft values or a changed approval.
  const collapse = draftCard.getByRole("button", { name: "Show less", exact: true });
  while ((await collapse.count()) > 0) await collapse.first().click();
  const draftText = await draftCard.innerText();
  await page.reload();
  await expect.poll(() => draftCard.innerText()).toBe(draftText);
  const restored = (await messages(page, fixture().chats.backlog.id)).find(
    (message) => message.id === pending.id,
  );
  expect(restored?.canonicalTurnRef).toBe(pending.canonicalTurnRef);
  expect(restored?.toolTranscript).toEqual(pending.toolTranscript);
  const expandAgain = draftCard.getByRole("button", { name: "Show more", exact: true });
  while ((await expandAgain.count()) > 0) await expandAgain.first().click();
  await expect.poll(() => draftCard.innerText()).toBe(expandedDraftText);
}
