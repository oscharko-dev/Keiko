import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { buildCspHeader } from "../../packages/keiko-server/src/csp.js";
import {
  WORKBENCH,
  assertNoHorizontalOverflow,
  captureLiveProof,
  injectRecoveryRequiredOnStop,
  injectWorkspaceDrift,
  liveHarnessStatus,
  openWorkbench,
  prepareAppearance,
  resetLiveScenario,
} from "./support/coding-workbench-2258-live.js";

test.describe.configure({ mode: "serial" });

test("#2258 live document retains the exact production CSP while axe uses browser-only bypass", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response).not.toBeNull();
  const hashes = JSON.parse(
    readFileSync(
      join(resolve(import.meta.dirname, "../.."), "dist", "ui", "csp-hashes.json"),
      "utf8",
    ),
  ) as string[];
  expect(response?.headers()["content-security-policy"]).toBe(buildCspHeader(hashes));
});

test("#2258 real managed OpenCode reads, asks, edits, verifies, and reaches a terminal state", async ({
  page,
}, testInfo) => {
  await prepareAppearance(page, { width: 1280, theme: "dark", reducedMotion: false });
  const questions = await startQuestion(page);
  await page.route("**/questions", (route) => route.abort("connectionrefused"));
  await expect(questions).toHaveAttribute("data-question-state", "offline");
  await page.unroute("**/questions");
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(questions).toHaveAttribute("data-question-state", "ready");
  await expect(page.getByRole("list", { name: "Coding run event timeline" })).toBeVisible();
  await questions.getByRole("radio", { name: "Approve" }).check();
  await questions.getByRole("button", { name: "Send answer" }).click();
  const outcome = page.getByTestId("coding-workbench-terminal-outcome");
  await expect(outcome).toHaveAttribute("data-terminal-state", "succeeded");
  await expect(outcome).toContainText("Succeeded");
  await expect(page.getByRole("list", { name: "Coding run event timeline" })).toContainText(
    "Verification summarized",
  );
  await expect(questions).toHaveCount(0);
  await captureLiveProof(page, testInfo, "managed-opencode-terminal-dark-1280");
});

for (const appearance of [
  { id: "light-768", width: 768, theme: "light" as const, reducedMotion: false },
  { id: "dark-320", width: 320, theme: "dark" as const, reducedMotion: false },
  { id: "reduced-motion-1280", width: 1280, theme: "dark" as const, reducedMotion: true },
  {
    id: "light-high-contrast-1280",
    width: 1280,
    theme: "light" as const,
    reducedMotion: false,
    highContrast: true,
  },
  {
    id: "forced-colors-768",
    width: 768,
    theme: "dark" as const,
    reducedMotion: false,
    forcedColors: "active" as const,
  },
]) {
  test(`#2258 live shell reflows and remains accessible: ${appearance.id}`, async ({
    page,
  }, testInfo) => {
    await prepareAppearance(page, appearance);
    await openWorkbench(page);
    await assertNoHorizontalOverflow(page);
    await assertFocusableControlsRemainWithinWorkbenchFrame(page);
    if (appearance.width <= 820) await assertWorkbenchUsesSingleColumnLayout(page);
    const violations = seriousOrCritical(await runAxe(page, WORKBENCH));
    expect(violations.length, formatViolations(violations)).toBe(0);
    await captureLiveProof(page, testInfo, appearance.id);
  });
}

