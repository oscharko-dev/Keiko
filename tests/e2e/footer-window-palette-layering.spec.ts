import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";

let fixtureRoot: string | null = null;

interface PaletteHitTest {
  readonly point: {
    readonly x: number;
    readonly y: number;
  };
  readonly topClass: string | null;
  readonly insidePalette: boolean;
  readonly insideRightRail: boolean;
}

async function seedFilesWindow(
  page: Page,
  geometry = { x: 96, y: 72, w: 620, h: 640 },
): Promise<void> {
  fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-issue-1426-"));
  writeFileSync(join(fixtureRoot, "README.md"), "# Keiko overlay fixture\n", "utf8");

  await page.addInitScript(
    ({ root, geometry }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "issue-1426-files",
            type: "files",
            ...geometry,
            z: 10,
            cfg: { root },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { root: fixtureRoot, geometry },
  );
}

async function expectControlOwnsHitPoint(page: Page, name: string): Promise<void> {
  const control = page.getByRole("button", { name, exact: true });
  await expect(control).toBeVisible();
  const hit = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      owned: top !== null && element.contains(top),
      windowIntercepts: top?.closest(".window") !== null,
    };
  });
  expect(hit, name).toEqual({ owned: true, windowIntercepts: false });
}

test("workspace controls @smoke — ordinary windows cannot cover new-window or zoom controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await seedFilesWindow(page, { x: 0, y: 0, w: 2000, h: 1600 });
  await page.goto("/");
  const frame = page.locator('[data-window-id="issue-1426-files"]');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("data-max", "false");
  for (const name of ["New window", "Zoom out", "Zoom in"]) {
    await expectControlOwnsHitPoint(page, name);
  }
  await page.getByRole("button", { name: "New window", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New window", exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "New window", exact: true }).press("Escape");
  await expect(page.getByRole("dialog", { name: "New window", exact: true })).toBeHidden();
  await frame.locator("[data-window-header]").dblclick({ position: { x: 100, y: 20 } });
  await expect(page.getByRole("button", { name: "New window", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Zoom out", exact: true })).toBeHidden();
});

// GEN-UI-A11Y-025 turned the right rail from a named <aside> landmark into a plain <div> layout
// spacer. The old `aside.rail.rail-right` selector kept matching nothing, which made the
// `insideRightRail` assertion below vacuously true: `closest()` on a selector no element can
// satisfy returns null whatever the palette actually overlaps. Selecting the rail by its class is
// what makes the negative a real one.
async function expectTriggerClearsRightRail(page: Page): Promise<void> {
  const rightRail = page.locator(".rail.rail-right");
  await expect(rightRail).toBeVisible();

  const trigger = page.getByRole("button", { name: /1 window/u });
  await expect(trigger).toBeVisible();

  const triggerBox = await trigger.boundingBox();
  const railBox = await rightRail.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  if (triggerBox === null || railBox === null) {
    throw new Error("expected footer trigger and right rail bounding boxes");
  }
  expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(railBox.x - 4);
}

async function openWindowPalette(page: Page): Promise<void> {
  await page.getByRole("button", { name: /1 window/u }).click();
  const palette = page.locator(".ft-window-palette");
  await expect(palette).toBeVisible();
  await expect(page.locator(".ft-window-card")).toHaveCount(1);
}

async function edgeHitTest(page: Page, selector: string): Promise<PaletteHitTest> {
  return page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof HTMLElement)) {
      throw new Error(`${targetSelector} not found`);
    }
    const rect = target.getBoundingClientRect();
    const x = Math.floor(rect.right - 4);
    const y = Math.floor(rect.top + rect.height / 2);
    const top = document.elementFromPoint(x, y);
    return {
      point: { x, y },
      topClass: top instanceof HTMLElement ? top.className : null,
      insidePalette:
        top instanceof Element && top.closest(".ft-window-palette, .ft-window-card") !== null,
      insideRightRail: top instanceof Element && top.closest(".rail.rail-right") !== null,
    };
  }, selector);
}

