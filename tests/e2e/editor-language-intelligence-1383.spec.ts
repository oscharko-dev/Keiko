import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import {
  cleanupEditorWorkspaces,
  collectPageErrors,
  createEditorWorkspace,
  EDITOR_SELECTORS,
  openEditorWorkspace,
  openTreeFile,
  seedEditorWindow,
} from "./support/editorWorkspace.js";

const TAG = "@language-intelligence-1383";
const TS_FILE = "app.ts";
const PY_FILE = "tool.py";
const LARGE_FILE = "large.ts";
const MAX_BROWSER_DIAGNOSTICS = 512;

const CAPABILITIES = {
  schemaVersion: "1",
  providers: [
    {
      id: "typescript",
      languages: ["typescript", "javascript"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "available",
    },
    {
      id: "python-lsp",
      languages: ["python"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "unavailable",
      unavailableReason: "Host Python provider is disabled by policy.",
    },
  ],
} as const;

test.afterAll(() => {
  cleanupEditorWorkspaces();
});

function largeBuffer(): string {
  return Array.from(
    { length: 10_100 },
    (_unused, index) => `const value${String(index)} = ${String(index)};`,
  ).join("\n");
}

interface LanguageRouteBody {
  readonly operation?: string;
  readonly document?: { readonly path?: string };
  readonly position?: { readonly line?: number; readonly character?: number };
}

interface LanguageOperationCall {
  readonly operation: string;
  readonly path: string;
}

function diagnostic(index: number): Record<string, unknown> {
  return {
    range: {
      start: { line: index % 20, character: 0 },
      end: { line: index % 20, character: 5 },
    },
    severity: index === 0 ? "error" : "warning",
    message: `Bounded diagnostic ${String(index)}`,
    source: "typescript",
  };
}

function languageResponse(body: LanguageRouteBody): Record<string, unknown> {
  const operation = body.operation ?? "unknown";
  if (operation === "diagnostics") {
    return {
      operation,
      result: {
        diagnostics: Array.from({ length: MAX_BROWSER_DIAGNOSTICS }, (_unused, index) =>
          diagnostic(index),
        ),
        truncated: true,
      },
    };
  }
  if (operation === "hover") {
    return {
      operation,
      result: {
        contents: "Keiko language intelligence hover ready",
        range: {
          start: { line: body.position?.line ?? 0, character: 0 },
          end: { line: body.position?.line ?? 0, character: 11 },
        },
      },
    };
  }
  if (operation === "symbols") {
    return {
      operation,
      result: {
        symbols: [
          {
            name: "greeting",
            kind: "variable",
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
          },
        ],
        truncated: false,
      },
    };
  }
  return { operation, result: { edits: [], truncated: false } };
}

async function routeLanguageIntelligence(page: Page): Promise<{
  readonly calls: readonly LanguageOperationCall[];
}> {
  const calls: LanguageOperationCall[] = [];
  await page.route("**/api/editor/language/capabilities**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(CAPABILITIES),
    });
  });
  await page.route("**/api/editor/language", async (route) => {
    const body = route.request().postDataJSON() as LanguageRouteBody;
    const operation = body.operation ?? "unknown";
    calls.push({ operation, path: body.document?.path ?? "" });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(languageResponse(body)),
    });
  });
  return { calls };
}

