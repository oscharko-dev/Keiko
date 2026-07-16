import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";
import { evidenceArtifactPath } from "./support/evidence.js";

interface WorkbenchPerfStore {
  readonly longTasks: number[];
  observerInstalled: boolean;
}

function percentile(samples: readonly number[], percentileValue: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

async function installWorkbenchPerfObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: WorkbenchPerfStore = { longTasks: [], observerInstalled: false };
    (window as unknown as { __codingWorkbenchPerf: WorkbenchPerfStore }).__codingWorkbenchPerf =
      store;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) store.longTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: false });
      store.observerInstalled = true;
    } catch {
      // Chromium exposes Long Tasks; this stays best-effort for local browser substitutions.
    }
  });
}

async function resetWorkbenchPerfObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __codingWorkbenchPerf: WorkbenchPerfStore })
      .__codingWorkbenchPerf;
    store.longTasks.length = 0;
  });
}

async function measureTimelineInteractions(
  page: Page,
): Promise<{ readonly samples: readonly number[]; readonly maxLongTaskMs: number }> {
  const timeline = page.getByRole("list", { name: "Coding run event timeline" });
  const samples: number[] = [];
  for (let interaction = 0; interaction < 20; interaction += 1) {
    samples.push(
      await timeline.evaluate(async (node, index) => {
        const start = performance.now();
        node.scrollTop = index % 2 === 0 ? node.scrollHeight : 0;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve();
            });
          });
        });
        return performance.now() - start;
      }, interaction),
    );
  }
  const store = await page.evaluate(
    () =>
      (window as unknown as { __codingWorkbenchPerf: WorkbenchPerfStore }).__codingWorkbenchPerf,
  );
  expect(store.observerInstalled).toBe(true);
  return { samples, maxLongTaskMs: Math.max(0, ...store.longTasks) };
}

test("#2257 drives the full live runtime lifecycle without persisted task content", async ({
  page,
}) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page);
  await fixture.open();

  await page.getByLabel("Task instructions").fill("Investigate a deterministic regression");
  await page.getByRole("button", { name: "Start coding run" }).click();
  await expect(page.getByRole("heading", { name: "Review the bounded action" })).toBeVisible();
  await page.getByRole("button", { name: "Approve once" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "running");
  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(page.getByRole("button", { name: "Acknowledge recovery" })).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge recovery" }).click();
  await page.getByLabel("Task instructions").fill("Retry from server-confirmed recovery");
  await page.getByRole("button", { name: "Retry as a fresh run" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "running");
  await expect(
    page.getByText("Investigate a deterministic regression", { exact: true }),
  ).toHaveCount(0);
  fixture.assertValidRequests();
});

test("#2257 binds denial to a cancelled server transition", async ({ page }) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page, {
    initialState: "awaiting-approval",
  });
  await fixture.open();
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "cancelled");
  fixture.assertValidRequests();
});

test("#2257 binds takeover to a taken-over server transition", async ({ page }) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page, { initialState: "running" });
  await fixture.open();
  await page.getByRole("button", { name: "Take over manually" }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "taken-over");
  fixture.assertValidRequests();
});

for (const auth of [
  { status: "missing" as const, label: "Sign-in required" },
  { status: "expired" as const, label: "Session expired" },
]) {
  test(`#2257 exposes ${auth.status} subscription authentication as actionable`, async ({
    page,
  }) => {
    const fixture = await installLiveCodingWorkbenchRuntime(page, { authStatus: auth.status });
    await fixture.open();
    await page.getByRole("radio", { name: /ChatGPT\/Codex subscription/u }).check();

    await expect(page.getByText(auth.label, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh authentication" })).toBeVisible();
    await page.getByRole("button", { name: "Prepare device-code login" }).click();
    await expect(page.getByText("Setup plan ready", { exact: true })).toBeVisible();
    await expect(page.getByText(/Command: codex-login-device-auth/u)).toBeVisible();
    await page.getByLabel("Task instructions").fill("Must remain blocked without authentication");
    await expect(page.getByRole("button", { name: "Start coding run" })).toBeDisabled();
    fixture.assertValidRequests();
  });
}

test("#2257 keeps Start disabled when the runtime is unavailable", async ({ page }) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page, { runtimeAvailable: false });
  await fixture.open();
  await page.getByLabel("Task instructions").fill("Must remain blocked without a runtime");

  await expect(fixture.workbench).toHaveAttribute("data-state", "unavailable");
  await expect(page.getByText("Runtime not confirmed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start coding run" })).toBeDisabled();
  fixture.assertValidRequests();
});

