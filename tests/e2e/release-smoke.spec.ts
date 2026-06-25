import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHAT_MODEL_ID = "e2e-chat-model";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const tempProjects: string[] = [];

interface ChatResponse {
  readonly chat: {
    readonly id: string;
    readonly title: string;
  };
}

function isBenignMonacoCancellation(error: Error): boolean {
  if (error.message === "Canceled: Canceled") return true;
  if (error.message !== "Canceled") return false;
  return /\b(monaco|inline[-\s]?completion|suggest|editor)\b/i.test(error.stack ?? "");
}

function collectPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    // Monaco can surface a benign cancellation as an unhandled page error when an inline-completion
    // request is superseded while the smoke test continues. Keep the guard strict for all real app
    // errors, but do not fail the release smoke on that editor-internal cancellation noise.
    if (isBenignMonacoCancellation(error)) return;
    errors.push(error.message);
  });
  return () => {
    expect(errors).toEqual([]);
  };
}

function createProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-project-"));
  tempProjects.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "packages", "keiko-cli", "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Keiko E2E fixture\n", "utf8");
  writeFileSync(
    join(root, "packages", "keiko-cli", "src", "run.ts"),
    "export const e2eFixture = true;\n",
    "utf8",
  );
  for (let index = 0; index < 17; index += 1) {
    const sourceIndex = String(index);
    writeFileSync(
      join(root, "docs", `source-${sourceIndex}.md`),
      `# Grounding source ${sourceIndex}\n`,
      "utf8",
    );
  }
  return root;
}

function fileScopes(projectPath: string, count: number): readonly Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    kind: "files",
    root: projectPath,
    relativePaths: [`docs/source-${String(index)}.md`],
    connectedAtMs: Date.now() + index,
  }));
}

async function ensureProject(request: APIRequestContext, projectPath: string): Promise<void> {
  const response = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: projectPath, name: "Keiko E2E" },
  });
  if (!response.ok()) {
    throw new Error(
      `Project setup failed (${String(response.status())}): ${await response.text()}`,
    );
  }
}

async function createGroundedChat(request: APIRequestContext): Promise<ChatResponse["chat"]> {
  const projectPath = createProjectFixture();
  await ensureProject(request, projectPath);
  const create = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: {
      projectPath,
      title: "E2E grounded chat",
      selectedModel: CHAT_MODEL_ID,
    },
  });
  expect(create.status()).toBe(201);
  const created = (await create.json()) as ChatResponse;

  const atLimit = await request.patch(`/api/chats?id=${encodeURIComponent(created.chat.id)}`, {
    headers: MUTATION_HEADERS,
    data: { connectedScopes: fileScopes(projectPath, 16) },
  });
  if (!atLimit.ok()) {
    throw new Error(
      `16-source setup failed (${String(atLimit.status())}): ${await atLimit.text()}`,
    );
  }

  const overLimit = await request.patch(`/api/chats?id=${encodeURIComponent(created.chat.id)}`, {
    headers: MUTATION_HEADERS,
    data: { connectedScopes: fileScopes(projectPath, 17) },
  });
  expect(overLimit.status()).toBe(400);

  const finalScope = await request.patch(`/api/chats?id=${encodeURIComponent(created.chat.id)}`, {
    headers: MUTATION_HEADERS,
    data: { connectedScopes: fileScopes(projectPath, 1) },
  });
  if (!finalScope.ok()) {
    throw new Error(
      `Final source setup failed (${String(finalScope.status())}): ${await finalScope.text()}`,
    );
  }

  return created.chat;
}

