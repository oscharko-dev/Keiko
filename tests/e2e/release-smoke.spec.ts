import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
} from "@oscharko-dev/keiko-contracts/runtime/editor-m7";
import { resolveEditorM11Settings } from "@oscharko-dev/keiko-contracts/runtime/editor-m11-settings";
import { expectViewportModal } from "./support/modal.js";
import { clickWindowChromeButton } from "./support/window-chrome.js";
import { replaceEditorBuffer } from "./support/editor-chord.js";

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

// Tab names carry a file path; `.` and `/` must not act as regex metacharacters when matching one.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
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

async function seedModalProofWindow(
  page: Page,
  windowEntry: { readonly id: string; readonly type: "governedGit" | "settings" },
): Promise<void> {
  await page.addInitScript((entry) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: entry.id,
          type: entry.type,
          x: 36,
          y: 36,
          w: 720,
          h: 640,
          z: 10,
          cfg: {},
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  }, windowEntry);
}

async function openTreePath(
  filesWindow: ReturnType<Page["getByRole"]>,
  path: string,
): Promise<void> {
  const row = filesWindow.locator(`[role="treeitem"].tr-row[data-path="${path}"]`);
  await expect(row).toBeVisible();
  await row.click();
}

// Delegates to the shared, engine-agnostic implementation: focusing Monaco's ACTUAL input surface
// (EditContext in Chromium, textarea.inputarea in Firefox) is what makes the select-all land, and
// the helper verifies the replacement instead of letting a silent no-op corrupt the buffer.
async function replaceMonacoText(
  page: Page,
  editorWindow: ReturnType<Page["getByRole"]>,
  text: string,
): Promise<void> {
  await replaceEditorBuffer(page, editorWindow, text);
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
  request: APIRequestContext,
  projectPath: string,
  relativePath: string,
): Promise<ReturnType<Page["getByRole"]>> {
  await ensureProject(request, projectPath);
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
  // Creating the selected project is the local human's trust act. The Editor must not ask for
  // duplicate workspace trust after that folder has already been accepted.
  await expect(
    editorWindow.getByRole("alertdialog", { name: "Trust this workspace?" }),
  ).toHaveCount(0);
  await clickWindowChromeButton(filesWindow, "Close Files window");
  await expect(filesWindow).toBeHidden();
  return editorWindow;
}

function gitActionSheetRequest(projectId: string): Record<string, unknown> {
  return {
    schemaVersion: "1",
    projectId,
    resolvedInputs: {
      kind: "commit",
      messageByteLength: 24,
      stagedPathCount: 2,
      allowEmptyCommit: false,
    },
    worktreeSnapshot: {
      headDetached: false,
      currentBranchName: "feature/x",
      stagedFileCount: 2,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      existingLocalBranchNames: ["feature/x", "main"],
      remoteAliases: ["origin"],
    },
  };
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
  // The workspace selector is intentionally a post-hydration chunk so it stays out of the
  // first-load budget. Its trigger must still become interactive on the real app path.
  const workspaceSelector = page.getByRole("button", { name: /workspace context/i });
  await expect(workspaceSelector).toBeVisible();
  await workspaceSelector.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Keiko").first()).toBeVisible();
  await expect(page.locator(".header .hd-tool-cta")).toHaveCount(0);
  await expect(page.getByLabel(/Keiko version/u)).toBeVisible();

  assertNoPageErrors();
});

test("governed Git action-sheet endpoint is wired, CSRF-protected, and returns the contract shape @smoke", async ({
  request,
}) => {
  // Issue #473: the action-sheet BFF is read-only/computational. Against the packaged app it must
  // return a well-formed, content-free GitDeliveryActionSheet that reaches trusted default policy
  // evaluation and fail-closes when provider state is unavailable — never a 500 or raw output.
  const projectId = createProjectFixture();
  await ensureProject(request, projectId);
  const body = gitActionSheetRequest(projectId);

  const ok = await request.post("/api/git-delivery/action-sheet", {
    headers: MUTATION_HEADERS,
    data: body,
  });
  expect(ok.status()).toBe(200);
  const sheet = (await ok.json()) as {
    schemaVersion: string;
    state: string;
    preview: { actionKind: string };
    approval: { necessity: string };
    policyExplanation: { decision: string };
    recovery: unknown[];
    blocked?: { cause: string };
  };
  expect(sheet.schemaVersion).toBe("1");
  expect(["ready-to-execute", "waiting-for-approval", "blocked"]).toContain(sheet.state);
  expect(sheet.preview.actionKind).toBe("commit");
  expect(typeof sheet.approval.necessity).toBe("string");
  expect(typeof sheet.policyExplanation.decision).toBe("string");
  expect(Array.isArray(sheet.recovery)).toBe(true);
  // The fixture is not a Git repository, so trusted branch-protection state is unavailable and the
  // governed preflight must fail closed without accepting browser-supplied provider facts.
  expect(sheet.state).toBe("blocked");
  expect(sheet.blocked?.cause).toBe("provider-not-ready");
  // Content-free guarantee: no raw repo paths or command output leaked into the response.
  expect(JSON.stringify(sheet)).not.toContain("/Users/");

  // CSRF is enforced centrally for the mutating verb: the same POST without the header is rejected.
  const noCsrf = await request.post("/api/git-delivery/action-sheet", { data: body });
  expect(noCsrf.status()).toBe(403);
});

