import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function seedFilesWindow(page: Page): Promise<void> {
  fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-issue-1426-"));
  writeFileSync(join(fixtureRoot, "README.md"), "# Keiko overlay fixture\n", "utf8");

  await page.addInitScript((root) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-1426-files",
          type: "files",
          x: 96,
          y: 72,
          w: 620,
          h: 640,
          z: 10,
          cfg: { root },
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  }, fixtureRoot);
}

async function expectTriggerClearsRightRail(page: Page): Promise<void> {
  const rightRail = page.locator("aside.rail.rail-right");
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
      insideRightRail: top instanceof Element && top.closest("aside.rail.rail-right") !== null,
    };
  }, selector);
}

async function expectGatewaySetupClearsRailReserve(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-keiko-gateway-setup-open", "true");
  });
  await expect(page.locator("aside.rail.rail-right")).toBeHidden();

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

test.afterEach(() => {
  if (fixtureRoot === null) return;
  rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = null;
});