test("#2258 live controls expose all authority modes and native keyboard focus", async ({
  page,
}) => {
  await openWorkbench(page);
  const radios = page.getByRole("radiogroup", { name: "Coding autonomy mode" }).getByRole("radio");
  await expect(radios).toHaveCount(3);
  await expect(radios.nth(0)).toBeEnabled();
  await expect(radios.nth(1)).toBeEnabled();
  await expect(radios.nth(2)).toBeEnabled();
  await expect(page.getByText("Capped by deployment", { exact: true })).toHaveCount(2);
  await radios.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(radios.nth(1)).toBeFocused();
  await expect(radios.nth(1)).toBeChecked();
  await expect(
    page.getByText(
      "Server effective mode: Ask for approval. Deployment ceiling: Ask for approval.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(page.getByText("Delivery actions remain separately human-approved.")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(radios.nth(2)).toBeFocused();
  await expect(radios.nth(2)).toBeChecked();
  await expect(
    page.getByText(
      "Server effective mode: Ask for approval. Deployment ceiling: Ask for approval.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(page.getByText("Delivery actions remain separately human-approved.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start coding run" })).toBeDisabled();
});

test("#2258 live 768px Workbench keeps running controls and event panel reachable in-frame", async ({
  page,
}) => {
  await prepareAppearance(page, { width: 768, theme: "light", reducedMotion: false });
  await resetLiveScenario(page);
  await openWorkbench(page);
  await page.getByRole("radio", { name: "Keiko Gateway" }).check();
  await page.getByLabel("Task instructions").fill("Synthetic 768px takeover qualification");
  await page.getByRole("button", { name: "Start coding run" }).click();
  await expect(page.getByRole("button", { name: "Take over manually" })).toBeEnabled();
  await expect(page.getByRole("list", { name: "Coding run event timeline" })).toBeVisible();
  await assertFocusableControlsRemainWithinWorkbenchFrame(page);
  await page.getByRole("button", { name: "Take over manually" }).focus();
  await expect(page.getByRole("button", { name: "Take over manually" })).toBeFocused();
  await assertFocusableControlsRemainWithinWorkbenchFrame(page);
  await page.getByRole("button", { name: "Take over manually" }).click();
  await expect(page.locator(WORKBENCH)).toHaveAttribute("data-state", "idle");
  await resetLiveScenario(page);
});

test("#2258 live model-question rejection reaches the runtime's terminal outcome", async ({
  page,
}) => {
  // This is rejection of a model-supplied question, not an authority or delivery decision.
  // Upstream model semantics permit either succeeded or failed after a rejection; both are
  // terminal, while authority and delivery boundaries are qualified separately.
  const questions = await startQuestion(page);
  await questions.getByRole("button", { name: "Reject question" }).click();
  await expect(page.locator(WORKBENCH)).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("coding-workbench-terminal-outcome")).toHaveAttribute(
    "data-terminal-state",
    /^(succeeded|failed)$/,
  );
  await expect(questions).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop run" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Take over manually" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Acknowledge recovery" })).toHaveCount(0);
});

test("#2258 live stop and takeover retain their distinct terminal outcomes", async ({ page }) => {
  await startQuestion(page);
  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(page.locator(WORKBENCH)).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("coding-workbench-terminal-outcome")).toHaveAttribute(
    "data-terminal-state",
    "cancelled",
  );
  await resetLiveScenario(page);
  await openWorkbench(page);
  await page.getByLabel("Task instructions").fill("Synthetic takeover qualification");
  await page.getByRole("button", { name: "Start coding run" }).click();
  await page.getByRole("button", { name: "Take over manually" }).click();
  await expect(page.locator(WORKBENCH)).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("coding-workbench-terminal-outcome")).toHaveAttribute(
    "data-terminal-state",
    "taken-over",
  );
});

test("#2258 live stop exposes recovery acknowledgement and fresh retry", async ({ page }) => {
  await startQuestion(page);
  await injectRecoveryRequiredOnStop(page);
  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(page.getByRole("button", { name: "Acknowledge recovery" })).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge recovery" }).click();
  await expect(page.getByRole("button", { name: "Retry as a fresh run" })).toBeVisible();
  await page.getByLabel("Task instructions").fill("Synthetic recovery retry qualification");
  await page.getByRole("button", { name: "Retry as a fresh run" }).click();
  await expect(page.locator(WORKBENCH)).toHaveAttribute("data-state", "running");
  await expect(page.getByTestId("coding-workbench-terminal-outcome")).toHaveAttribute(
    "data-terminal-state",
    /^(succeeded|failed)$/,
  );
  await expect(page.locator(WORKBENCH)).toHaveAttribute("data-state", "idle");
  await expect(page.getByRole("button", { name: "Stop run" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Acknowledge recovery" })).toHaveCount(0);
  await expect(page.getByTestId("coding-workbench-questions")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject question" })).toHaveCount(0);
});

test("#2258 live browser offline and reconnect preserves the pending question", async ({
  page,
  context,
}) => {
  const questions = await startQuestion(page);
  await context.setOffline(true);
  await expect(questions).toHaveAttribute("data-question-state", "offline");
  await context.setOffline(false);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(questions).toHaveAttribute("data-question-state", "ready");
  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(page.locator(WORKBENCH)).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("coding-workbench-terminal-outcome")).toHaveAttribute(
    "data-terminal-state",
    "cancelled",
  );
});

test("#2258 live out-of-scope tool attempt remains terminal and contained", async ({ page }) => {
  await resetLiveScenario(page, "out-of-scope");
  await openWorkbench(page);
  await page.getByLabel("Task instructions").fill("Synthetic containment qualification");
  await page.getByRole("button", { name: "Start coding run" }).click();
  await expect(page.locator(WORKBENCH)).toHaveAttribute("data-state", "idle");
  await expect
    .poll(async () => liveHarnessStatus(page))
    .toMatchObject({
      outsideUnchanged: true,
      outOfScopeAttemptRecorded: true,
    });
});

test("#2258 live workspace-head drift fails closed before the managed run starts", async ({
  page,
}) => {
  await resetLiveScenario(page);
  await injectWorkspaceDrift(page);
  await openWorkbench(page);
  await page.getByLabel("Task instructions").fill("Synthetic workspace drift qualification");
  await expect(page.getByRole("button", { name: "Start coding run" })).toBeEnabled();
  await page.getByRole("button", { name: "Start coding run" }).click();
  await expect(page.locator(WORKBENCH)).toHaveAttribute("data-state", "idle");
  await expect
    .poll(async () => liveHarnessStatus(page))
    .toMatchObject({
      workspaceDriftInjected: true,
    });
});

test("#2258 live Git delivery commits once through the separately approved BFF", async ({
  page,
}) => {
  const projectId = await activeWorkspaceRoot(page);
  const request = {
    schemaVersion: "1",
    projectId,
    message: "test: one-use live delivery",
    allowEmpty: false,
  };
  const headers = { "X-Keiko-CSRF": "1" };
  const issued = await page.request.post("/api/git-delivery/commit/approval", {
    data: { ...request, confirmed: true },
    headers,
  });
  expect(issued.status()).toBe(201);
  const approval = approvalClaim(await issued.json());
  const executed = await page.request.post("/api/git-delivery/commit/execute", {
    data: { ...request, approval },
    headers,
  });
  expect(executed.status()).toBe(200);
  expect(await executed.json()).toMatchObject({ status: "succeeded", actionKind: "commit" });
  const replay = await page.request.post("/api/git-delivery/commit/execute", {
    data: { ...request, approval },
    headers,
  });
  expect(replay.status()).toBe(400);
});

blockedLiveScenario(
  "Codex credentialed attestation",
  "an approved maintainer subscription is required before this release-blocking path may run",
);
blockedLiveScenario(
  "macOS native containment attestation",
  "a platform-qualified native-helper receipt is required before this release-blocking path may run",
);

function blockedLiveScenario(name: string, reason: string): void {
  test(`#2258 release blocker: ${name}`, () => {
    test.fixme(true, reason);
  });
}

async function startQuestion(page: Page): Promise<Locator> {
  await resetLiveScenario(page);
  await openWorkbench(page);
  await page.getByRole("radio", { name: "Keiko Gateway" }).check();
  await page.getByRole("radio", { name: "Ask for approval" }).check();
  await page.getByLabel("Task instructions").fill("Synthetic managed-runtime qualification");
  await expect(page.getByRole("button", { name: "Start coding run" })).toBeEnabled();
  await page.getByRole("button", { name: "Start coding run" }).click();
  await expect(page.getByTestId("coding-workbench-terminal-outcome")).toHaveCount(0);
  const questions = page.getByTestId("coding-workbench-questions");
  await expect(page.locator(WORKBENCH)).toHaveAttribute("data-state", "running");
  await expect(questions).toHaveAttribute("data-question-state", "ready");
  return questions;
}

async function activeWorkspaceRoot(page: Page): Promise<string> {
  const response = await page.request.get("/api/task-workspaces/active");
  expect(response.status()).toBe(200);
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null) throw new Error("invalid-active-workspace");
  const active = (payload as Record<string, unknown>).active;
  if (typeof active !== "object" || active === null) throw new Error("missing-active-workspace");
  const binding = (active as Record<string, unknown>).binding;
  if (typeof binding !== "object" || binding === null) throw new Error("missing-workspace-binding");
  const root = (binding as Record<string, unknown>).activeRoot;
  if (typeof root !== "string" || root.length === 0) throw new Error("invalid-workspace-root");
  return root;
}

function approvalClaim(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) throw new Error("invalid-delivery-approval");
  const approval = (payload as Record<string, unknown>).approval;
  if (typeof approval !== "object" || approval === null)
    throw new Error("missing-delivery-approval");
  return approval;
}

async function assertFocusableControlsRemainWithinWorkbenchFrame(page: Page): Promise<void> {
  const result = await page.locator(WORKBENCH).evaluate((workbench) => {
    const focusableSelector = [
      "a[href]",
      "button:not(:disabled)",
      "input:not(:disabled)",
      "select:not(:disabled)",
      "textarea:not(:disabled)",
      '[tabindex]:not([tabindex="-1"])',
    ].join(", ");
    const body = workbench.closest<HTMLElement>(".win-body");
    const frame = workbench.closest<HTMLElement>(".win-frame-clip");
    if (body === null || frame === null) {
      return { failures: ["missing Workbench frame boundary"], scrollWidth: 0, clientWidth: 0 };
    }

    const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const intersect = (first: DOMRect, second: DOMRect): DOMRect =>
      new DOMRect(
        Math.max(first.left, second.left),
        Math.max(first.top, second.top),
        Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left)),
        Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top)),
      );
    const visibleFrame = intersect(
      intersect(body.getBoundingClientRect(), frame.getBoundingClientRect()),
      viewport,
    );
    const activeElement = document.activeElement;
    const scrollLeft = body.scrollLeft;
    const scrollTop = body.scrollTop;

    const failures = [...workbench.querySelectorAll<HTMLElement>(focusableSelector)].flatMap(
      (control) => {
        if (control.getClientRects().length === 0) return [];
        control.focus();
        const bounds = control.getBoundingClientRect();
        const visible = intersect(bounds, visibleFrame);
        if (visible.width > 0 && visible.height > 0) return [];
        const name = control.getAttribute("aria-label") ?? control.textContent.trim();
        return [`${control.tagName} "${name}" is outside the visible Workbench frame`];
      },
    );
    body.scrollTo({ left: scrollLeft, top: scrollTop });
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
    return { failures, scrollWidth: body.scrollWidth, clientWidth: body.clientWidth };
  });
  assertFocusableControlsFitWithinWorkbenchFrame(result);
}

function assertFocusableControlsFitWithinWorkbenchFrame(result: {
  failures: string[];
  scrollWidth: number;
  clientWidth: number;
}): void {
  expect(
    result.scrollWidth,
    "Workbench frame must not contain clipped horizontal content",
  ).toBeLessThanOrEqual(result.clientWidth + 1);
  expect(result.failures).toEqual([]);
}

async function assertWorkbenchUsesSingleColumnLayout(page: Page): Promise<void> {
  const columnCounts = await page.locator(WORKBENCH).evaluate((workbench) => {
    const columnCount = (selector: string): number => {
      const element = workbench.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`missing ${selector}`);
      return getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u).length;
    };
    return {
      workbench: columnCount(".coding-workbench-grid"),
      mode: columnCount(".coding-workbench-mode-grid"),
    };
  });
  expect(columnCounts).toEqual({ workbench: 1, mode: 1 });
}