test.afterEach(() => {
  for (const root of tempProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function seedChatWindow(page: Page, chat: ChatResponse["chat"]): Promise<void> {
  await page.addInitScript(
    ({ chatId, title }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "e2e-chat-window",
            type: "chat",
            x: 96,
            y: 72,
            w: 760,
            h: 620,
            z: 10,
            cfg: { chatId, title },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { chatId: chat.id, title: chat.title },
  );
}

async function seedFilesWindow(page: Page, projectPath: string): Promise<void> {
  await page.addInitScript((root) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "e2e-files-window",
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
  }, projectPath);
}

async function openTreePath(
  filesWindow: ReturnType<Page["getByRole"]>,
  path: string,
): Promise<void> {
  const row = filesWindow.locator(`button.tr-row[data-path="${path}"]`);
  await expect(row).toBeVisible();
  await row.click();
}

async function replaceMonacoText(
  page: Page,
  editorWindow: ReturnType<Page["getByRole"]>,
  text: string,
): Promise<void> {
  const editor = editorWindow.locator(".monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.click();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(modifier);
  await page.keyboard.insertText(text);
}

async function stubInlineCompletionRoutes(page: Page): Promise<{
  readonly inlineRequests: unknown[];
  readonly telemetryReports: unknown[];
}> {
  const inlineRequests: unknown[] = [];
  const telemetryReports: unknown[] = [];
  await page.route("**/api/editor/inline-completion", async (route) => {
    inlineRequests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        items: [{ insertText: "urn 42;" }],
        provenance: {
          sources: ["model-assisted"],
          modelMode: "as-you-type",
          modelId: "e2e-inline-fim",
          latencyClass: "fast",
          gatewayPolicyVersion: "editor-inline-completion/1",
          promptHash: "a".repeat(64),
        },
      }),
    });
  });
  await page.route("**/api/editor/inline-completion/telemetry", async (route) => {
    telemetryReports.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  return { inlineRequests, telemetryReports };
}

async function openSmokeEditor(
  page: Page,
  projectPath: string,
  relativePath: string,
): Promise<ReturnType<Page["getByRole"]>> {
  await seedFilesWindow(page, projectPath);
  await page.goto("/");
  const filesWindow = page.getByRole("region", { name: /^Files/u });
  await openTreePath(filesWindow, "packages");
  await openTreePath(filesWindow, "packages/keiko-cli");
  await openTreePath(filesWindow, "packages/keiko-cli/src");
  await openTreePath(filesWindow, relativePath);
  await filesWindow.getByRole("button", { name: "Open in editor" }).click();
  const editorWindow = page.getByRole("region", {
    name: /Editor.*packages\/keiko-cli\/src\/run\.ts/u,
  });
  await expect(editorWindow.locator(".monaco-editor")).toBeVisible();
  await filesWindow.getByRole("button", { name: "Close Files window" }).click();
  await expect(filesWindow).toBeHidden();
  return editorWindow;
}

test("app start exposes the workspace shell and health endpoint @smoke", async ({
  page,
  request,
}) => {
  const assertNoPageErrors = collectPageErrors(page);

  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  await expect(health.json()).resolves.toMatchObject({ status: "ok" });

  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "Primary workspace navigation" }),
  ).toBeVisible();
  await expect(page.getByText("Keiko").first()).toBeVisible();
  await expect(page.locator(".header .hd-tool-cta")).toHaveCount(0);
  await expect(page.getByLabel(/Keiko version/u)).toBeVisible();

  assertNoPageErrors();
});

test("files editor opens, edits, saves, conflicts, reloads, and closes @smoke", async ({
  page,
}) => {
  const projectPath = createProjectFixture();
  const relativePath = "packages/keiko-cli/src/run.ts";
  const absolutePath = join(projectPath, relativePath);
  writeFileSync(absolutePath, "", "utf8");
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  await page.goto("/");
  const filesWindow = page.getByRole("region", { name: /^Files/u });
  await expect(filesWindow).toBeVisible();

  await openTreePath(filesWindow, "packages");
  await openTreePath(filesWindow, "packages/keiko-cli");
  await openTreePath(filesWindow, "packages/keiko-cli/src");
  await openTreePath(filesWindow, relativePath);
  await expect(filesWindow.getByRole("region", { name: "File preview: run.ts" })).toBeVisible();
  await filesWindow.getByRole("button", { name: "Open in editor" }).click();

  const editorWindow = page.getByRole("region", {
    name: /Editor.*packages\/keiko-cli\/src\/run\.ts/u,
  });
  await expect(editorWindow).toBeVisible();
  await filesWindow.getByRole("button", { name: "Close Files window" }).click();
  await expect(filesWindow).toBeHidden();
  await expect(editorWindow.locator(".monaco-editor")).toBeVisible();

  // Issue #1205: dirty/saved/conflict state is communicated by the unified status bar (the editor's
  // own footer is suppressed in the card). The save field is the visible indicator; a conflict also
  // fires the status bar's assertive alert region.
  const saveField = editorWindow.locator('[data-field="save"]');
  const savedText = "export const e2eFixture = 'saved in browser smoke';\n";
  await replaceMonacoText(page, editorWindow, savedText);
  await expect(saveField).toHaveText("Unsaved");
  await editorWindow.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => readFileSync(absolutePath, "utf8").replace(/\r\n/gu, "\n"))
    .toBe(savedText);
  await expect(saveField).toHaveText("Saved");

  const conflictDraft = "export const e2eFixture = 'conflicting browser draft';\n";
  await replaceMonacoText(page, editorWindow, conflictDraft);
  writeFileSync(absolutePath, "export const e2eFixture = 'external edit';\n", "utf8");
  await editorWindow.getByRole("button", { name: "Save" }).click();
  await expect(editorWindow.getByRole("alert")).toContainText("Save conflict");
  await expect(saveField).toHaveText("Conflict");

  await editorWindow.getByRole("button", { name: "Reload" }).click();
  await expect(saveField).toHaveText("Saved");
  await expect(editorWindow.getByText("external edit")).toBeVisible();

  await editorWindow.getByRole("button", { name: "Close Editor window" }).click();
  await expect(editorWindow).toBeHidden();
  assertNoPageErrors();
});

