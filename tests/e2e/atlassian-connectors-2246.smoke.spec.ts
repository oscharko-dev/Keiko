// Issue #2246 (Epic #2238) — the BROADER cross-connector governance smoke, one continuous flow:
// register connector → verify → scope → sync → grounded ask citing connector content → trigger a
// governed write in Ask-for-approval mode → approve → typed result. Drives the real desktop UI
// against a FIXTURE BFF (page.route stubs, no real network), extending the #2245 focused smoke
// with the grounded-ask-citing-connector-content and write→approve legs. Tagged @smoke so the
// browser quality gate exercises it; the typed API token is entered but never asserted back out.

import { expect, test, type Page, type Route } from "@playwright/test";

// ─── Connector fixtures ────────────────────────────────────────────────────────
const CONNECTOR = {
  schemaVersion: "1",
  authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
  provider: "confluence",
  displayName: "Docs",
  baseUrl: "https://x.atlassian.net",
  authScheme: "basic-api-token",
  createdAt: 1_700_000_000_000,
} as const;

const PROGRESS = {
  enumeratedItems: 2,
  fetchedItems: 2,
  indexedItems: 2,
  skippedItems: 0,
  failedItems: 0,
} as const;

const CHANGE_SUMMARY = {
  schemaVersion: "1",
  outcome: "succeeded",
  counts: {
    addedItems: 2,
    changedItems: 0,
    removedItems: 0,
    unchangedItems: 0,
    failedItems: 0,
    deniedItems: 0,
  },
  fingerprintSetDigest: "digest",
  completedAt: 2,
} as const;

const JOB_COMMON = {
  schemaVersion: "1",
  jobId: "job-1",
  connectorId: "conn-1",
  provider: "confluence",
  queuedAt: 0,
  progress: PROGRESS,
} as const;

const RUNNING = { ...JOB_COMMON, status: "running", startedAt: 1 } as const;
const SUCCEEDED = {
  ...JOB_COMMON,
  status: "succeeded",
  startedAt: 1,
  completedAt: 2,
  changeSummary: CHANGE_SUMMARY,
} as const;

// A pending governed write in Ask-for-approval mode (create-issue is high risk → review-required
// in Ask-for-approval): approving it executes and returns a typed result.
const APPROVAL = {
  schemaVersion: "1",
  approvalId: "ap-1",
  connectorId: "conn-1",
  provider: "jira",
  actionType: "create-issue",
  actionClass: "connector-write",
  requiredScope: "issue-tracker.write",
  risk: "high",
  reviewReason: "deterministic-risk-approval-required",
  targetRef: "PROJ-1",
  correlationId: "corr-1",
  requestedAt: 0,
  expiresAt: 10_000,
} as const;

interface Stub {
  readonly re: RegExp;
  readonly method?: string;
  readonly body: unknown;
}

const CONNECTOR_STUBS: readonly Stub[] = [
  { re: /\/credentials$/u, method: "GET", body: { credentials: [CONNECTOR] } },
  { re: /\/credentials$/u, method: "POST", body: CONNECTOR },
  { re: /\/verify$/u, body: { authRef: CONNECTOR.authRef, status: "ok" } },
  { re: /\/sync-jobs$/u, method: "POST", body: { job: RUNNING } },
  { re: /\/sync-jobs\/[^/]+$/u, method: "GET", body: { job: SUCCEEDED } },
  { re: /\/activity$/u, body: { activity: [] } },
  { re: /\/action-approvals$/u, method: "GET", body: { approvals: [APPROVAL] } },
  {
    re: /\/approve$/u,
    body: { disposition: "review-required", result: { status: "succeeded", targetRef: "PROJ-1" } },
  },
  {
    re: /\/reject$/u,
    body: { approvalId: "ap-1", disposition: "review-required", outcome: "cancelled" },
  },
];

function resolveStub(path: string, method: string): unknown {
  const match = CONNECTOR_STUBS.find(
    (stub) => stub.re.test(path) && (stub.method ?? method) === method,
  );
  return match?.body;
}