async function expectGatewaySetupClearsRailReserve(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-keiko-gateway-setup-open", "true");
  });
  await expect(page.locator(".rail.rail-right")).toBeHidden();

  const footerSpacing = await page.evaluate(() => {
    const footer = document.querySelector(".footer");
    if (!(footer instanceof HTMLElement)) {
      throw new Error("workspace footer not found");
    }
    const rootStyle = getComputedStyle(document.documentElement);
    const footerStyle = getComputedStyle(footer);
    return {
      space5: rootStyle.getPropertyValue("--space-5").trim(),
      paddingRight: footerStyle.paddingRight,
    };
  });
  expect(footerSpacing.paddingRight).toBe(footerSpacing.space5);
}

test("footer window palette clears the right rail and wins hit-testing at its edge", async ({
  page,
}) => {
  await seedFilesWindow(page);
  await page.goto("/");
  await expectTriggerClearsRightRail(page);
  await openWindowPalette(page);

  for (const hitTest of [
    await edgeHitTest(page, ".ft-window-palette"),
    await edgeHitTest(page, ".ft-window-card"),
  ]) {
    expect(hitTest.insidePalette, JSON.stringify(hitTest)).toBe(true);
    expect(hitTest.insideRightRail, JSON.stringify(hitTest)).toBe(false);
  }

  await expectGatewaySetupClearsRailReserve(page);
});

async function expectWorkbenchInsideCanvas(page: Page): Promise<void> {
  const frame = page.locator(".window").filter({
    has: page.locator('section[aria-label="Coding Workbench"][data-state]'),
  });
  await expect(frame).toHaveCount(1);
  await expect
    .poll(async () => {
      const [windowBox, canvasBox] = await Promise.all([
        frame.boundingBox(),
        page.locator("main.workspace").boundingBox(),
      ]);
      if (windowBox === null || canvasBox === null) throw new Error("Expected workspace geometry");
      return windowBox.y + windowBox.height - (canvasBox.y + canvasBox.height);
    })
    .toBeLessThanOrEqual(1);
}

test("workspace allocation @smoke — existing browser notice leaves new tool controls reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await installLiveCodingWorkbenchRuntime(page);
  await page.route("**/api/coding-workbench/app-session/browser", (route) =>
    route.fulfill({ json: { state: "unavailable" } }),
  );
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Connect browser", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Coding Workbench", exact: true }).click();
  await expect(fixture.workbench).toBeVisible();
  await expectWorkbenchInsideCanvas(page);
  await page.getByLabel("Task instructions").fill("Inspect the current project");
  await page.getByRole("button", { name: "Start coding run", exact: true }).click();
  await expect(fixture.workbench).toHaveAttribute("data-state", "awaiting-approval");
});

test("workspace allocation @smoke — late browser notice leaves fresh tool controls reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await installLiveCodingWorkbenchRuntime(page);
  let release = (): void => undefined;
  const inventoryGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/coding-workbench/app-session/browser", async (route) => {
    await inventoryGate;
    await route.fulfill({ json: { state: "unavailable" } });
  });
  try {
    await fixture.open();
    await expect(page.getByRole("button", { name: "Connect browser", exact: true })).toBeHidden();
    await expectWorkbenchInsideCanvas(page);
    release();
    await expect(page.getByRole("button", { name: "Connect browser", exact: true })).toBeVisible();
    await expectWorkbenchInsideCanvas(page);
    await page.getByLabel("Task instructions").fill("Inspect the current project");
    await page.getByRole("button", { name: "Start coding run", exact: true }).click();
    await expect(fixture.workbench).toHaveAttribute("data-state", "awaiting-approval");
  } finally {
    release();
  }
});

test.afterEach(() => {
  if (fixtureRoot === null) return;
  rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = null;
});