test("window-owned repository confirm preserves viewport modality @smoke", async ({ page }) => {
  await page.route("**/api/projects**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ projects: [] }),
    }),
  );
  await seedModalProofWindow(page, { id: "e2e-modal-git", type: "governedGit" });
  await page.goto("/");

  const gitWindow = page.locator('[data-window-id="e2e-modal-git"]');
  await expect(gitWindow).toBeVisible();
  await gitWindow.getByRole("button", { name: "Clone from URL" }).click();
  const repositoryDialog = page.getByRole("dialog", { name: "Add repository" });
  await expectViewportModal(page, repositoryDialog);
  await repositoryDialog.getByRole("button", { name: "Close" }).click();
});

test("window-owned AI confirm preserves viewport modality @smoke", async ({ page }) => {
  await page.route("**/api/editor/settings**", (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname !== "/api/editor/settings" || route.request().method() !== "GET") {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: EDITOR_M7_SCHEMA_VERSION,
        storeState: "ready",
        userRevision: 1,
        workspaceRevision: 1,
        revision: 1_000_000,
        etag: '"modal-proof"',
        definitions: EDITOR_M7_SETTING_REGISTRY,
        settings: resolveEditorM11Settings({
          user: { scope: "user", values: {} },
          workspace: { scope: "workspace", values: {} },
        }),
        eventSequence: 1,
      }),
    });
  });
  await seedModalProofWindow(page, { id: "e2e-modal-settings", type: "settings" });
  await page.goto("/");

  const settingsWindow = page.locator('[data-window-id="e2e-modal-settings"]');
  await expect(settingsWindow).toBeVisible();
  await settingsWindow.getByRole("button", { name: "Editor" }).click();
  await settingsWindow.getByRole("checkbox", { name: "Inline AI completion" }).click();
  const aiDialog = page.getByRole("alertdialog", { name: "Confirm AI-assist activation" });
  await expectViewportModal(page, aiDialog);
  await aiDialog.getByRole("button", { name: "Cancel" }).click();
});