async function installConnectorStubs(page: Page): Promise<void> {
  await page.route("**/api/atlassian-connectors/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const body = resolveStub(path, route.request().method());
    if (body === undefined) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

function collectPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return () => {
    expect(errors).toEqual([]);
  };
}

// ─── Grounded-ask leg fixtures (chat surface) ────────────────────────────────────
// A synced Confluence connector pod, cited in a grounded answer. The grounding "mode" is a
// property of the chat (`localKnowledgeScope`), so the send auto-routes to the grounded path and
// the citation renders from the assistant message's `groundedAnswer` after the post-send refetch.
const GROUNDED_CHAT_ID = "chat-2246";
const GROUNDED_PROJECT = "/e2e/connectors";
const GROUNDED_MODEL_ID = "e2e-connector-model";
const GROUNDED_CAPSULE_ID = "cap-confluence-eng";
const CONNECTOR_CITATION_SOURCE = "Confluence: Engineering";
const CONNECTOR_PAGE_TITLE = "Deployment Runbook";

const GROUNDED_MODEL = {
  id: GROUNDED_MODEL_ID,
  kind: "chat",
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  toolCalling: false,
  structuredOutput: false,
  streaming: true,
  supportsImageInput: false,
  supportsDocumentInput: false,
  workflowEligible: false,
  costClass: "low",
  latencyClass: "fast",
  throughputHint: "",
  preferredUseCases: [],
  knownLimitations: [],
} as const;

const GROUNDED_PROJECT_ENTRY = {
  path: GROUNDED_PROJECT,
  name: "Connector grounding",
  favorite: false,
  createdAt: 1,
  lastOpenedAt: 2,
  available: true,
} as const;

const GROUNDED_SCOPE = {
  kind: "capsule",
  capsuleId: GROUNDED_CAPSULE_ID,
  connectedAtMs: 1_700_000_000_000,
} as const;

const GROUNDED_CHAT = {
  id: GROUNDED_CHAT_ID,
  projectPath: GROUNDED_PROJECT,
  title: "Connector grounding",
  selectedModel: GROUNDED_MODEL_ID,
  status: "open",
  connectedScopes: [],
  localKnowledgeScopes: [GROUNDED_SCOPE],
  localKnowledgeScope: GROUNDED_SCOPE,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
} as const;

const GROUNDED_ANSWER = {
  groundingKind: "local-knowledge",
  userMessageId: "gmsg-user",
  assistantMessageId: "gmsg-asst",
  content: "The deployment runbook requires two approvals before release. [1]",
  citations: [
    {
      stableId: "gcit-1",
      marker: "1",
      label: CONNECTOR_PAGE_TITLE,
      score: 0.91,
      lineage: {
        capsuleId: GROUNDED_CAPSULE_ID,
        sourceId: "src-confluence",
        documentId: "doc-runbook",
        chunkId: "chunk-7",
      },
      source: CONNECTOR_CITATION_SOURCE,
    },
  ],
  uncertainty: [],
  omittedCount: 0,
  elapsedMs: 12,
  noEvidence: false,
  contextPack: {
    kind: "local-knowledge",
    scopeKind: "capsule",
    scopeId: "scope-confluence-eng",
    scopeLabel: CONNECTOR_CITATION_SOURCE,
    capsuleCount: 1,
    sourceCount: 1,
    citationCount: 1,
    referenceBudget: 8,
    referencesUsed: 3,
  },
} as const;

const GROUNDED_USER_MSG = {
  id: "gmsg-user",
  chatId: GROUNDED_CHAT_ID,
  role: "user",
  content: "How many approvals does the deployment runbook require?",
  timestamp: 1_700_000_001_000,
} as const;

const GROUNDED_ASSISTANT_MSG = {
  id: "gmsg-asst",
  chatId: GROUNDED_CHAT_ID,
  role: "assistant",
  content: GROUNDED_ANSWER.content,
  timestamp: 1_700_000_002_000,
  groundedAnswer: GROUNDED_ANSWER,
} as const;

async function seedGroundedChatWindow(page: Page): Promise<void> {
  await page.addInitScript(
    ({ chatId, title }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "e2e-grounded-chat",
            type: "chat",
            x: 64,
            y: 40,
            w: 900,
            h: 760,
            z: 10,
            cfg: { chatId, title },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { chatId: GROUNDED_CHAT_ID, title: GROUNDED_CHAT.title },
  );
}

// GET stubs for the chat-surface bootstrap + grounding catalog, keyed by pathname. The messages
// endpoint is stateful (empty before the ask, the user+assistant pair after), so it is resolved
// separately against the `grounded` flag rather than from this static table.
const GROUNDED_GET_STUBS: Readonly<Record<string, unknown>> = {
  "/api/models": { models: [GROUNDED_MODEL] },
  "/api/projects": { projects: [GROUNDED_PROJECT_ENTRY] },
  "/api/config": { config: null, configPresent: false },
  "/api/chats": { chats: [GROUNDED_CHAT] },
  "/api/local-knowledge/capsules": {
    capsules: [
      {
        id: GROUNDED_CAPSULE_ID,
        displayName: CONNECTOR_CITATION_SOURCE,
        lifecycleState: "ready",
        sourceCount: 1,
      },
    ],
  },
  "/api/local-knowledge/capsule-sets": { capsuleSets: [] },
};

function groundedStubBody(path: string, method: string, grounded: boolean): unknown {
  if (method !== "GET") return undefined;
  if (path === "/api/chats/messages") {
    return { messages: grounded ? [GROUNDED_USER_MSG, GROUNDED_ASSISTANT_MSG] : [] };
  }
  return Object.prototype.hasOwnProperty.call(GROUNDED_GET_STUBS, path)
    ? GROUNDED_GET_STUBS[path]
    : undefined;
}

async function installGroundedStubs(page: Page): Promise<void> {
  let grounded = false;
  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/chats/messages/grounded" && method === "POST") {
      grounded = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(GROUNDED_ANSWER),
      });
      return;
    }
    const body = groundedStubBody(path, method, grounded);
    if (body === undefined) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

