// Issue #2523 — executable real-BFF Workspace Trust journey. Every transition is driven through
// the human-facing prompt or management window and awaited at the canonical server route; the test
// never injects trusted client state or calls the route directly.

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  cleanupEditorWorkspaces,
  createEditorWorkspace,
  openEditorWorkspace,
  revokeEditorWorkspaceTrust,
  seedEditorWindow,
} from "./support/editorWorkspace.js";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";

const MODIFIER = process.platform === "darwin" ? "Meta" : "Control";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const SOURCE = "src/index.ts";
const PACKAGE_JSON = JSON.stringify(
  {
    name: "keiko-workspace-trust-e2e",
    private: true,
    type: "module",
    scripts: { typecheck: "tsc --noEmit" },
    devDependencies: { typescript: "*" },
  },
  null,
  2,
);

async function runPaletteCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press(`${MODIFIER}+Shift+KeyP`);
  const query = page.getByRole("combobox", { name: "Command query" });
  await expect(query).toBeVisible();
  await query.fill(`>${title}`);
  const option = page.getByRole("option").filter({ hasText: title }).first();
  await expect(option).toBeVisible();
  await option.click();
}

async function expectNoPaletteCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press(`${MODIFIER}+Shift+KeyP`);
  const query = page.getByRole("combobox", { name: "Command query" });
  await query.fill(`>${title}`);
  await expect(page.getByRole("option").filter({ hasText: title })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

async function expectPaletteCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press(`${MODIFIER}+Shift+KeyP`);
  const query = page.getByRole("combobox", { name: "Command query" });
  await query.fill(`>${title}`);
  await expect(page.getByRole("option").filter({ hasText: title }).first()).toBeVisible();
  await page.keyboard.press("Escape");
}

async function expectAxeGreen(page: Page, selector: string): Promise<void> {
  const violations = seriousOrCritical(await runAxe(page, selector));
  expect(violations, formatViolations(violations)).toEqual([]);
}

test.afterEach(() => {
  cleanupEditorWorkspaces();
});

async function openUntrustedEditor(page: Page): Promise<void> {
  const fixture = createEditorWorkspace([
    { path: "package.json", content: `${PACKAGE_JSON}\n` },
    { path: SOURCE, content: "export const answer: number = 42;\n" },
  ]);
  const project = await page.request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: fixture.root, name: "Workspace Trust E2E" },
  });
  expect(project.ok(), await project.text()).toBe(true);
  await revokeEditorWorkspaceTrust(page.request, fixture.root);
  await seedEditorWindow(page, {
    root: fixture.root,
    active: SOURCE,
    openFiles: [SOURCE],
    windowId: "issue-2523-editor",
  });
  await page.goto("/");
  await openEditorWorkspace(page, { dismissTrustPrompt: false });
}

async function stayRestrictedAtPrompt(page: Page): Promise<void> {
  const prompt = page.getByRole("alertdialog", { name: "Trust this workspace?" });
  await expect(prompt).toBeVisible();
  const stayRestricted = prompt.getByRole("button", { name: "Stay restricted" });
  await expect(stayRestricted).toBeFocused();
  await expectAxeGreen(page, "[role='alertdialog']");
  await page.keyboard.press("Enter");
  await expect(prompt).toBeHidden();

  const editorBanner = page.getByTestId("workspace-trust-banner-editor");
  await expect(editorBanner).toContainText("Restricted Mode");
  await expectNoPaletteCommand(page, "Run Typecheck");
}

async function inspectRestrictedLanguageStatus(page: Page): Promise<void> {
  await runPaletteCommand(page, "Open Settings");
  const settings = page.getByRole("region", { name: /^Settings/u });
  await settings.getByRole("button", { name: "Languages" }).click();
  const languageBanner = page.getByTestId("workspace-trust-banner-languages");
  await expect(languageBanner).toContainText("Managed language servers remain disabled");
  await expectAxeGreen(page, "[data-testid='workspace-trust-banner-languages']");
}

async function grantFromManagement(page: Page): Promise<Locator> {
  await runPaletteCommand(page, "Open Workspace Trust");
  const panel = page.getByTestId("workspace-trust-panel");
  const card = panel.getByTestId("workspace-trust-root").filter({ hasText: "Workspace Trust E2E" });
  await expect(card).toBeVisible();
  await expectAxeGreen(page, "[data-testid='workspace-trust-panel']");
  const grantResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/editor/verification/trust"),
  );
  const trustButton = card.getByRole("button", { name: "Trust" });
  await expect(trustButton).toBeEnabled();
  await trustButton.click();
  const grantDialog = page.getByRole("alertdialog", { name: "Trust this workspace?" });
  await expect(grantDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await grantDialog.getByRole("button", { name: "Trust workspace" }).click();
  expect((await grantResponse).status()).toBe(200);
  await expect(card.getByText("Trusted workspace")).toBeVisible();
  await expect(page.getByTestId("workspace-trust-banner-editor")).toHaveCount(0);
  return panel;
}

async function assertTrustedCapability(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close Workspace Trust window" }).click();
  await page.getByRole("button", { name: "Close Settings window" }).click();
  await expectPaletteCommand(page, "Run Typecheck");
}

async function revokeFromManagement(page: Page, panel: Locator): Promise<void> {
  await runPaletteCommand(page, "Open Workspace Trust");
  const card = panel.getByTestId("workspace-trust-root").filter({ hasText: "Workspace Trust E2E" });
  const revokeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().endsWith("/api/editor/verification/trust"),
  );
  await card.getByRole("button", { name: "Revoke" }).click();
  await page
    .getByRole("alertdialog", { name: "Revoke trust for this workspace?" })
    .getByRole("button", { name: "Revoke trust" })
    .click();
  expect((await revokeResponse).status()).toBe(200);
  await expect(card.getByText("Restricted Mode")).toBeVisible();
  await expect(page.getByTestId("workspace-trust-banner-editor")).toBeVisible();
}

async function assertNarrowTextZoomLayout(page: Page, panel: Locator): Promise<void> {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const metrics = await panel.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflow: [...element.querySelectorAll<HTMLElement>("*")]
      .filter((child) => child.scrollWidth > child.clientWidth + 1)
      .map((child) => ({
        className: child.className,
        clientWidth: child.clientWidth,
        scrollWidth: child.scrollWidth,
        tag: child.tagName,
      }))
      .slice(0, 10),
  }));
  expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
}

test("an untrusted root stays restricted until an explicit confirmed grant and returns after revoke", async ({
  page,
}) => {
  await openUntrustedEditor(page);
  await stayRestrictedAtPrompt(page);
  await inspectRestrictedLanguageStatus(page);
  const panel = await grantFromManagement(page);
  await assertTrustedCapability(page);
  await revokeFromManagement(page, panel);
  await assertNarrowTextZoomLayout(page, panel);
});
