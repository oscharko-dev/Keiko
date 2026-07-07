import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot: string | null = null;

const WINDOW_IDS = ["issue-2055-files-a", "issue-2055-files-b", "issue-2055-files-c"] as const;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Box extends Point {
  readonly width: number;
  readonly height: number;
}

test.use({ viewport: { width: 1280, height: 860 } });

async function seedWorkspace(page: Page): Promise<void> {
  fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-issue-2055-"));
  mkdirSync(join(fixtureRoot, "docs"), { recursive: true });
  writeFileSync(join(fixtureRoot, "README.md"), "# Keiko issue 2055 fixture\n", "utf8");
  writeFileSync(join(fixtureRoot, "docs", "notes.md"), "# Notes\n", "utf8");

  await page.addInitScript((root) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-2055-files-a",
          type: "files",
          x: 160,
          y: 130,
          w: 220,
          h: 190,
          z: 1,
          cfg: { root },
          max: false,
        },
        {
          id: "issue-2055-files-b",
          type: "files",
          x: 440,
          y: 160,
          w: 220,
          h: 190,
          z: 2,
          cfg: { root },
          max: false,
        },
        {
          id: "issue-2055-files-c",
          type: "files",
          x: 760,
          y: 130,
          w: 220,
          h: 190,
          z: 3,
          cfg: { root },
          max: false,
        },
      ]),
    );
    window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
    window.localStorage.removeItem("keiko.conns.v1");
  }, fixtureRoot);
}

function windowById(page: Page, id: string): Locator {
  return page.locator(`.window[data-window-id="${id}"]`);
}

async function requiredBox(locator: Locator, label: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${label} bounding box was not available`);
  return box;
}

async function dragPointer(page: Page, start: Point, end: Point): Promise<void> {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

function delta(before: Box, after: Box): Point {
  return { x: after.x - before.x, y: after.y - before.y };
}

async function expectSelected(locator: Locator): Promise<void> {
  await expect(locator).toHaveAttribute("data-selected", "true");
}

test.afterEach(() => {
  if (fixtureRoot === null) return;
  rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = null;
});

test("workspace multi-selection supports marquee, grouped drag, and local duplication #2055", async ({
  page,
}) => {
  await seedWorkspace(page);
  await page.goto("/");

  const workspace = page.locator("main.workspace");
  const selectionStatus = page.getByTestId("workspace-selection-status");
  const first = windowById(page, WINDOW_IDS[0]);
  const second = windowById(page, WINDOW_IDS[1]);
  const third = windowById(page, WINDOW_IDS[2]);

  await expect(workspace).toBeVisible();
  for (const id of WINDOW_IDS) {
    await expect(windowById(page, id)).toBeVisible();
  }
  await expect(selectionStatus).toHaveText("No workspace windows selected");

  const workspaceBox = await requiredBox(workspace, "workspace");
  const firstBox = await requiredBox(first, "first window");
  const secondBox = await requiredBox(second, "second window");
  const marqueeStart = {
    x: Math.max(workspaceBox.x + 24, Math.min(firstBox.x, secondBox.x) - 36),
    y: Math.max(workspaceBox.y + 24, Math.min(firstBox.y, secondBox.y) - 36),
  };
  const marqueeEnd = {
    x: Math.max(firstBox.x + firstBox.width, secondBox.x + secondBox.width) + 36,
    y: Math.max(firstBox.y + firstBox.height, secondBox.y + secondBox.height) + 36,
  };

  await page.mouse.move(marqueeStart.x, marqueeStart.y);
  await page.mouse.down();
  await page.mouse.move(marqueeEnd.x, marqueeEnd.y, { steps: 8 });
  await expect(page.getByTestId("workspace-marquee")).toBeVisible();
  await page.mouse.up();

  await expectSelected(first);
  await expectSelected(second);
  await expect(third).not.toHaveAttribute("data-selected", "true");
  await expect(selectionStatus).toHaveText("2 workspace windows selected");

  await third.focus();
  await page.keyboard.press("Space");
  await expectSelected(third);
  await expect(selectionStatus).toHaveText("3 workspace windows selected");

  const before = await Promise.all([
    requiredBox(first, "first window before drag"),
    requiredBox(second, "second window before drag"),
    requiredBox(third, "third window before drag"),
  ]);
  const headerBox = await requiredBox(first.locator("header").first(), "first window header");
  await dragPointer(
    page,
    { x: headerBox.x + headerBox.width / 2, y: headerBox.y + 18 },
    { x: headerBox.x + headerBox.width / 2 + 72, y: headerBox.y + 54 },
  );
  const after = await Promise.all([
    requiredBox(first, "first window after drag"),
    requiredBox(second, "second window after drag"),
    requiredBox(third, "third window after drag"),
  ]);
  const firstDelta = delta(before[0], after[0]);
  expect(firstDelta.x).toBeGreaterThan(40);
  expect(firstDelta.y).toBeGreaterThan(24);
  expect(delta(before[1], after[1]).x).toBeCloseTo(firstDelta.x, 0);
  expect(delta(before[1], after[1]).y).toBeCloseTo(firstDelta.y, 0);
  expect(delta(before[2], after[2]).x).toBeCloseTo(firstDelta.x, 0);
  expect(delta(before[2], after[2]).y).toBeCloseTo(firstDelta.y, 0);

  await workspace.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press("KeyC");
  await page.keyboard.press("KeyV");
  await page.keyboard.up(modifier);

  const copies = page.locator('.window[data-window-id^="files-copy-"]');
  await expect(copies).toHaveCount(3);
  await expect(selectionStatus).toHaveText("3 workspace windows selected");
  for (let index = 0; index < 3; index += 1) {
    await expect(copies.nth(index)).toHaveAttribute("data-selected", "true");
  }
});
