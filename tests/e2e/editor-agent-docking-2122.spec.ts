import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Response as PlaywrightResponse,
} from "@playwright/test";

import {
  EDITOR_SELECTORS,
  cleanupEditorWorkspaces,
  collectPageErrors,
  createEditorWorkspace,
  openEditorWorkspace,
  seedEditorWindow,
  splitActivePane,
} from "./support/editorWorkspace.js";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const ACTIVE_FILE = "src/active.ts";
const CLOSED_FILE = "src/closed.ts";
const ACTIVE_BEFORE = "export const active = 1;\n";
const ACTIVE_AFTER = "export const active = 2;\n";
const CLOSED_BEFORE = "export const closed = 1;\n";
const CLOSED_AFTER = "export const closed = 2;\n";
const PATCH = [
  `--- a/${ACTIVE_FILE}`,
  `+++ b/${ACTIVE_FILE}`,
  "@@ -1 +1 @@",
  "-export const active = 1;",
  "+export const active = 2;",
  `--- a/${CLOSED_FILE}`,
  `+++ b/${CLOSED_FILE}`,
  "@@ -1 +1 @@",
  "-export const closed = 1;",
  "+export const closed = 2;",
].join("\n");

interface AuthorityReference {
  readonly runId: string;
  readonly envelopeDigest: string;
}

interface SessionSummary {
  readonly sessionId?: unknown;
  readonly workspaceRoot?: unknown;
  readonly activeFile?: unknown;
}

type RequestedMode = "governed-assist" | "supervised-coding";

interface ReviewProbeWindow extends Window {
  __keikoChangesetReviewSeen?: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deniedCommandPolicy(): Record<string, unknown> {
  return {
    mode: "deny",
    allow: [],
    deny: [],
    maxCommandTimeoutMs: 1,
    requirePerCommandApproval: true,
  };
}

function authorityEnvelope(
  root: string,
  requestedMode: RequestedMode,
  runId: string,
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    runId,
    localUser: "local-operator",
    taskRefs: ["issue-2122"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "workspace",
      rootDigest: sha256(root),
    },
    branch: {
      baseRef: "dev",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode,
    deploymentCeiling: "governed-assist",
    effectiveMode: "governed-assist",
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read", "workspace-write"],
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-1",
      source: "keiko-model-gateway",
      supportsStreaming: false,
      supportsToolCalling: true,
    },
    commandPolicy: deniedCommandPolicy(),
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: 300_000,
      maxToolCalls: 4,
      maxPromptTokens: 1,
      maxPatchBytes: 65_536,
    },
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    approvalProofDigest: "a".repeat(64),
  };
}

async function editorSessionId(request: APIRequestContext, root: string): Promise<string | null> {
  const response = await request.get("/api/editor/agent/sessions");
  if (!response.ok()) return null;
  const body = (await response.json()) as { sessions?: readonly SessionSummary[] };
  const session = body.sessions?.find(
    (candidate) => candidate.workspaceRoot === root && candidate.activeFile === ACTIVE_FILE,
  );
  return typeof session?.sessionId === "string" ? session.sessionId : null;
}

async function waitForEditorSession(request: APIRequestContext, root: string): Promise<string> {
  await expect.poll(async () => editorSessionId(request, root)).not.toBeNull();
  const sessionId = await editorSessionId(request, root);
  if (sessionId === null) throw new Error("Editor session did not register.");
  return sessionId;
}

async function liveEditorSessionIds(
  request: APIRequestContext,
  root: string,
): Promise<readonly string[]> {
  const response = await request.get("/api/editor/agent/sessions");
  if (!response.ok()) return [];
  const body = (await response.json()) as { sessions?: readonly SessionSummary[] };
  return (body.sessions ?? [])
    .filter((candidate) => candidate.workspaceRoot === root)
    .flatMap((candidate) => (typeof candidate.sessionId === "string" ? [candidate.sessionId] : []));
}

async function registerAuthority(
  request: APIRequestContext,
  envelope: Record<string, unknown>,
): Promise<AuthorityReference> {
  const confirmationResponse = await request.post(
    "/api/coding-workbench/autonomous-delivery/confirm",
    { headers: MUTATION_HEADERS, data: { schemaVersion: "1", authorityEnvelope: envelope } },
  );
  expect(confirmationResponse.status(), await confirmationResponse.text()).toBe(200);
  const confirmationBody = (await confirmationResponse.json()) as { confirmation?: unknown };
  const authorityResponse = await request.post("/api/editor/agent/authority", {
    headers: MUTATION_HEADERS,
    data: {
      schemaVersion: "1",
      authorityEnvelope: envelope,
      confirmation: confirmationBody.confirmation,
    },
  });
  expect(authorityResponse.status(), await authorityResponse.text()).toBe(200);
  const body = (await authorityResponse.json()) as { authorityRef?: AuthorityReference };
  if (body.authorityRef === undefined) throw new Error("Authority registration returned no ref.");
  return body.authorityRef;
}