test("arbitrary folder opening keeps root-relative ids with clear error and empty states @smoke", async ({
  page,
}) => {
  // Issue #1374: opening an arbitrary developer workspace must keep every file identifier
  // ROOT-RELATIVE (never an absolute path that the BFF rejects with 400 BAD_PATH), support parent
  // navigation, and render clear non-blocking states for unavailable and empty roots without
  // breaking the app. The temp fixture stands in for a project root (the local worktree path itself
  // contains a deny-listed `.claude` segment, so it cannot be opened as a root).
  const projectPath = createProjectFixture();
  mkdirSync(join(projectPath, "empty-folder"), { recursive: true });
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  await page.goto("/");
  const filesWindow = page.getByRole("region", { name: /^Files/u });
  await expect(filesWindow).toBeVisible();

  // Opening the project root works and a nested package folder navigates without failure (AC1/AC2).
  await openTreePath(filesWindow, "packages");
  await openTreePath(filesWindow, "packages/keiko-cli");
  await expect(
    filesWindow.locator('button.tr-row[data-path="packages/keiko-cli/src"]'),
  ).toBeVisible();

  // AC2: every visible tree identifier is root-relative — none is an absolute machine path.
  const identifiers = await filesWindow
    .locator("button.tr-row")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-path") ?? ""));
  expect(identifiers.length).toBeGreaterThan(0);
  expect(
    identifiers.every(
      (id) =>
        id.length > 0 && !id.startsWith("/") && !/^[A-Za-z]:/u.test(id) && !id.includes(":\\"),
    ),
  ).toBe(true);

  // Parent navigation: stepping up from a nested folder lists the folder we came from.
  await filesWindow.getByRole("button", { name: "Open parent folder" }).click();
  await expect(filesWindow.locator('button.tr-row[data-path="packages/keiko-cli"]')).toBeVisible();

  // D3/AC4: an unavailable root renders a clear, non-blocking error and the app stays alive.
  const rootInput = filesWindow.getByRole("textbox", { name: /Folder path/u });
  await rootInput.fill(`${projectPath}/does-not-exist-1374`);
  await rootInput.press("Enter");
  await expect(filesWindow.getByRole("alert")).toBeVisible();

  // Recovery to an empty folder shows the clear empty state (no editor failure).
  await rootInput.fill(join(projectPath, "empty-folder"));
  await rootInput.press("Enter");
  await expect(filesWindow.getByText("Empty folder.")).toBeVisible();

  assertNoPageErrors();
});

