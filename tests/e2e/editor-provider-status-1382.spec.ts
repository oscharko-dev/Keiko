import { expect, test, type Page } from "@playwright/test";

import {
  cleanupEditorWorkspaces,
  createEditorWorkspace,
  EDITOR_SELECTORS,
  openEditorWorkspace,
  openTreeFile,
  seedEditorWindow,
} from "./support/editorWorkspace.js";

const TAG = "@provider-status-1382";
const HOST_PROVIDER_CAPABILITIES = {
  schemaVersion: "1",
  providers: [
    {
      id: "go-lsp",
      languages: ["go"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "available",
    },
    {
      id: "shell-lsp",
      languages: ["shell"],
      operations: ["diagnostics", "completion", "hover", "symbols"],
      availability: "unavailable",
      unavailableReason: "Required host language tool is blocked by host execution policy.",
    },
  ],
} as const;

test.afterAll(() => {
  cleanupEditorWorkspaces();
});

async function routeCapabilities(page: Page, roots: string[]): Promise<void> {
  await page.route("**/api/editor/language/capabilities**", async (route) => {
    roots.push(new URL(route.request().url()).searchParams.get("root") ?? "");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(HOST_PROVIDER_CAPABILITIES),
    });
  });
}

test(`host provider status renders available and unavailable paths ${TAG}`, async ({ page }) => {
  const { root } = createEditorWorkspace([
    { path: "main.go", content: "package main\nfunc main() {}\n" },
    { path: "script.sh", content: "#!/usr/bin/env bash\necho ok\n" },
  ]);
  const capabilityRoots: string[] = [];
  await routeCapabilities(page, capabilityRoots);
  await seedEditorWindow(page, { root, openFiles: ["main.go"], active: "main.go" });

  await page.goto("/");
  const workspace = await openEditorWorkspace(page);
  const statusBar = workspace.locator(EDITOR_SELECTORS.statusBar).first();
  const languageService = statusBar.locator('[data-field="language-service"]');

  await expect(languageService).toHaveText("go-lsp ready");
  await expect(languageService).toHaveAttribute(
    "aria-label",
    "Language provider available: go-lsp",
  );
  await expect
    .poll(() => capabilityRoots.includes(root), {
      message: "capabilities fetched with workspace root",
    })
    .toBe(true);

  await openTreeFile(workspace, "script.sh");
  await expect(languageService).toHaveText("LSP unavailable");
  await expect(languageService).toHaveAttribute(
    "aria-label",
    "Language provider unavailable: Required host language tool is blocked by host execution policy.",
  );
});