test.describe("Atlassian connectors cross-cutting @smoke", () => {
  test("register → verify → scope → sync → governed write → approve → typed result", async ({
    page,
  }) => {
    const assertNoPageErrors = collectPageErrors(page);
    await installConnectorStubs(page);
    await page.goto("/atlassian-connectors");

    // Register: the connector is listed; add a second one (token typed, never read back).
    const docsCard = page.getByTestId("acx-connector").filter({ hasText: "Docs" });
    await expect(docsCard).toContainText("https://x.atlassian.net");
    await page.getByRole("button", { name: "Add connector" }).click();
    await page.getByLabel("Label").fill("Ops");
    await page.getByLabel("Base URL").fill("https://ops.atlassian.net");
    await page.getByLabel("Account email").fill("me@example.com");
    await page.getByLabel("API token").fill("smoke-token");
    await page.getByRole("button", { name: "Save connector" }).click();

    // Verify: the inline post-save verify step renders the closed status.
    const addVerify = page.getByTestId("acx-add-verify");
    await addVerify.getByRole("button", { name: "Verify connection" }).click();
    await expect(page.getByTestId("acx-verify-status")).toHaveAttribute("data-status", "ok");
    await addVerify.getByRole("button", { name: "Cancel" }).click();

    // Scope + sync: the run reaches the succeeded terminal state with a change summary (polling).
    await docsCard.getByRole("button", { name: "Manage" }).click();
    await docsCard.getByLabel("Confluence space keys").fill("ENG");
    await docsCard.getByRole("button", { name: "Add key" }).click();
    await docsCard.getByRole("button", { name: "Start sync" }).click();
    await expect(docsCard.getByTestId("acx-sync-badge")).toHaveText("Succeeded");
    await expect(docsCard.getByTestId("acx-sync-changes")).toBeVisible();

    // Governed write in Ask-for-approval mode → approve → typed result (create-issue, high risk).
    const approval = page.getByTestId("acx-approval");
    await expect(approval).toContainText("Create Jira issue");
    await approval.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("acx-approval-result")).toContainText("Result: PROJ-1");

    assertNoPageErrors();
  });

  // A viewport tall enough for the seeded 760px chat window's composer + Send button to sit inside
  // the fold (the proven chat-send smoke uses the same size).
  test.describe("grounded ask", () => {
    test.use({ viewport: { width: 1280, height: 960 } });

    test("grounded ask cites synced connector content", async ({ page }) => {
      await seedGroundedChatWindow(page);
      await installGroundedStubs(page);
      await page.goto("/");

      // The seeded chat carries a connector pod scope, so the send auto-routes to the grounded path.
      const chat = page.getByRole("region", { name: `Chat — ${GROUNDED_CHAT.title}` });
      await expect(chat).toBeVisible();
      const composer = chat.getByRole("textbox", { name: "Chat message" });
      await expect(composer).toBeVisible();
      await composer.fill("How many approvals are needed?");
      await chat.getByRole("button", { name: "Send message" }).click();

      // The connector citation renders under the collapsed "Knowledge evidence" disclosure; open it.
      await chat.getByText("Knowledge evidence").click();
      await expect(
        chat.locator('ul.grounded-citations[aria-label="Knowledge citations"] .grounded-citation'),
      ).toContainText(CONNECTOR_CITATION_SOURCE);
    });
  });
});