test("editor presents the VS Code-feeling UX surface: status bar, tabs, cursor, command palette @smoke", async ({
  page,
}, testInfo) => {
  // Issue #1205: the browser interaction smoke for the VS Code-feeling UX — the unified status bar,
  // accessible tabs, live cursor reporting, and Monaco's native command palette carrying the Keiko
  // Generate Tests command — against the real app path (no mocks).
  const projectPath = createProjectFixture();
  const relativePath = "packages/keiko-cli/src/run.ts";
  writeFileSync(join(projectPath, relativePath), "", "utf8");
  const assertNoPageErrors = collectPageErrors(page);

  const editorWindow = await openSmokeEditor(page, projectPath, relativePath);

  // The unified status bar is the single status surface (Acceptance Criterion 3).
  const statusBar = editorWindow.getByTestId("editor-status-bar");
  await expect(statusBar).toBeVisible();
  await expect(statusBar.locator('[data-field="language"]')).toHaveText("TypeScript");
  await expect(statusBar.locator('[data-field="completions"]')).toHaveText("Completions on");

  // The document tab is an accessible tab driving the editor tabpanel.
  await expect(editorWindow.getByRole("tab", { name: /run\.ts/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(editorWindow.getByRole("tabpanel")).toBeVisible();

  // Typing updates the live cursor field; "const answer = 42;" is 18 chars → caret at column 19.
  await replaceMonacoText(page, editorWindow, "const answer = 42;");
  await expect(statusBar.locator('[data-field="cursor"]')).toHaveText("Ln 1, Col 19");

  // Command palette integration: F1 opens Monaco's native palette carrying the Keiko Generate Tests
  // command alongside the built-ins.
  await editorWindow.locator(".monaco-editor").first().click();
  await page.keyboard.press("F1");
  const palette = page.locator(".quick-input-widget");
  await expect(palette).toBeVisible();
  await page.keyboard.type("Generate Tests");
  await expect(palette.getByText("Generate Tests").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await testInfo.attach("editor-vscode-ux", {
    body: await editorWindow.screenshot(),
    contentType: "image/png",
  });

  await editorWindow.getByRole("button", { name: "Close Editor window" }).click();
  await expect(editorWindow).toBeHidden();
  assertNoPageErrors();
});

test("editor surfaces diagnostics and hover from the governed language service @smoke", async ({
  page,
}) => {
  // Issue #1201: the deterministic server language service drives Monaco markers (diagnostics) and the
  // hover widget (quick info) for a TS/JS buffer. This proves the end-to-end browser path: edit ->
  // governed BFF (/api/editor/language) -> Monaco surface, against the real app (no mocks). The first
  // analysis cold-starts the TypeScript language service (lib loading) under the dev bundler, so the
  // language-feature waits are given a generous budget beyond the global expect timeout.
  test.setTimeout(120_000);
  const projectPath = createProjectFixture();
  const relativePath = "packages/keiko-cli/src/run.ts";
  // Start from an empty buffer so the replaced content is exactly the analysed overlay.
  writeFileSync(join(projectPath, relativePath), "", "utf8");
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  await page.goto("/");
  const filesWindow = page.getByRole("region", { name: /^Files/u });
  await expect(filesWindow).toBeVisible();
  await openTreePath(filesWindow, "packages");
  await openTreePath(filesWindow, "packages/keiko-cli");
  await openTreePath(filesWindow, "packages/keiko-cli/src");
  await openTreePath(filesWindow, relativePath);
  await filesWindow.getByRole("button", { name: "Open in editor" }).click();

  const editorWindow = page.getByRole("region", {
    name: /Editor.*packages\/keiko-cli\/src\/run\.ts/u,
  });
  await expect(editorWindow).toBeVisible();
  await filesWindow.getByRole("button", { name: "Close Files window" }).click();
  await expect(editorWindow.locator(".monaco-editor")).toBeVisible();

  // A buffer with a deliberate type error on line 1 and a hoverable symbol used on line 2.
  await replaceMonacoText(page, editorWindow, "const greeting: string = 42;\ngreeting;\n");

  // Diagnostics: the type error must surface as a Monaco error squiggle (markers set by the bridge
  // after the governed BFF roundtrip + debounce).
  await expect
    .poll(() => editorWindow.locator(".squiggly-error").count(), { timeout: 60_000 })
    .toBeGreaterThan(0);

  // Hover: resting on the `greeting` identifier surfaces the governed quick-info widget. Monaco
  // renders the governed buffer without per-token spans, so hover by coordinate. Line 2 (`greeting;`)
  // has the identifier at column 0, so a small offset from the line start lands squarely on it.
  await page.mouse.move(0, 0);
  const usageLine = editorWindow.locator(".view-line", { hasText: "greeting;" });
  await expect(usageLine).toBeVisible();
  const box = await usageLine.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    // A small fixed offset from the line start lands on `greeting` (column 0, ~8 monospaced chars);
    // a proportional offset would overshoot, since a Monaco view-line box can span the content width.
    const target = { x: box.x + 24, y: box.y + box.height / 2 };
    // Two moves so Monaco's hover controller registers a fresh mousemove over the identifier.
    await page.mouse.move(target.x - 6, target.y);
    await page.mouse.move(target.x, target.y);
  }
  // Two hover widgets exist (content + glyph-margin); the content/quick-info widget is first in DOM.
  const hover = page.locator(".monaco-hover").first();
  await expect(hover).toBeVisible({ timeout: 30_000 });
  await expect(hover).toContainText("greeting");

  await editorWindow.getByRole("button", { name: "Close Editor window" }).click();
  await expect(editorWindow).toBeHidden();
  assertNoPageErrors();
});

test("editor inline ghost text renders and Tab accepts it @smoke", async ({ page }) => {
  const projectPath = createProjectFixture();
  const relativePath = "packages/keiko-cli/src/run.ts";
  const absolutePath = join(projectPath, relativePath);
  writeFileSync(absolutePath, "", "utf8");
  const { inlineRequests, telemetryReports } = await stubInlineCompletionRoutes(page);
  const assertNoPageErrors = collectPageErrors(page);

  const editorWindow = await openSmokeEditor(page, projectPath, relativePath);
  await replaceMonacoText(page, editorWindow, "export function answer() {\n  ret");
  await expect.poll(() => inlineRequests.length).toBeGreaterThan(0);
  await expect(page.getByRole("alert").filter({ hasText: "urn 42;" }).first()).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(editorWindow.getByText("return 42;")).toBeVisible();
  await expect
    .poll(() =>
      telemetryReports.some((report) => {
        const accepted = (report as { readonly accepted?: unknown }).accepted;
        return typeof accepted === "number" && accepted > 0;
      }),
    )
    .toBe(true);
  await editorWindow.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => readFileSync(absolutePath, "utf8").replace(/\r\n/gu, "\n"))
    .toContain("return 42;");

  assertNoPageErrors();
});

test("chat window renders a bound Files grounding source and enforces the 16-source cap @smoke", async ({
  page,
  request,
}) => {
  const chat = await createGroundedChat(request);
  await seedChatWindow(page, chat);
  const assertNoPageErrors = collectPageErrors(page);

  const config = await request.get("/api/config");
  expect(config.ok()).toBe(true);
  await expect(config.json()).resolves.toMatchObject({
    effectiveGroundingLimits: { maxConnectedSources: 16 },
  });

  await page.goto("/");
  const chatWindow = page.getByRole("region", { name: "Chat — E2E grounded chat" });
  await expect(chatWindow).toBeVisible();
  const grounding = chatWindow.getByLabel("Grounding mode");
  await expect(grounding).toBeVisible();
  await expect(grounding).toContainText("Live Files context");
  await grounding.click();
  const liveFilesOption = page.getByRole("option", { name: "Live Files context" });
  await expect(liveFilesOption).toHaveAttribute("aria-selected", "true");
  await expect(chatWindow.getByRole("textbox", { name: "Chat message" })).toBeVisible();

  assertNoPageErrors();
});

test("memory and local-knowledge navigation surfaces load without client errors @smoke", async ({
  page,
}) => {
  const assertNoPageErrors = collectPageErrors(page);

  await page.goto("/");
  await page.getByRole("button", { name: "MemoriaViva" }).click();
  const memoriaWindow = page.getByRole("region", { name: "MemoriaViva" });
  await expect(memoriaWindow.getByRole("heading", { name: "MemoriaViva" })).toBeVisible();
  await page.getByRole("button", { name: "Review queue" }).click();
  await expect(memoriaWindow.getByRole("heading", { name: "Review queue" })).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: "Local Knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Local Knowledge Connector" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a new knowledge capsule" })).toBeVisible();

  assertNoPageErrors();
});