async function proposeChangeset(
  request: APIRequestContext,
  sessionId: string,
  authorityRef: AuthorityReference,
  actionId: string,
): Promise<void> {
  const response = await request.post("/api/editor/agent/actions", {
    headers: MUTATION_HEADERS,
    data: {
      schemaVersion: "1",
      actionId,
      idempotencyKey: actionId,
      sessionId,
      type: "applyChangeset",
      origin: "agent",
      authorityRef,
      changeset: {
        patch: PATCH,
        files: [
          { file: ACTIVE_FILE, expectedContentHash: sha256(ACTIVE_BEFORE) },
          { file: CLOSED_FILE, expectedContentHash: sha256(CLOSED_BEFORE) },
        ],
      },
    },
  });
  expect(response.status(), await response.text()).toBe(202);
  expect(await response.json()).toMatchObject({ result: { actionId, status: "queued" } });
}

async function assertReview(review: Locator, root: string): Promise<void> {
  await expect(review).toBeVisible();
  const fileRows = review.getByTestId("keiko-diff-file");
  await expect(fileRows).toHaveCount(2);
  await expect(review.getByTestId("keiko-diff-file-list")).toContainText(ACTIVE_FILE);
  await expect(review.getByTestId("keiko-diff-file-list")).toContainText(CLOSED_FILE);
  await assertReviewedFile(
    review,
    fileRows.filter({ hasText: ACTIVE_FILE }),
    ACTIVE_BEFORE,
    ACTIVE_AFTER,
  );
  await assertReviewedFile(
    review,
    fileRows.filter({ hasText: CLOSED_FILE }),
    CLOSED_BEFORE,
    CLOSED_AFTER,
  );
  expect(readFileSync(join(root, ACTIVE_FILE), "utf8")).toBe(ACTIVE_BEFORE);
  expect(readFileSync(join(root, CLOSED_FILE), "utf8")).toBe(CLOSED_BEFORE);
}

async function assertReviewedFile(
  review: Locator,
  row: Locator,
  original: string,
  modified: string,
): Promise<void> {
  await row.click();
  const diff = review.getByTestId("keiko-diff-editor");
  await expect(
    diff.locator(".original-in-monaco-diff-editor .view-line").filter({ hasText: original.trim() }),
  ).toBeVisible();
  await expect(
    diff.locator(".modified-in-monaco-diff-editor .view-line").filter({ hasText: modified.trim() }),
  ).toBeVisible();
}

function isTerminalChangesetResponse(response: PlaywrightResponse, actionId: string): boolean {
  const request = response.request();
  if (request.method() !== "POST") return false;
  if (new URL(request.url()).pathname !== "/api/editor/agent/actions") return false;
  try {
    const body = JSON.parse(request.postData() ?? "") as Record<string, unknown>;
    const result = body.result;
    return (
      body.kind === "result" &&
      isRecord(result) &&
      result.actionId === actionId &&
      result.status === "succeeded"
    );
  } catch {
    return false;
  }
}

function waitForTerminalChangesetResponse(
  page: Page,
  actionId: string,
): Promise<PlaywrightResponse> {
  return page.waitForResponse((response) => isTerminalChangesetResponse(response, actionId), {
    timeout: 15_000,
  });
}

async function installChangesetReviewProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probeWindow = window as ReviewProbeWindow;
    const selector = '[aria-label="Agent changeset review"]';
    probeWindow.__keikoChangesetReviewSeen = document.querySelector(selector) !== null;
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector) !== null) probeWindow.__keikoChangesetReviewSeen = true;
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

async function changesetReviewWasSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as ReviewProbeWindow).__keikoChangesetReviewSeen === true);
}

