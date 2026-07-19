import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";
import { cleanupEditorWorkspaces, createEditorWorkspace } from "./support/editorWorkspace.js";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const SETTINGS_SELECTOR = '.window[data-window-id="issue-2282-settings"]';
const LANGUAGES = ["Python", "Go", "Shell", "Java", "Rust"] as const;

type ConfigurableLanguage = "python" | "go";
type ConfigurableLabel = "Python" | "Go";

interface SettingsSnapshot {
  readonly revision: number;
  readonly etag: string;
}

let idempotencySequence = 0;

test.afterAll(() => {
  cleanupEditorWorkspaces();
});

async function registerProject(request: APIRequestContext, root: string): Promise<void> {
  const response = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name: "Managed language closeout #2282" },
  });
  expect(response.status()).toBe(201);
}

async function seedSettingsWindow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("keiko.theme", "dark");
    window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-2282-settings",
          type: "settings",
          x: 24,
          y: 24,
          w: 1320,
          h: 980,
          z: 10,
          cfg: {},
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  });
}

async function openLanguages(page: Page): Promise<Locator> {
  await page.goto("/");
  const settings = page.locator(SETTINGS_SELECTOR);
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Languages" }).click();
  await expect(settings.getByRole("heading", { name: "Language intelligence" })).toBeVisible();
  return settings;
}

function providerCard(settings: Locator, label: ConfigurableLabel): Locator {
  return settings.getByRole("article", { name: label });
}

async function expectProviderState(
  card: Locator,
  state: "active" | "available" | "disabled" | "restartRequired",
  label: string,
): Promise<void> {
  const output = card.locator(`output[data-state="${state}"]`);
  await expect(output).toBeVisible();
  await expect(output).toContainText(label);
}

async function assertDefaultOff(settings: Locator): Promise<void> {
  await expect(settings.getByRole("article")).toHaveCount(5);
  for (const label of LANGUAGES) {
    const card = settings.getByRole("article", { name: label });
    await expect(card).toBeVisible();
    await expectProviderState(card, "disabled", "Disabled");
  }
}

async function warmCapabilities(request: APIRequestContext, root: string): Promise<void> {
  const response = await request.get("/api/editor/language/capabilities", { params: { root } });
  expect(response.status()).toBe(200);
}

async function activateProvider(
  page: Page,
  request: APIRequestContext,
  settings: Locator,
  root: string,
  label: ConfigurableLabel,
): Promise<Locator> {
  const enable = providerCard(settings, label).getByRole("button", { name: `Enable ${label}` });
  await enable.focus();
  await expect(enable).toBeFocused();
  await page.keyboard.press("Enter");
  await expectProviderState(providerCard(settings, label), "available", "Available");
  await warmCapabilities(request, root);
  const refreshed = await openLanguages(page);
  const card = providerCard(refreshed, label);
  await expectProviderState(card, "active", "Active");
  await expect(card.getByText(/READY;.*successful requests/)).toBeVisible();
  await expect(card.getByTestId("managed-lsp-capability").first()).toBeVisible();
  return refreshed;
}

async function executeOperation(
  request: APIRequestContext,
  root: string,
  languageId: ConfigurableLanguage,
  operation: "diagnostics" | "definition",
): Promise<void> {
  const isPython = languageId === "python";
  const response = await request.post("/api/editor/language", {
    headers: MUTATION_HEADERS,
    data: {
      operation,
      root,
      document: {
        path: isPython ? "main.py" : "main.go",
        languageId,
        text: isPython ? "managed_value = missing_symbol\n" : "package main\nfunc main() {}\n",
      },
      ...(operation === "definition" ? { position: { line: 1, character: 5 } } : {}),
    },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ operation });
}

async function settingsSnapshot(
  request: APIRequestContext,
  root: string,
): Promise<SettingsSnapshot> {
  const response = await request.get("/api/editor/lsp/settings", { params: { root } });
  expect(response.status()).toBe(200);
  return (await response.json()) as SettingsSnapshot;
}