test("#2257 reconnects a dropped event stream without duplicating its timeline", async ({
  page,
}) => {
  const fixture = await installLiveCodingWorkbenchRuntime(page, {
    initialState: "running",
    eventCount: 4,
    disconnectStreamOnce: true,
  });
  await fixture.open();

  await expect.poll(fixture.streamConnectionCount).toBeGreaterThanOrEqual(2);
  const rows = page
    .getByRole("list", { name: "Coding run event timeline" })
    .locator('li:not([aria-hidden="true"])');
  await expect(rows).toHaveCount(4);
  fixture.assertValidRequests();
});

test("#2257 retains a 1,000-event feed virtually and remains responsive", async ({
  page,
}, testInfo) => {
  await installWorkbenchPerfObserver(page);
  const fixture = await installLiveCodingWorkbenchRuntime(page, {
    initialState: "running",
    eventCount: 1_000,
  });
  await page.goto("/");
  await resetWorkbenchPerfObserver(page);
  await page.getByRole("button", { name: "Coding Workbench" }).click();
  await expect(page.getByRole("heading", { name: "Coding Workbench" })).toBeVisible();

  const timeline = page.getByRole("list", { name: "Coding run event timeline" });
  await expect(timeline.locator('li:not([aria-hidden="true"])')).toHaveCount(96);
  await expect
    .poll(async () => timeline.locator('li:not([aria-hidden="true"])').count())
    .toBeLessThanOrEqual(96);
  expect(await fixture.workbench.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(
    true,
  );
  const interaction = await measureTimelineInteractions(page);
  const interactionP95Ms = percentile(interaction.samples, 95);
  const performanceProof = codingWorkbenchPerformanceProof(
    interactionP95Ms,
    interaction.maxLongTaskMs,
    interaction.samples,
  );
  await testInfo.attach("coding-workbench-performance.json", {
    body: JSON.stringify(performanceProof, null, 2),
    contentType: "application/json",
  });
  expect(interaction.samples).toHaveLength(20);
  expect(interactionP95Ms).toBeLessThanOrEqual(200);
  expect(interaction.maxLongTaskMs).toBeLessThanOrEqual(50);
  writePerformanceProof(performanceProof);
  fixture.assertValidRequests();
});

function codingWorkbenchPerformanceProof(
  interactionP95Ms: number,
  maxLongTaskMs: number,
  samples: readonly number[],
): Record<string, unknown> {
  return {
    issue: 2257,
    surface: "live-coding-workbench-timeline",
    status: "verified",
    verified: true,
    seedEventCount: 1000,
    maximumRetainedEvents: 500,
    maximumRenderedRows: 96,
    maximumInteractionP95Ms: 200,
    maximumLongTaskMs: 50,
    measurements: { interactionP95Ms, maxLongTaskMs, samples },
    command:
      "npx playwright test --config tests/e2e/config/playwright.issue-2257-coding-workbench.config.ts --project=chromium --grep 1,000-event",
  };
}

function writePerformanceProof(proof: Record<string, unknown>): void {
  const output = evidenceArtifactPath("docs/design-system/evidence/2257/performance-proof.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
}

test("#2257 supports light high-contrast narrow operation without serious axe violations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 860 });
  await page.addInitScript(() => {
    window.localStorage.setItem("keiko.theme", "light");
  });
  const fixture = await installLiveCodingWorkbenchRuntime(page, {
    initialState: "awaiting-approval",
  });
  await fixture.open();
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-hc", "more");
  });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute("data-hc", "more");
  const violations = seriousOrCritical(
    await runAxe(page, 'section[aria-label="Coding Workbench"][data-state]'),
  );
  expect(violations.length, formatViolations(violations)).toBe(0);
});