async function expectAuditEvidence(
  request: APIRequestContext,
  sessionId: string,
  actionId: string,
  disposition: "allowed" | "review-required",
): Promise<void> {
  const response = await request.get(
    `/api/editor/agent/audit?sessionId=${encodeURIComponent(sessionId)}`,
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { records?: readonly Record<string, unknown>[] };
  const records = body.records?.filter((record) => record.actionId === actionId) ?? [];
  expect(records).toHaveLength(2);
  expect(records.map((record) => record.disposition)).toEqual([disposition, disposition]);
  expect(records.map((record) => record.outcome)).toEqual(["queued", "succeeded"]);
  expect(JSON.stringify(records)).not.toContain(ACTIVE_AFTER);
  expect(JSON.stringify(records)).not.toContain(CLOSED_AFTER);
}

async function openSplitPaneWorkspace(
  page: Page,
  request: APIRequestContext,
  root: string,
  eventSessionSets: string[][],
): Promise<{
  readonly workspace: Locator;
  readonly closedPane: Locator;
  readonly activePane: Locator;
  readonly sessionId: string;
}> {
  await page.goto("/");
  const workspace = await openEditorWorkspace(page);
  await splitActivePane(workspace, ACTIVE_FILE, "right");
  const panes = workspace.locator(EDITOR_SELECTORS.pane);
  await expect(panes).toHaveCount(2);
  const closedPane = panes.nth(0);
  const activePane = panes.nth(1);
  await closedPane.locator(`${EDITOR_SELECTORS.tabHit}[data-tip="${CLOSED_FILE}"]`).click();
  await expect(
    closedPane.locator(`${EDITOR_SELECTORS.monaco} .view-line`).filter({ hasText: "closed = 1" }),
  ).toBeVisible();
  await expect.poll(async () => liveEditorSessionIds(request, root)).toHaveLength(1);
  const closedSession = (await liveEditorSessionIds(request, root))[0];
  await expect.poll(() => eventSessionSets.at(-1)).toHaveLength(1);
  await activePane.locator(`${EDITOR_SELECTORS.tabHit}[data-tip="${ACTIVE_FILE}"]`).click();
  await expect(
    activePane.locator(`${EDITOR_SELECTORS.monaco} .view-line`).filter({ hasText: "active = 1" }),
  ).toBeVisible();
  await expect.poll(() => eventSessionSets.at(-1)).toHaveLength(1);
  await expect.poll(async () => liveEditorSessionIds(request, root)).toHaveLength(1);
  const sessionId = await waitForEditorSession(request, root);
  expect(sessionId).not.toBe(closedSession);
  return { workspace, closedPane, activePane, sessionId };
}

function collectEventSessionSets(page: Page): string[][] {
  const sessionSets: string[][] = [];
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (url.pathname === "/api/editor/agent/events") {
      sessionSets.push(url.searchParams.getAll("sessionId"));
    }
  });
  return sessionSets;
}

test.afterAll(() => {
  cleanupEditorWorkspaces();
});

test("supervised multi-file changeset reviews then commits atomically through the real BFF", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { root } = createEditorWorkspace([
    { path: ACTIVE_FILE, content: ACTIVE_BEFORE },
    { path: CLOSED_FILE, content: CLOSED_BEFORE },
  ]);
  await seedEditorWindow(page, {
    root,
    active: ACTIVE_FILE,
    openFiles: [ACTIVE_FILE],
    windowId: "editor-agent-docking-2122",
    resetWorkspace: true,
  });
  const pageErrors = collectPageErrors(page);
  await page.goto("/");
  const workspace = await openEditorWorkspace(page);
  await expect(workspace.locator(EDITOR_SELECTORS.monaco).first()).toBeVisible();
  const sessionId = await waitForEditorSession(request, root);
  const envelope = authorityEnvelope(root, "supervised-coding", "run-2122-review");
  const authorityRef = await registerAuthority(request, envelope);
  const actionId = `e2e-changeset-review-2122-${String(Date.now())}`;
  await proposeChangeset(request, sessionId, authorityRef, actionId);
  const review = workspace.getByRole("group", { name: "Agent changeset review" });
  await assertReview(review, root);
  await expect(workspace.getByTestId("agent-presence-indicator")).toHaveAttribute(
    "data-presence-state",
    "review",
  );
  await expect(workspace.locator(`${EDITOR_SELECTORS.tab}[data-dirty="true"]`)).toHaveCount(0);

  const terminalResponse = waitForTerminalChangesetResponse(page, actionId);
  await review.getByTestId("keiko-diff-apply").click();
  expect((await terminalResponse).ok()).toBe(true);
  await expect(review).toBeHidden();
  await expect
    .poll(() => [
      readFileSync(join(root, ACTIVE_FILE), "utf8"),
      readFileSync(join(root, CLOSED_FILE), "utf8"),
    ])
    .toEqual([ACTIVE_AFTER, CLOSED_AFTER]);
  await expect(workspace.locator(EDITOR_SELECTORS.saveField)).toHaveText("Saved");
  await expect(
    workspace.locator(`${EDITOR_SELECTORS.monaco} .view-line`).filter({ hasText: "active = 2" }),
  ).toBeVisible();
  await expect(workspace.locator(`${EDITOR_SELECTORS.tab}[data-dirty="true"]`)).toHaveCount(0);
  await expectAuditEvidence(request, sessionId, actionId, "review-required");
  expect(pageErrors).toEqual([]);
});

