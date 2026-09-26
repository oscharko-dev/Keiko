import { expect, test, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { formatViolations, runAxe, seriousOrCritical, type AxeViolation } from "./support/axe.js";
import { evidenceArtifactPath, evidenceScreenshotPath } from "./support/evidence.js";

const WORKSPACE_KEY = "keiko.workspace.v4";
const RUN_ID = "qi-run-degraded-3186";
const THEMES = ["dark", "light"] as const;
const captures: {
  theme: string;
  screenshot: string;
  seriousOrCriticalAxeViolations: number;
}[] = [];

const candidate = {
  id: "tc-3186",
  title: "Baseline checkout test",
  preconditions: ["A cart exists"],
  steps: ["Open checkout"],
  expectedResults: ["Checkout is displayed"],
  priority: "P1",
  riskClass: "regression",
  tags: ["checkout"],
  status: "proposed",
  reviewState: "open",
  derivedFromAtomIds: ["atom-3186"],
};

function runSummary(id: string, degraded: boolean): Record<string, unknown> {
  return {
    id,
    status: "succeeded",
    requestedAt: "2026-08-16T08:00:00.000Z",
    completedAt: "2026-08-16T08:01:00.000Z",
    totals: { candidates: 1, findings: 0, exports: 0 },
    reviewState: "open",
    ...(degraded ? { degraded: true, reasonSummary: "qi-judge-unavailable" } : {}),
  };
}

function runDetail(id: string): Record<string, unknown> {
  return {
    ...runSummary(id, true),
    findingRefs: [],
    candidateIds: [candidate.id],
    candidates: [candidate],
    evidenceRefs: [],
    manifestSchemaVersion: 1,
    coveragePercentage: 100,
    coverageByAtom: [{ atomId: "atom-3186", status: "covered", confidence: 1 }],
    qualityScore: null,
    drift: {
      status: "unavailable",
      sourceFingerprintCount: 0,
      atomFingerprintCount: 0,
      reCheckSupported: false,
      regenerateStaleSupported: false,
    },
  };
}

const chatModel = {
  id: "e2e-inexpensive-chat",
  kind: "chat",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  toolCalling: true,
  structuredOutput: true,
  streaming: true,
  supportsImageInput: false,
  supportsDocumentInput: false,
  supportsResponseFormat: true,
  workflowEligible: true,
  costClass: "low",
  latencyClass: "standard",
  throughputHint: "issue-3186",
  preferredUseCases: ["Quality Intelligence"],
  knownLimitations: [],
};

const modelRouting = {
  policyVersion: 1,
  requested: {
    policyVersion: 1,
    testDesignModelId: chatModel.id,
    judgeModelId: chatModel.id,
  },
  resolved: { testDesignModelId: chatModel.id, judgeModelId: chatModel.id },
  preflight: {
    status: "passed",
    generation: { stage: "generate", status: "passed", modelId: chatModel.id },
    judge: { stage: "judge", status: "passed", modelId: chatModel.id },
  },
};

async function fulfillGetApi(route: Route, path: string): Promise<boolean> {
  if (path === "/api/quality-intelligence/runs") {
    await route.fulfill({
      json: {
        runs: [runSummary(RUN_ID, true), runSummary("qi-run-clean-3186", false)],
        limit: 100,
        totalRunIds: 2,
        truncated: false,
      },
    });
    return true;
  }
  if (path.startsWith("/api/quality-intelligence/runs/")) {
    await route.fulfill({ json: runDetail(path.split("/").at(-1) ?? RUN_ID) });
    return true;
  }
  if (path === "/api/quality-intelligence/model-policy") {
    await route.fulfill({
      json: {
        policy: modelRouting.requested,
        recommendedPolicy: modelRouting.requested,
        resolved: modelRouting.resolved,
        models: [chatModel],
        validation: { ok: true, issues: [] },
        repaired: false,
      },
    });
    return true;
  }
  return false;
}

async function fulfillPostApi(route: Route, path: string): Promise<boolean> {
  if (path === "/api/quality-intelligence/model-policy/preflight") {
    await route.fulfill({ json: { modelRouting } });
    return true;
  }
  if (path === "/api/quality-intelligence/runs") {
    const frames = [
      {
        type: "accepted",
        runId: RUN_ID,
        requestedAt: "2026-08-16T08:02:00.000Z",
        sourceCount: 1,
        atomCount: 1,
      },
      {
        type: "done",
        runId: RUN_ID,
        status: "succeeded",
        totals: { candidates: 1, findings: 0, exports: 0 },
        degraded: true,
        reasonSummary: "qi-judge-unavailable",
      },
    ];
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join("")}\n`,
    });
    return true;
  }
  return false;
}

async function fulfillApi(route: Route): Promise<void> {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (request.method() === "GET" && (await fulfillGetApi(route, path))) return;
  if (request.method() === "POST" && (await fulfillPostApi(route, path))) return;
  await route.continue();
}

async function seedWorkspace(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript(
    ({ key, selectedTheme, runId }) => {
      window.localStorage.setItem("keiko.locale", "en");
      window.localStorage.setItem("keiko.theme", selectedTheme);
      window.localStorage.setItem(
        key,
        JSON.stringify([
          {
            id: "qi-hub-3186",
            type: "quality",
            x: 20,
            y: 48,
            w: 440,
            h: 1060,
            z: 10,
            cfg: {},
            max: false,
          },
          {
            id: "qi-detail-3186",
            type: "qiRun",
            x: 480,
            y: 48,
            w: 900,
            h: 1060,
            z: 11,
            cfg: { runId },
            max: false,
          },
        ]),
      );
    },
    { key: WORKSPACE_KEY, selectedTheme: theme, runId: RUN_ID },
  );
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function affectedSurfaceViolations(
  page: Page,
): Promise<ReturnType<typeof seriousOrCritical>> {
  const selectors = [
    '[data-window-id="qi-hub-3186"] .qi-run-list',
    '[data-window-id="qi-detail-3186"] [data-testid="qi-run-card"]',
    '[data-window-id="qi-hub-3186"] [data-testid="qi-launch-degraded"]',
  ];
  const violations: AxeViolation[] = [];
  for (const selector of selectors) violations.push(...(await runAxe(page, selector)));
  return seriousOrCritical(violations);
}

function sourceHashes(): Record<string, string> {
  return {
    bffWire: sha256("packages/keiko-contracts/src/qualityIntelligence/bffWire.ts"),
    uiRoutes: sha256("packages/keiko-server/src/qualityIntelligence/uiRoutes.ts"),
    runRoutes: sha256("packages/keiko-server/src/qualityIntelligence/runRoutes.ts"),
    hub: sha256(
      "packages/keiko-ui/src/app/components/desktop/widgets/quality-intelligence/QiHubPanel.tsx",
    ),
    detail: sha256(
      "packages/keiko-ui/src/app/components/desktop/widgets/quality-intelligence/QiRunCard.tsx",
    ),
    launcher: sha256(
      "packages/keiko-ui/src/app/components/desktop/widgets/quality-intelligence/RunLauncher.tsx",
    ),
  };
}

function writeEvidenceArtifacts(hashes: Record<string, string>): void {
  writeFileSync(
    evidenceArtifactPath("docs/design-system/evidence/3186/qi-terminal-fidelity-proof.json"),
    `${JSON.stringify({ issue: 3186, verdict: "PASS", captures, sourceHashes: hashes }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    evidenceArtifactPath("docs/design-system/evidence/3186/a11y-proof.json"),
    `${JSON.stringify(
      {
        issue: 3186,
        verdict: "PASS",
        tool: "axe-core",
        gate: "zero serious or critical violations on degraded QI list, detail, and live launcher",
        captures,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    evidenceArtifactPath("docs/design-system/evidence/3186/manifest.json"),
    `${JSON.stringify(
      {
        issue: 3186,
        verdict: "PASS",
        command:
          "npx playwright test tests/e2e/quality-intelligence-3186.spec.ts --config tests/e2e/config/playwright.config.ts --project=chromium",
        assertions: [
          "historical degraded run is labelled Degraded in list and detail",
          "clean inexpensive chat-only run remains labelled Succeeded",
          "live succeeded done frame with persisted judge failure is communicated as degraded",
          "zero serious or critical axe-core violations in dark and light themes",
        ],
        artifacts: captures,
        sourceHashes: hashes,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test.afterAll(() => {
  if (captures.length !== THEMES.length) return;
  writeEvidenceArtifacts(sourceHashes());
});

for (const theme of THEMES) {
  test(`degraded terminal truth is consistent across QI list, detail, and launcher — ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.route("**/api/quality-intelligence/**", fulfillApi);
    await seedWorkspace(page, theme);
    await page.goto("/");

    const hub = page.locator('[data-window-id="qi-hub-3186"]');
    const detail = page.locator('[data-window-id="qi-detail-3186"]');
    await expect(hub).toBeVisible();
    await expect(detail).toBeVisible();
    await expect(hub.getByText("Degraded", { exact: true })).toBeVisible();
    await expect(hub.getByText("Succeeded", { exact: true })).toBeVisible();
    await expect(detail.getByText("Degraded", { exact: true })).toBeVisible();
    await expect(detail.getByTestId("qi-run-degraded")).toContainText("qi-judge-unavailable");

    await hub.getByRole("textbox", { name: "Requirements" }).fill("Verify checkout");
    await hub.getByRole("button", { name: "Generate test cases" }).click();
    await expect(hub.getByTestId("qi-launch-degraded")).toContainText("Modellphase");
    await expect(hub.getByTestId("qi-launch-error")).toHaveCount(0);

    const violations = await affectedSurfaceViolations(page);
    expect(violations.length, formatViolations(violations)).toBe(0);
    const screenshot = `${theme}-qi-terminal.png`;
    await page.screenshot({
      path: evidenceScreenshotPath(`docs/design-system/evidence/3186/${screenshot}`),
      fullPage: true,
    });
    captures.push({
      theme,
      screenshot,
      seriousOrCriticalAxeViolations: violations.length,
    });
  });
}