async function attachShot(testInfo: TestInfo, page: Page, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

async function replaceMonacoText(page: Page, workspace: Locator, text: string): Promise<void> {
  const editor = workspace.locator(EDITOR_SELECTORS.monaco).first();
  await expect(editor).toBeVisible();
  await editor.click();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(modifier);
  await page.keyboard.insertText(text);
}

function statusField(workspace: Locator, id: string): Locator {
  return workspace.locator(`${EDITOR_SELECTORS.statusBar} [data-field="${id}"]`).first();
}

function statusBar(workspace: Locator): Locator {
  return workspace.locator(EDITOR_SELECTORS.statusBar).first();
}

function callsFor(
  routed: { readonly calls: readonly LanguageOperationCall[] },
  path: string,
): readonly LanguageOperationCall[] {
  return routed.calls.filter((call) => call.path === path);
}

function callCount(
  routed: { readonly calls: readonly LanguageOperationCall[] },
  path: string,
  operation?: string,
): number {
  return callsFor(routed, path).filter(
    (call) => operation === undefined || call.operation === operation,
  ).length;
}

async function openMatrixWorkspace(page: Page): Promise<Locator> {
  const { root } = createEditorWorkspace([
    { path: TS_FILE, content: "const greeting: string = 42;\ngreeting;\n" },
    { path: PY_FILE, content: "value = 1\n" },
    { path: LARGE_FILE, content: largeBuffer() },
  ]);
  await seedEditorWindow(page, { root, openFiles: [TS_FILE], active: TS_FILE });
  await page.goto("/");
  return openEditorWorkspace(page);
}

async function hoverOnGreeting(page: Page, workspace: Locator): Promise<void> {
  const usageLine = workspace.locator(".view-line", { hasText: "greeting;" });
  await expect(usageLine).toBeVisible();
  const box = await usageLine.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    await page.mouse.move(box.x + 24, box.y + box.height / 2);
  }
}