test("governed-assist commits an allowed changeset without staging review", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { root } = createEditorWorkspace([
    { path: ACTIVE_FILE, content: ACTIVE_BEFORE },
    { path: CLOSED_FILE, content: CLOSED_BEFORE },
  ]);
  await seedEditorWindow(page, {
    root,
    active: ACTIVE_FILE,
    openFiles: [ACTIVE_FILE],
    windowId: "editor-agent-docking-2122-allowed",
    resetWorkspace: true,
  });
  const pageErrors = collectPageErrors(page);
  await page.goto("/");
  const workspace = await openEditorWorkspace(page);
  await expect(workspace.locator(EDITOR_SELECTORS.monaco).first()).toBeVisible();
  await installChangesetReviewProbe(page);
  const sessionId = await waitForEditorSession(request, root);
  const envelope = authorityEnvelope(root, "governed-assist", "run-2122-governed");
  const authorityRef = await registerAuthority(request, envelope);
  const actionId = `e2e-changeset-allowed-2122-${String(Date.now())}`;
  const terminalResponse = waitForTerminalChangesetResponse(page, actionId);
  await proposeChangeset(request, sessionId, authorityRef, actionId);
  expect((await terminalResponse).ok()).toBe(true);

  await expect
    .poll(() => [
      readFileSync(join(root, ACTIVE_FILE), "utf8"),
      readFileSync(join(root, CLOSED_FILE), "utf8"),
    ])
    .toEqual([ACTIVE_AFTER, CLOSED_AFTER]);
  await expect(workspace.getByRole("group", { name: "Agent changeset review" })).toHaveCount(0);
  expect(await changesetReviewWasSeen(page)).toBe(false);
  await expect(workspace.getByTestId("agent-presence-indicator")).not.toHaveAttribute(
    "data-presence-state",
    "review",
  );
  await expect(workspace.locator(`${EDITOR_SELECTORS.tab}[data-dirty="true"]`)).toHaveCount(0);
  await expect(workspace.locator(EDITOR_SELECTORS.saveField)).toHaveText("Saved");
  await expect(
    workspace.locator(`${EDITOR_SELECTORS.monaco} .view-line`).filter({ hasText: "active = 2" }),
  ).toBeVisible();
  await expectAuditEvidence(request, sessionId, actionId, "allowed");
  expect(pageErrors).toEqual([]);
});

test("split panes keep one live session and reconcile a committed changeset in both models", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { root } = createEditorWorkspace([
    { path: ACTIVE_FILE, content: ACTIVE_BEFORE },
    { path: CLOSED_FILE, content: CLOSED_BEFORE },
  ]);
  await seedEditorWindow(page, {
    root,
    active: ACTIVE_FILE,
    openFiles: [ACTIVE_FILE, CLOSED_FILE],
    windowId: "editor-agent-docking-2122-split",
    resetWorkspace: true,
  });
  const eventSessionSets = collectEventSessionSets(page);
  const pageErrors = collectPageErrors(page);
  const { workspace, closedPane, activePane, sessionId } = await openSplitPaneWorkspace(
    page,
    request,
    root,
    eventSessionSets,
  );

  const envelope = authorityEnvelope(root, "supervised-coding", "run-2122-model");
  const authorityRef = await registerAuthority(request, envelope);
  const actionId = `e2e-changeset-split-2122-${String(Date.now())}`;
  await proposeChangeset(request, sessionId, authorityRef, actionId);
  const review = activePane.getByRole("group", { name: "Agent changeset review" });
  await expect(review).toBeVisible();
  const terminalResponse = waitForTerminalChangesetResponse(page, actionId);
  await review.getByTestId("keiko-diff-apply").click();
  expect((await terminalResponse).ok()).toBe(true);

  await expect(
    activePane.locator(`${EDITOR_SELECTORS.monaco} .view-line`).filter({ hasText: "active = 2" }),
  ).toBeVisible();
  await expect(
    closedPane.locator(`${EDITOR_SELECTORS.monaco} .view-line`).filter({ hasText: "closed = 2" }),
  ).toBeVisible();
  await expect(workspace.locator(`${EDITOR_SELECTORS.tab}[data-dirty="true"]`)).toHaveCount(0);
  await expect.poll(async () => liveEditorSessionIds(request, root)).toHaveLength(1);
  expect(readFileSync(join(root, ACTIVE_FILE), "utf8")).toBe(ACTIVE_AFTER);
  expect(readFileSync(join(root, CLOSED_FILE), "utf8")).toBe(CLOSED_AFTER);
  expect(pageErrors).toEqual([]);
});