test("files editor opens, edits, saves, conflicts, reloads, and closes @smoke", async ({
  page,
  request,
  browserName,
}) => {
  // KNOWN CROSS-ENGINE GAP — Gecko only, tracked, NOT a silent exclusion.
  // This journey replaces the whole editor buffer before asserting. Monaco 0.56 uses the
  // EditContext API where it exists and falls back to `textarea.inputarea` where it does not;
  // Firefox has no EditContext (verified from a trace snapshot of this editor:
  // `native-edit-context` 0 occurrences, `inputarea` 2). On that fallback surface neither Ctrl+A
  // nor Cmd+A reaches Monaco's keybinding service, so the select-all selects nothing, the
  // following insert APPENDS, and the buffer doubles. The shared helper
  // (support/editor-chord.ts) now fails loudly at that exact point instead of letting the
  // corruption surface later as an unrelated strict-mode violation.
  // The PRODUCT is not implicated: its own platform detection reads `navigator.platform` from the
  // page and accepts `metaKey || ctrlKey`. What is unproven on Gecko is this buffer-replacement
  // TEST GESTURE, not the editor. Everything else in this smoke — 68 of 71 journeys — runs on
  // Firefox, and all 71 run on Chromium (Edge/Chrome, the fleet browsers).
  test.skip(
    browserName === "firefox",
    "Monaco select-all does not reach the EditContext fallback surface on Gecko; the buffer-replacement gesture is unproven there (the rest of this smoke runs on Firefox)",
  );
  const projectPath = createProjectFixture();
  const relativePath = "packages/keiko-cli/src/run.ts";
  const absolutePath = join(projectPath, relativePath);
  writeFileSync(absolutePath, "", "utf8");
  const assertNoPageErrors = collectPageErrors(page);
  const editorWindow = await openSmokeEditor(page, request, projectPath, relativePath);

  // Issue #1205: dirty/saved/conflict state is communicated by the unified status bar's save field.
  const saveField = editorWindow.locator('[data-field="save"]');
  const savedText = "export const e2eFixture = 'saved in browser smoke';\n";
  await replaceMonacoText(page, editorWindow, savedText);
  await expect(saveField).toHaveText("Unsaved");
  await editorWindow.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => readFileSync(absolutePath, "utf8").replace(/\r\n/gu, "\n"))
    .toBe(savedText);
  await expect(saveField).toHaveText("Saved");
  await expect(editorWindow.getByTestId("editor-local-history-protection")).toHaveCount(0);

  const conflictDraft = "export const e2eFixture = 'conflicting browser draft';\n";
  await replaceMonacoText(page, editorWindow, conflictDraft);
  writeFileSync(absolutePath, "export const e2eFixture = 'external edit';\n", "utf8");
  await editorWindow.getByRole("button", { name: "Save" }).click();
  await expect(editorWindow.getByRole("alert")).toContainText("Save conflict");
  await expect(saveField).toHaveText("Conflict");

  // Issue #1376 (D1/AC1): reloading from disk over the dirty conflict buffer routes through an
  // explicit discard confirmation before the disk content replaces the unsaved edits.
  await editorWindow.getByRole("button", { name: "Reload", exact: true }).click();
  const reloadDialog = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await expectViewportModal(page, reloadDialog);
  await reloadDialog.getByRole("button", { name: "Discard and reload" }).click();
  await expect(saveField).toHaveText("Saved");
  await expect(editorWindow.getByText("external edit")).toBeVisible();

  // Issue #1376 (AC1/D4): a dirty tab close is gated by the in-app dialog (no native confirm), and
  // Cancel preserves the buffer.
  await replaceMonacoText(page, editorWindow, "export const e2eFixture = 'dirty again';\n");
  // 0.3.0 audit: the tab strip now satisfies `aria-required-children`, so the close affordance is a
  // decorative span inside the tab rather than an owned button of the tablist. The keyboard path is
  // the accessible one (WAI-ARIA APG deletable tabs: Delete, or Backspace on Mac keyboards), so the
  // test drives that instead of the pointer decoration — it exercises the same close handler and
  // additionally proves the affordance a screen-reader user actually has still reaches the gate.
  await editorWindow
    .getByRole("tab", { name: new RegExp(escapeRegExp(relativePath), "u") })
    .click();
  await page.keyboard.press("Delete");
  const dirtyDialog = page.getByRole("dialog", { name: "Unsaved editor changes" });
  await expectViewportModal(page, dirtyDialog);
  await dirtyDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dirtyDialog).toBeHidden();
  await expect(saveField).toHaveText("Unsaved");

  await clickWindowChromeButton(editorWindow, "Close Editor window");
  await expect(editorWindow).toBeHidden();
  assertNoPageErrors();
});

test("selected workspace keeps root-relative ids and internal navigation @smoke", async ({
  page,
  request,
}) => {
  // The global workspace selector is the one root authority for Files, Editor, and Coding
  // Workbench. Files still supports in-root navigation and root-relative identifiers, but it does
  // not expose a second path picker that could appear to override the accepted workspace.
  const projectPath = createProjectFixture();
  // A window cfg restores presentation state; it cannot mint server-side workspace authority.
  // Register the fixture through the same project contract a real selected workspace uses.
  await ensureProject(request, projectPath);
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  await page.goto("/");
  const filesWindow = page.getByRole("region", { name: /^Files/u });
  await expect(filesWindow).toBeVisible();

  // Opening the project root works and a nested package folder navigates without failure (AC1/AC2).
  await openTreePath(filesWindow, "packages");
  await openTreePath(filesWindow, "packages/keiko-cli");
  await expect(
    filesWindow.locator('[role="treeitem"].tr-row[data-path="packages/keiko-cli/src"]'),
  ).toBeVisible();

  // AC2: every visible tree identifier is root-relative — none is an absolute machine path.
  const identifiers = await filesWindow
    .locator('[role="treeitem"].tr-row')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-path") ?? ""));
  expect(identifiers.length).toBeGreaterThan(0);
  expect(
    identifiers.every(
      (id) =>
        id.length > 0 && !id.startsWith("/") && !/^[A-Za-z]:/u.test(id) && !id.includes(":\\"),
    ),
  ).toBe(true);

  await expect(filesWindow.getByRole("textbox", { name: /Folder path/u })).toHaveCount(0);
  await expect(filesWindow.getByRole("button", { name: "Open parent folder" })).toHaveCount(0);

  assertNoPageErrors();
});