async function mutateSettings(
  request: APIRequestContext,
  root: string,
  language: ConfigurableLanguage,
  action: "rollback",
): Promise<void> {
  const snapshot = await settingsSnapshot(request, root);
  idempotencySequence += 1;
  const response = await request.put("/api/editor/lsp/settings", {
    headers: {
      ...MUTATION_HEADERS,
      "If-Match": snapshot.etag,
      "Idempotency-Key": `issue-2282-${String(idempotencySequence)}`,
    },
    data: {
      root,
      language,
      action,
      expectedRevision: snapshot.revision,
    },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function acceptInitialConfiguration(
  page: Page,
  request: APIRequestContext,
  settings: Locator,
  root: string,
  label: ConfigurableLabel,
): Promise<Locator> {
  const card = providerCard(settings, label);
  const save = card.getByRole("button", { name: "Save settings" });
  await expect(save).toBeEnabled();
  await save.click();
  await expectProviderState(card, "restartRequired", "Restart required");
  await expect(card.getByText(/Restart impact:.*runtime.*settings/u)).toBeVisible();
  return restartThroughSettings(page, request, settings, root, label);
}

async function configureAndRestart(
  page: Page,
  request: APIRequestContext,
  settings: Locator,
  root: string,
  label: ConfigurableLabel,
): Promise<Locator> {
  const card = providerCard(settings, label);
  if (label === "Python") {
    await card.getByLabel("Type-checking mode").selectOption("strict");
  } else {
    await card.getByRole("checkbox", { name: "Enable static analysis" }).check();
  }
  await card.getByRole("button", { name: "Save settings" }).click();
  await expect(card.getByText(/Restart impact:.*settings/u)).toBeVisible();
  return restartThroughSettings(page, request, settings, root, label);
}

async function restartThroughSettings(
  page: Page,
  request: APIRequestContext,
  settings: Locator,
  root: string,
  label: ConfigurableLabel,
): Promise<Locator> {
  const card = providerCard(settings, label);
  await card.getByRole("button", { name: `Restart ${label}` }).click();
  await settings.getByRole("alertdialog").getByRole("button", { name: "Confirm restart" }).click();
  await expectProviderState(card, "available", "Available");
  await warmCapabilities(request, root);
  const refreshed = await openLanguages(page);
  await expectProviderState(providerCard(refreshed, label), "active", "Active");
  return refreshed;
}

async function configureRollbackAndRestart(
  page: Page,
  request: APIRequestContext,
  settings: Locator,
  root: string,
): Promise<Locator> {
  const python = providerCard(settings, "Python");
  await python.getByLabel("Type-checking mode").selectOption("strict");
  await python.getByRole("button", { name: "Save settings" }).click();
  await expect(python.getByText(/Restart impact:.*settings/u)).toBeVisible();
  await mutateSettings(request, root, "python", "rollback");
  const rolledBack = await openLanguages(page);
  await expect(providerCard(rolledBack, "Python").getByLabel("Type-checking mode")).toHaveValue(
    "standard",
  );
  return restartThroughSettings(page, request, rolledBack, root, "Python");
}

async function assertSemanticFallback(request: APIRequestContext, root: string): Promise<void> {
  const response = await request.post("/api/editor/language/semantic-tokens", {
    headers: MUTATION_HEADERS,
    data: {
      schemaVersion: "1",
      root,
      document: { path: "lib.rs", languageId: "rust", text: "fn main() {}\n", version: 1 },
    },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ schemaVersion: "1", supported: false });
}

async function disableProvider(
  page: Page,
  request: APIRequestContext,
  settings: Locator,
  root: string,
  label: ConfigurableLabel,
  languageId: ConfigurableLanguage,
): Promise<void> {
  const disable = providerCard(settings, label).getByRole("button", { name: `Disable ${label}` });
  await disable.focus();
  await page.keyboard.press("Enter");
  const confirm = settings.getByRole("alertdialog").getByRole("button", {
    name: "Confirm disable",
  });
  await confirm.click();
  await expectProviderState(providerCard(settings, label), "disabled", "Disabled");
  const response = await request.post("/api/editor/language", {
    headers: MUTATION_HEADERS,
    data: {
      operation: "diagnostics",
      root,
      document: { path: label === "Python" ? "main.py" : "main.go", languageId, text: "value\n" },
    },
  });
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_LANGUAGE" } });
}

async function assertBrowserA11y(page: Page): Promise<void> {
  const violations = seriousOrCritical(await runAxe(page, SETTINGS_SELECTOR));
  expect(violations.length, formatViolations(violations)).toBe(0);
}

async function attachVisualEvidence(settings: Locator, testInfo: TestInfo): Promise<void> {
  const path = testInfo.outputPath("managed-language-closeout-active.png");
  await settings.screenshot({ animations: "disabled", path });
  await testInfo.attach("managed-language-closeout-active.png", {
    path,
    contentType: "image/png",
  });
}

test("Settings drives the governed Python and Go lifecycle through the real BFF", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const workspace = createEditorWorkspace([
    { path: "main.py", content: "managed_value = missing_symbol\n" },
    { path: "main.go", content: "package main\nfunc main() {}\n" },
    { path: "lib.rs", content: "fn main() {}\n" },
  ]);
  await registerProject(request, workspace.root);
  await seedSettingsWindow(page);
  let settings = await openLanguages(page);
  await assertDefaultOff(settings);
  await assertBrowserA11y(page);
  settings = await activateProvider(page, request, settings, workspace.root, "Python");
  settings = await acceptInitialConfiguration(page, request, settings, workspace.root, "Python");
  settings = await activateProvider(page, request, settings, workspace.root, "Go");
  settings = await acceptInitialConfiguration(page, request, settings, workspace.root, "Go");
  await executeOperation(request, workspace.root, "python", "diagnostics");
  await executeOperation(request, workspace.root, "go", "definition");
  settings = await configureRollbackAndRestart(page, request, settings, workspace.root);
  settings = await configureAndRestart(page, request, settings, workspace.root, "Go");
  await assertSemanticFallback(request, workspace.root);
  await assertBrowserA11y(page);
  await attachVisualEvidence(settings, testInfo);
  await disableProvider(page, request, settings, workspace.root, "Python", "python");
  await disableProvider(page, request, settings, workspace.root, "Go", "go");
  expect(errors).toEqual([]);
});
