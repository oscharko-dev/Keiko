import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";

import {
  cleanupEditorWorkspaces,
  createEditorWorkspace,
  firstPane,
  openEditorWorkspace,
  seedEditorWindow,
  typeIntoActiveEditor,
} from "./support/editorWorkspace.js";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { FILE_HISTORY_APP_SESSION_LAUNCHER_SECRET } from "./support/file-history-2531.js";

const FILE = "src/app.ts";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const VERSIONS = [
  'export const historyValue = "one";\n',
  'export const historyValue = "two";\n',
  'export const historyValue = "three";\n',
] as const;

function pairingFragment(): string {
  return encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: FILE_HISTORY_APP_SESSION_LAUNCHER_SECRET,
      requestId: `req_history-${String(Date.now())}`,
      issuedAtMs: Date.now(),
    }),
  );
}

async function saveVersion(page: Page, pane: Locator, content: string): Promise<void> {
  await typeIntoActiveEditor(page, pane, content);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().endsWith("/api/files/content"),
  );
  await pane.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(pane.locator(".ed-tab[data-dirty='true']")).toHaveCount(0);
}

function historyRows(pane: Locator): Locator {
  return pane.locator("li[data-entry-ref]");
}

async function openHistory(pane: Locator): Promise<void> {
  await pane.getByRole("button", { name: "Open file history" }).click();
  await expect(pane.getByRole("complementary", { name: "File history" })).toBeVisible();
}

test.afterAll(() => {
  cleanupEditorWorkspaces();
});

async function prepareHistoryJourney(
  page: Page,
): Promise<{ root: string; pane: Locator; oldestContent: string }> {
  const { root } = createEditorWorkspace([{ path: FILE, content: "" }]);
  await seedEditorWindow(page, {
    root,
    openFiles: [FILE],
    active: FILE,
    windowId: "issue-2531-editor",
    maximized: true,
  });
  await page.goto(`/${pairingFragment()}`);
  await expect.poll(() => page.url()).not.toContain("keiko-app-session");
  const project = await page.request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name: "Issue 2531 history" },
  });
  expect(project.ok(), await project.text()).toBe(true);
  const workspace = await openEditorWorkspace(page);
  const pane = firstPane(workspace);
  await saveVersion(page, pane, VERSIONS[0]);
  const oldestContent = readFileSync(join(root, FILE), "utf8");
  for (const version of VERSIONS.slice(1)) await saveVersion(page, pane, version);
  await openHistory(pane);
  await expect(historyRows(pane)).toHaveCount(3);
  await expect(historyRows(pane).getByText("User save")).toHaveCount(3);
  return { root, pane, oldestContent };
}

async function verifyResponsiveAccessibility(page: Page, pane: Locator): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const panel = pane.getByRole("complementary", { name: "File history" });
  await panel.evaluate((element) => {
    element.style.width = "320px";
  });
  const width = await panel.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(width.client).toBeLessThanOrEqual(320);
  expect(width.scroll).toBeLessThanOrEqual(width.client);
  const violations = seriousOrCritical(await runAxe(page, "aside[aria-label='File history']"));
  expect(violations, formatViolations(violations)).toEqual([]);
}

test("#2531 file history compares, pins, restores safely, and stays accessible", async ({
  page,
}) => {
  const { root, pane, oldestContent } = await prepareHistoryJourney(page);
  const oldest = historyRows(pane).last();
  await oldest.getByRole("button", { name: "Compare with current" }).click();
  await expect(
    pane.getByTestId("history-diff").or(pane.locator(".monaco-diff-editor")),
  ).toBeVisible();
  await pane.getByRole("button", { name: "Back to file history" }).click();

  await oldest.getByRole("button", { name: "Pin restore point" }).click();
  await expect(oldest.getByText("Pinned")).toBeVisible();
  await oldest.getByRole("button", { name: "Restore", exact: true }).click();
  const restoreSave = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().endsWith("/api/files/content"),
  );
  await page.getByRole("alertdialog").getByRole("button", { name: "Restore version" }).click();
  expect((await restoreSave).ok()).toBe(true);
  await expect(
    historyRows(pane).getByRole("button", { name: /Restore point \d+, Restore,/u }),
  ).toHaveCount(1);
  expect(readFileSync(join(root, FILE), "utf8")).toBe(oldestContent);
  await expect(pane.locator(".view-lines")).toContainText("historyValue");

  await pane.getByRole("button", { name: "Close file history" }).click();
  await typeIntoActiveEditor(page, pane, 'export const historyValue = "dirty";\n');
  await openHistory(pane);
  const diskBeforeConflict = readFileSync(join(root, FILE), "utf8");
  await historyRows(pane).first().getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    pane.getByRole("alert").filter({ hasText: "Unsaved edits prevent restore" }),
  ).toBeVisible();
  expect(readFileSync(join(root, FILE), "utf8")).toBe(diskBeforeConflict);

  const durableBrowserState = await page.evaluate(() => JSON.stringify(window.localStorage));
  expect(durableBrowserState).not.toContain("historyValue");
  await verifyResponsiveAccessibility(page, pane);
});