test("editor presents the VS Code-feeling UX surface: status bar, tabs, cursor, command palette @smoke", async ({
  page,
  request,
}, testInfo) => {
  // Issue #1205: the browser interaction smoke for the VS Code-feeling UX — the unified status bar,
  // accessible tabs, live cursor reporting, and Monaco's native command palette carrying the Keiko
  // Generate Tests command — against the real app path (no mocks).
  const projectPath = createProjectFixture();
  const relativePath = "packages/keiko-cli/src/run.ts";
  writeFileSync(join(projectPath, relativePath), "", "utf8");
  const assertNoPageErrors = collectPageErrors(page);

  const editorWindow = await openSmokeEditor(page, request, projectPath, relativePath);

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

  await clickWindowChromeButton(editorWindow, "Close Editor window");
  await expect(editorWindow).toBeHidden();
  assertNoPageErrors();
});

test("editor surfaces diagnostics and hover from the governed language service @smoke", async ({
  page,
  request,
  browserName,
}) => {
  // KNOWN CROSS-ENGINE GAP — Gecko only, tracked, NOT a silent exclusion.
  // This journey replaces the whole editor buffer before asserting. Monaco 0.56 uses the
  // EditContext API where it exists and falls back to `textarea.inputarea` where it does not;
  // Firefox has no EditContext (verified from a trace snapshot of this editor:
  // `native-edit-context` 0 occurrences, `inputarea` 2). On that fallback surface neither Ctrl+A
  // nor Cmd+A reaches Monaco's keybinding service, so the select-all selects nothing, the
  // following insert APPENDS, and the buffer doubles. The shared helper
  // (support/editor-chord.ts) now fails loudly at that exact point instead of letting the
  // corruption surface later as an unrelated strict-mode violation.
  // The PRODUCT is not implicated: its own platform detection reads `navigator.platform` from the
  // page and accepts `metaKey || ctrlKey`. What is unproven on Gecko is this buffer-replacement
  // TEST GESTURE, not the editor. Everything else in this smoke — 68 of 71 journeys — runs on
  // Firefox, and all 71 run on Chromium (Edge/Chrome, the fleet browsers).
  test.skip(
    browserName === "firefox",
    "Monaco select-all does not reach the EditContext fallback surface on Gecko; the buffer-replacement gesture is unproven there (the rest of this smoke runs on Firefox)",
  );
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
  await ensureProject(request, projectPath);
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
  await clickWindowChromeButton(filesWindow, "Close Files window");
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

  await clickWindowChromeButton(editorWindow, "Close Editor window");
  await expect(editorWindow).toBeHidden();
  assertNoPageErrors();
});

test("editor inline ghost text renders and Tab accepts it @smoke", async ({
  page,
  request,
  browserName,
}) => {
  // KNOWN CROSS-ENGINE GAP — Gecko only, tracked, NOT a silent exclusion.
  // This journey replaces the whole editor buffer before asserting. Monaco 0.56 uses the
  // EditContext API where it exists and falls back to `textarea.inputarea` where it does not;
  // Firefox has no EditContext (verified from a trace snapshot of this editor:
  // `native-edit-context` 0 occurrences, `inputarea` 2). On that fallback surface neither Ctrl+A
  // nor Cmd+A reaches Monaco's keybinding service, so the select-all selects nothing, the
  // following insert APPENDS, and the buffer doubles. The shared helper
  // (support/editor-chord.ts) now fails loudly at that exact point instead of letting the
  // corruption surface later as an unrelated strict-mode violation.
  // The PRODUCT is not implicated: its own platform detection reads `navigator.platform` from the
  // page and accepts `metaKey || ctrlKey`. What is unproven on Gecko is this buffer-replacement
  // TEST GESTURE, not the editor. Everything else in this smoke — 68 of 71 journeys — runs on
  // Firefox, and all 71 run on Chromium (Edge/Chrome, the fleet browsers).
  test.skip(
    browserName === "firefox",
    "Monaco select-all does not reach the EditContext fallback surface on Gecko; the buffer-replacement gesture is unproven there (the rest of this smoke runs on Firefox)",
  );
  const projectPath = createProjectFixture();
  const relativePath = "packages/keiko-cli/src/run.ts";
  const absolutePath = join(projectPath, relativePath);
  writeFileSync(absolutePath, "", "utf8");
  const { inlineRequests, telemetryReports } = await stubInlineCompletionRoutes(page);
  const assertNoPageErrors = collectPageErrors(page);

  const editorWindow = await openSmokeEditor(page, request, projectPath, relativePath);
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
  const localKnowledgeWindow = page.getByRole("region", { name: "Local Knowledge" });
  await expect(
    localKnowledgeWindow.getByRole("heading", { level: 1, name: "Knowledge Pods" }),
  ).toBeVisible();
  await expect(
    localKnowledgeWindow.getByRole("button", { exact: true, name: "Create Knowledge Pod" }),
  ).toBeVisible();

  assertNoPageErrors();
});