async function triggerSymbols(page: Page, workspace: Locator): Promise<void> {
  await workspace.locator(EDITOR_SELECTORS.monaco).first().click();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+Shift+KeyO`);
}

async function triggerFormat(workspace: Locator, force = false): Promise<void> {
  const button = workspace.getByRole("button", { name: "Format", exact: true });
  if (force) {
    await button.dispatchEvent("click");
    return;
  }
  await button.click();
}

async function assertAvailableStatus(workspace: Locator): Promise<void> {
  const statusBar = workspace.locator(EDITOR_SELECTORS.statusBar).first();
  await expect(statusBar).toHaveAttribute("role", "group");
  await expect(statusBar).toHaveAttribute("aria-label", "Editor status");
  await expect(statusField(workspace, "language")).toHaveText("TypeScript");
  await expect(statusField(workspace, "language")).toHaveAttribute(
    "aria-label",
    "Language: TypeScript",
  );
  await expect(statusField(workspace, "language-service")).toHaveText("typescript ready");
  await expect(statusField(workspace, "language-service")).toHaveAttribute(
    "aria-label",
    "Language provider available: typescript",
  );
  await expect(statusField(workspace, "formatting")).toHaveText("Format ready");
  await expect(statusField(workspace, "formatting")).toHaveAttribute(
    "aria-label",
    "Document formatting available",
  );
  await expect(workspace.getByRole("button", { name: "Format", exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
}

async function assertDiagnosticsAndHover(page: Page, workspace: Locator): Promise<void> {
  const diagnosticsStartedAt = Date.now();
  await expect
    .poll(() => workspace.locator(".squiggly-error, .squiggly-warning").count(), {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  await expect(statusField(workspace, "problems")).toHaveText("1 ⚠ 511");
  await expect(statusField(workspace, "problems")).toHaveAttribute(
    "aria-label",
    "Problems: 1 error, 511 warnings",
  );
  await expect(workspace.getByTestId("editor-status-bar-live")).toHaveAttribute("role", "status");
  await expect(workspace.getByTestId("editor-status-bar-live")).toContainText(
    "Problems: 1 error, 511 warnings",
  );
  expect(Date.now() - diagnosticsStartedAt).toBeLessThan(60_000);

  await hoverOnGreeting(page, workspace);
  await expect(page.locator(".monaco-hover").first()).toContainText(
    "Keiko language intelligence hover ready",
    { timeout: 30_000 },
  );
}

async function assertAvailableOperations(
  page: Page,
  workspace: Locator,
  routed: { readonly calls: readonly LanguageOperationCall[] },
): Promise<void> {
  await expect.poll(() => callCount(routed, TS_FILE, "diagnostics")).toBeGreaterThan(0);
  await expect.poll(() => callCount(routed, TS_FILE, "hover")).toBeGreaterThan(0);
  await expect(statusBar(workspace)).toHaveScreenshot("issue-1383-available-provider.png", {
    maxDiffPixelRatio: 0.001,
  });

  await triggerSymbols(page, workspace);
  await expect
    .poll(() => callCount(routed, TS_FILE, "symbols"), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await triggerFormat(workspace);
  await expect.poll(() => callCount(routed, TS_FILE, "formatting")).toBeGreaterThan(0);
}

test(`available provider shows language, diagnostics, hover, symbols, and format state ${TAG}`, async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);
  const routed = await routeLanguageIntelligence(page);
  const workspace = await openMatrixWorkspace(page);

  await assertAvailableStatus(workspace);
  await assertDiagnosticsAndHover(page, workspace);
  await assertAvailableOperations(page, workspace, routed);
  await attachShot(testInfo, page, "available-provider-diagnostics-hover-status.png");
  expect(errors).toEqual([]);
});

async function assertUnavailableProvider(
  page: Page,
  workspace: Locator,
  routed: { readonly calls: readonly LanguageOperationCall[] },
): Promise<void> {
  await openTreeFile(workspace, PY_FILE);
  await expect(statusField(workspace, "language")).toHaveText("Python");
  await expect(statusField(workspace, "language")).toHaveAttribute(
    "aria-label",
    "Language: Python",
  );
  await expect(statusField(workspace, "language-service")).toHaveText("LSP unavailable");
  await expect(statusField(workspace, "language-service")).toHaveAttribute(
    "aria-label",
    "Language provider unavailable: Host Python provider is disabled by policy.",
  );
  await expect(statusField(workspace, "formatting")).toHaveText("Format unavailable");
  await expect(workspace.getByRole("button", { name: "Format", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await triggerFormat(workspace, true);
  await replaceMonacoText(page, workspace, "value = 2\n");
  await expect(statusField(workspace, "save")).toHaveText("Unsaved");
  await page.waitForTimeout(500);
  expect(callsFor(routed, PY_FILE)).toEqual([]);
  await expect(statusBar(workspace)).toHaveScreenshot("issue-1383-unavailable-provider.png", {
    maxDiffPixelRatio: 0.001,
  });
}

async function assertDegradedProvider(
  page: Page,
  workspace: Locator,
  routed: { readonly calls: readonly LanguageOperationCall[] },
): Promise<void> {
  await openTreeFile(workspace, LARGE_FILE);
  await expect(statusField(workspace, "language")).toHaveText("TypeScript");
  await expect(statusField(workspace, "large-file")).toHaveText("Large file mode");
  await expect(statusField(workspace, "large-file")).toHaveAttribute(
    "aria-label",
    "Large file mode: completions and analysis disabled",
  );
  await expect(statusField(workspace, "completions")).toHaveText("Completions off");
  await expect(statusField(workspace, "completions")).toHaveAttribute(
    "aria-label",
    "Governed completions unavailable for this file type",
  );
  await expect(statusField(workspace, "formatting")).toHaveText("Format unavailable");
  await expect(workspace.getByRole("button", { name: "Format", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await triggerFormat(workspace, true);
  await triggerSymbols(page, workspace);
  await expect(workspace.locator(".squiggly-error, .squiggly-warning")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(callsFor(routed, LARGE_FILE)).toEqual([]);
  await expect(statusBar(workspace)).toHaveScreenshot("issue-1383-degraded-large-file.png", {
    maxDiffPixelRatio: 0.001,
  });
}

test(`unavailable and degraded providers remain quiet, visible, and non-blocking ${TAG}`, async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);
  const routed = await routeLanguageIntelligence(page);
  const workspace = await openMatrixWorkspace(page);
  await expect.poll(() => callCount(routed, TS_FILE, "diagnostics")).toBeGreaterThan(0);

  await assertUnavailableProvider(page, workspace, routed);
  await attachShot(testInfo, page, "unavailable-provider-status.png");
  await assertDegradedProvider(page, workspace, routed);
  await attachShot(testInfo, page, "degraded-large-file-status.png");
  expect(errors).toEqual([]);
});
