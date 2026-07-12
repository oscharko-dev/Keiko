import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
  type TestInfo,
} from "@playwright/test";
import { readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

import {
  cleanupEditorWorkspaces,
  collectPageErrors,
  createEditorWorkspace,
  openEditorWorkspace,
} from "./support/editorWorkspace.js";

const CHAT_MODEL_ID = "e2e-chat-model";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const CHAT_TITLE = "E2E editor chat roundtrip";
const EDITOR_WINDOW_ID = "editor-chat-roundtrip-2119";
const CHAT_WINDOW_ID = "chat";
const RELATIVE_PATH = "src/roundtrip.ts";
const BEFORE_SENTINEL = "BEFORE_SENTINEL_2119";
const AFTER_SENTINEL = "AFTER_SENTINEL_2119";
const SELECTED_TEXT = "VALUE = 1";
const REJECTED_TEXT = "VALUE = 2";
const ACCEPTED_TEXT = "VALUE = 3";
const ASK_COMMAND = "Ask Keiko about this selection";
const REPLY_MARKER = "KEIKO_E2E_STREAM_OK";
const PROMPT_PREFIX = "Analyze this editor selection.";
const INITIAL_CONTENT = [
  "export let VALUE = 0;",
  `// ${BEFORE_SENTINEL}`,
  SELECTED_TEXT,
  `// ${AFTER_SENTINEL}`,
  "",
].join("\n");
const ACCEPTED_CONTENT = INITIAL_CONTENT.replace(SELECTED_TEXT, ACCEPTED_TEXT);
const EXPECTED_SELECTION = {
  start: { line: 2, character: 0 },
  end: { line: 2, character: SELECTED_TEXT.length },
};

test.use({ viewport: { width: 1600, height: 1000 } });

interface ChatInfo {
  readonly id: string;
  readonly title: string;
}

interface RoundTripFixture {
  readonly root: string;
  readonly absolutePath: string;
  readonly chat: ChatInfo;
}

interface PersistedMessage {
  readonly role: string;
  readonly content: string;
}

interface RoundTripSurfaces {
  readonly editorWindow: Locator;
  readonly chatWindow: Locator;
}

interface QueuedAction {
  readonly actionId: string;
  readonly body: Record<string, unknown>;
}

interface PatchReview {
  readonly review: Locator;
  readonly accept: Locator;
  readonly reject: Locator;
}

const SEEDED_ASSISTANT_MESSAGE = [
  "Reject candidate:",
  "",
  "```typescript",
  REJECTED_TEXT,
  "```",
  "",
  "Accept candidate:",
  "",
  "```typescript",
  ACCEPTED_TEXT,
  "```",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function tryParseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonRecord(raw: string, context: string): Record<string, unknown> {
  const parsed = tryParseJsonRecord(raw);
  if (parsed === null) throw new Error(`${context} returned a non-object JSON body.`);
  return parsed;
}

function chatInfoFromResponse(raw: string): ChatInfo {
  const body = parseJsonRecord(raw, "Chat creation");
  const chat = body.chat;
  if (!isRecord(chat) || typeof chat.id !== "string" || typeof chat.title !== "string") {
    throw new Error("Chat creation returned an invalid chat.");
  }
  return { id: chat.id, title: chat.title };
}

async function createMessage(
  request: APIRequestContext,
  fixture: RoundTripFixture,
  role: "user" | "assistant",
  content: string,
  timestamp: number,
): Promise<void> {
  const response = await request.post("/api/chats/messages", {
    headers: MUTATION_HEADERS,
    data: { chatId: fixture.chat.id, projectPath: fixture.root, role, content, timestamp },
  });
  expect(response.status(), await response.text().catch(() => "")).toBe(201);
}

async function createRoundTripFixture(request: APIRequestContext): Promise<RoundTripFixture> {
  const { root } = createEditorWorkspace([{ path: RELATIVE_PATH, content: INITIAL_CONTENT }]);
  const absolutePath = join(root, RELATIVE_PATH);
  const stableMtime = new Date(1_700_000_000_000);
  utimesSync(absolutePath, stableMtime, stableMtime);
  const project = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name: "Keiko editor chat roundtrip E2E" },
  });
  if (!project.ok()) {
    throw new Error(`Project setup failed (${String(project.status())}): ${await project.text()}`);
  }
  const create = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: { projectPath: root, title: CHAT_TITLE, selectedModel: CHAT_MODEL_ID },
  });
  const createBody = await create.text();
  expect(create.status(), createBody).toBe(201);
  const fixture = {
    root,
    absolutePath,
    chat: chatInfoFromResponse(createBody),
  };
  const now = Date.now();
  await createMessage(request, fixture, "user", "Provide two bounded replacement candidates.", now);
  await createMessage(request, fixture, "assistant", SEEDED_ASSISTANT_MESSAGE, now + 1);
  return fixture;
}

async function seedRoundTripWindows(page: Page, fixture: RoundTripFixture): Promise<void> {
  await page.addInitScript(
    ({ chat, chatWindowId, editorWindowId, root, relativePath }) => {
      const windows = [
        {
          id: editorWindowId,
          type: "editor",
          x: 20,
          y: 20,
          w: 940,
          h: 840,
          z: 10,
          cfg: { root, file: relativePath, openFiles: [relativePath] },
          max: false,
        },
        {
          id: chatWindowId,
          type: "chat",
          x: 990,
          y: 20,
          w: 570,
          h: 840,
          z: 11,
          cfg: { chatId: chat.id, title: chat.title },
          max: false,
        },
      ];
      window.localStorage.setItem("keiko.workspace.v4", JSON.stringify(windows));
      window.localStorage.setItem("keiko.theme", "dark");
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      window.localStorage.removeItem("keiko.conns.v1");
    },
    {
      chat: fixture.chat,
      chatWindowId: CHAT_WINDOW_ID,
      editorWindowId: EDITOR_WINDOW_ID,
      root: fixture.root,
      relativePath: RELATIVE_PATH,
    },
  );
}

async function openRoundTripSurfaces(page: Page): Promise<RoundTripSurfaces> {
  await page.goto("/");
  await openEditorWorkspace(page);
  const editorWindow = page.locator(`.window[data-window-id="${EDITOR_WINDOW_ID}"]`);
  const chatWindow = page.getByRole("region", { name: `Chat — ${CHAT_TITLE}` });
  await expect(editorWindow.locator(".monaco-editor").first()).toBeVisible();
  await expect(chatWindow.getByRole("textbox", { name: "Chat message" })).toBeVisible();
  await expect(chatWindow.getByRole("button", { name: "Apply to editor" })).toHaveCount(2);
  return { editorWindow, chatWindow };
}

function normalizeBuffer(text: string): string {
  return text.replace(/\r\n/gu, "\n").replace(/\n+$/u, "");
}

async function readEditorBuffer(editorWindow: Locator): Promise<string> {
  const viewLines = editorWindow.locator(".monaco-editor .view-lines").first();
  await expect(viewLines).toBeVisible();
  const lines = await viewLines.evaluate((container) =>
    Array.from(container.querySelectorAll<HTMLElement>(".view-line"))
      .map((row) => {
        const source = row.cloneNode(true);
        if (!(source instanceof HTMLElement)) return { top: 0, text: "" };
        // Monaco renders inlay hints and other virtual text as dynamically styled inline
        // decorations inside the view line. They are not part of the editor model, so exclude them
        // when this test verifies the actual buffer after accepting or rejecting a review.
        source.querySelectorAll('[class*="dyn-rule-"]').forEach((decoration) => {
          decoration.remove();
        });
        return { top: Number.parseInt(row.style.top, 10) || 0, text: source.textContent };
      })
      .sort((left, right) => left.top - right.top)
      .map((row) => row.text.replaceAll("\u00a0", " ")),
  );
  return normalizeBuffer(lines.join("\n"));
}

async function selectStrictSubstring(page: Page, editorWindow: Locator): Promise<void> {
  const selectedLine = editorWindow
    .locator(".monaco-editor .view-line")
    .filter({ hasText: SELECTED_TEXT })
    .first();
  await expect(selectedLine).toBeVisible();
  await selectedLine.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
}

async function matchingSessionSelection(
  request: APIRequestContext,
  root: string,
): Promise<unknown> {
  const response = await request.get("/api/editor/agent/sessions");
  if (!response.ok()) return null;
  const body = tryParseJsonRecord(await response.text());
  const sessions = body?.sessions;
  if (!isUnknownArray(sessions)) return null;
  const session = sessions.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.workspaceRoot === root &&
      candidate.activeFile === RELATIVE_PATH,
  );
  return isRecord(session) ? (session.selection ?? null) : null;
}

async function expectSelectionSnapshot(
  request: APIRequestContext,
  fixture: RoundTripFixture,
): Promise<void> {
  await expect
    .poll(() => matchingSessionSelection(request, fixture.root), { timeout: 30_000 })
    .toEqual(EXPECTED_SELECTION);
}

async function invokeAskCommand(page: Page): Promise<void> {
  await page.keyboard.press("F1");
  const palette = page.locator(".quick-input-widget");
  await expect(palette).toBeVisible();
  await page.keyboard.type(ASK_COMMAND);
  await expect(palette.getByText(ASK_COMMAND, { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
}

async function listMessages(
  request: APIRequestContext,
  fixture: RoundTripFixture,
): Promise<readonly PersistedMessage[]> {
  const params = new URLSearchParams({ chatId: fixture.chat.id, projectPath: fixture.root });
  const response = await request.get(`/api/chats/messages?${params.toString()}`);
  if (!response.ok()) throw new Error(`Message read failed (${String(response.status())}).`);
  const body = parseJsonRecord(await response.text(), "Message read");
  const rawMessages = body.messages;
  if (!isUnknownArray(rawMessages)) throw new Error("Message read returned an invalid list.");
  const messages: PersistedMessage[] = [];
  for (const candidate of rawMessages) {
    if (
      isRecord(candidate) &&
      typeof candidate.role === "string" &&
      typeof candidate.content === "string"
    ) {
      messages.push({ role: candidate.role, content: candidate.content });
    }
  }
  return messages;
}

async function waitForPersistedPrompt(
  request: APIRequestContext,
  fixture: RoundTripFixture,
): Promise<string> {
  await expect
    .poll(
      async () =>
        (await listMessages(request, fixture)).some(
          (message) => message.role === "user" && message.content.startsWith(PROMPT_PREFIX),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  const prompt = (await listMessages(request, fixture)).find(
    (message) => message.role === "user" && message.content.startsWith(PROMPT_PREFIX),
  );
  if (prompt === undefined) throw new Error("The persisted selection prompt disappeared.");
  return prompt.content;
}

async function proveSelectionHandoff(
  page: Page,
  request: APIRequestContext,
  fixture: RoundTripFixture,
  surfaces: RoundTripSurfaces,
  testInfo: TestInfo,
): Promise<void> {
  await selectStrictSubstring(page, surfaces.editorWindow);
  await expectSelectionSnapshot(request, fixture);
  await invokeAskCommand(page);
  const prompt = await waitForPersistedPrompt(request, fixture);
  expect(prompt).toContain(`Root-relative file (JSON): "${RELATIVE_PATH}"`);
  expect(prompt).toContain("Range: L3:C1-L3:C10");
  expect(prompt).toContain(`Selection (JSON):\n"${SELECTED_TEXT}"`);
  expect(prompt).not.toContain(BEFORE_SENTINEL);
  expect(prompt).not.toContain(AFTER_SENTINEL);
  const promptBubble = surfaces.chatWindow
    .locator('article.chat-msg[data-role="user"]')
    .filter({ hasText: PROMPT_PREFIX })
    .last();
  await expect(promptBubble).toBeVisible();
  await expect(promptBubble.locator(".chat-msg-content")).toHaveText(prompt);
  await expect(surfaces.chatWindow.getByText(new RegExp(REPLY_MARKER, "u")).last()).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(
      async () =>
        (await listMessages(request, fixture)).some(
          (message) => message.role === "assistant" && message.content.includes(REPLY_MARKER),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await testInfo.attach("editor-chat-selection-roundtrip", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
}

function isChatApplyRequest(request: PlaywrightRequest): boolean {
  if (request.method() !== "POST") return false;
  if (new URL(request.url()).pathname !== "/api/editor/agent/actions") return false;
  const body = tryParseJsonRecord(request.postData());
  const action = isRecord(body?.action) ? body.action : body;
  return body?.kind === "action" && action?.type === "applyPatch";
}

async function queueCodeBlock(page: Page, frame: Locator): Promise<QueuedAction> {
  const actionRequestPromise = page.waitForRequest(isChatApplyRequest, { timeout: 15_000 });
  const applyButton = frame.locator("button[data-apply-state]");
  await expect(applyButton).toHaveAttribute("data-apply-state", "idle");
  await expect(applyButton).toHaveAccessibleName("Apply to editor");
  await expect(applyButton).toBeEnabled();
  await applyButton.click();
  const actionRequest = await actionRequestPromise;
  const response = await actionRequest.response();
  if (response === null) throw new Error("The chat apply action received no BFF response.");
  expect(response.status()).toBe(202);
  const responseBody = parseJsonRecord(await response.text(), "Editor action queue");
  expect(responseBody.result).toEqual(expect.objectContaining({ status: "queued" }));
  const requestBody = parseJsonRecord(actionRequest.postData() ?? "", "Editor action request");
  const body = requestBody.action;
  if (!isRecord(body)) throw new Error("Editor bridge request lacks an action envelope.");
  expect(requestBody).toMatchObject({ schemaVersion: "1", kind: "action" });
  expect(body).toMatchObject({
    schemaVersion: "1",
    type: "applyPatch",
    target: { file: RELATIVE_PATH },
  });
  expect(body.expectedContentHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
  expect(body.expectedDocumentVersion).toEqual(
    expect.objectContaining({ contentHash: body.expectedContentHash }),
  );
  if (typeof body.actionId !== "string") throw new Error("Queued action lacks an action id.");
  await expect(applyButton).toHaveAttribute("data-apply-state", "queued");
  await expect(applyButton).toHaveAccessibleName("Queued for review");
  return { actionId: body.actionId, body };
}

function isActionResultResponse(
  response: PlaywrightResponse,
  actionId: string,
  status: "failed" | "succeeded",
): boolean {
  const request = response.request();
  if (request.method() !== "POST") return false;
  if (new URL(request.url()).pathname !== "/api/editor/agent/actions") return false;
  const body = tryParseJsonRecord(request.postData());
  const result = body?.result;
  return (
    body?.kind === "result" &&
    isRecord(result) &&
    result.actionId === actionId &&
    result.status === status
  );
}

function actionResultResponse(
  page: Page,
  actionId: string,
  status: "failed" | "succeeded",
): Promise<PlaywrightResponse> {
  return page.waitForResponse((response) => isActionResultResponse(response, actionId, status), {
    timeout: 15_000,
  });
}

async function activateReviewDecision(page: Page, button: Locator): Promise<void> {
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
}

async function expectPatchReview(
  editorWindow: Locator,
  fixture: RoundTripFixture,
  replacement: string,
): Promise<PatchReview> {
  const reviewHost = editorWindow.getByRole("tabpanel", { name: RELATIVE_PATH });
  const review = reviewHost.locator(`[aria-label="Agent patch review for ${RELATIVE_PATH}"]`);
  const accept = reviewHost
    .getByRole("button", { name: "Accept agent patch and apply changes", exact: true })
    .last();
  const reject = reviewHost
    .getByRole("button", { name: "Reject agent patch and discard changes", exact: true })
    .last();
  await expect(review).toBeVisible();
  await expect(accept).toHaveAttribute("aria-label", "Accept agent patch and apply changes");
  await expect(reject).toHaveAttribute("aria-label", "Reject agent patch and discard changes");
  await expect(review.getByTestId("keiko-diff-editor")).toBeVisible();
  await expect(review.getByTestId("keiko-diff-file")).toContainText(RELATIVE_PATH);
  await expect(review.getByTestId("keiko-diff-file")).toContainText("modified");
  await expect(review.getByRole("status")).toContainText("Reviewing 1 changed file(s)");
  const diffEditor = review.getByTestId("keiko-diff-editor");
  await expect(
    diffEditor
      .locator(".original-in-monaco-diff-editor .view-line")
      .filter({ hasText: SELECTED_TEXT }),
  ).toBeVisible();
  await expect(
    diffEditor
      .locator(".modified-in-monaco-diff-editor .view-line")
      .filter({ hasText: replacement }),
  ).toBeVisible();
  await expect(
    diffEditor
      .locator(".original-in-monaco-diff-editor .view-line")
      .filter({ hasText: BEFORE_SENTINEL }),
  ).toBeVisible();
  await expect(
    diffEditor
      .locator(".modified-in-monaco-diff-editor .view-line")
      .filter({ hasText: AFTER_SENTINEL }),
  ).toBeVisible();
  await expect(editorWindow.locator('[data-field="save"]')).toHaveText("Saved");
  expect(readFileSync(fixture.absolutePath, "utf8")).toBe(INITIAL_CONTENT);
  return { review, accept, reject };
}

function codeBlockFrame(chatWindow: Locator, text: string): Locator {
  return chatWindow.locator(".sm-code-block-frame").filter({ hasText: text });
}

async function rejectFirstCandidate(
  page: Page,
  fixture: RoundTripFixture,
  surfaces: RoundTripSurfaces,
  testInfo: TestInfo,
): Promise<void> {
  const queued = await queueCodeBlock(page, codeBlockFrame(surfaces.chatWindow, REJECTED_TEXT));
  expect(queued.body.patch).toEqual(expect.stringContaining(`+${REJECTED_TEXT}`));
  expect(queued.body.patch).toEqual(expect.stringContaining(BEFORE_SENTINEL));
  expect(queued.body.patch).toEqual(expect.stringContaining(AFTER_SENTINEL));
  const patchReview = await expectPatchReview(surfaces.editorWindow, fixture, REJECTED_TEXT);
  await testInfo.attach("editor-chat-reject-review", {
    body: await surfaces.editorWindow.screenshot(),
    contentType: "image/png",
  });
  const resultResponsePromise = actionResultResponse(page, queued.actionId, "failed");
  await activateReviewDecision(page, patchReview.reject);
  expect((await resultResponsePromise).ok()).toBe(true);
  await expect(patchReview.review).toBeHidden();
  await expect
    .poll(() => readEditorBuffer(surfaces.editorWindow))
    .toBe(normalizeBuffer(INITIAL_CONTENT));
  await expect(surfaces.editorWindow.locator('[data-field="save"]')).toHaveText("Saved");
  expect(readFileSync(fixture.absolutePath, "utf8")).toBe(INITIAL_CONTENT);
}

async function acceptSecondCandidate(
  page: Page,
  fixture: RoundTripFixture,
  surfaces: RoundTripSurfaces,
  testInfo: TestInfo,
): Promise<void> {
  const queued = await queueCodeBlock(page, codeBlockFrame(surfaces.chatWindow, ACCEPTED_TEXT));
  expect(queued.body.patch).toEqual(expect.stringContaining(`+${ACCEPTED_TEXT}`));
  expect(queued.body.patch).toEqual(expect.stringContaining(BEFORE_SENTINEL));
  expect(queued.body.patch).toEqual(expect.stringContaining(AFTER_SENTINEL));
  const patchReview = await expectPatchReview(surfaces.editorWindow, fixture, ACCEPTED_TEXT);
  const resultResponsePromise = actionResultResponse(page, queued.actionId, "succeeded");
  await activateReviewDecision(page, patchReview.accept);
  expect((await resultResponsePromise).ok()).toBe(true);
  await expect(patchReview.review).toBeHidden();
  await expect
    .poll(() => readEditorBuffer(surfaces.editorWindow))
    .toBe(normalizeBuffer(ACCEPTED_CONTENT));
  await expect(surfaces.editorWindow.locator('[data-field="save"]')).toHaveText("Unsaved");
  expect(readFileSync(fixture.absolutePath, "utf8")).toBe(INITIAL_CONTENT);
  await testInfo.attach("editor-chat-accepted-dirty-buffer", {
    body: await surfaces.editorWindow.screenshot(),
    contentType: "image/png",
  });
  await surfaces.editorWindow.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => readFileSync(fixture.absolutePath, "utf8")).toBe(ACCEPTED_CONTENT);
  await expect(surfaces.editorWindow.locator('[data-field="save"]')).toHaveText("Saved");
}

test.afterAll(() => {
  cleanupEditorWorkspaces();
});

test("editor selection and assistant code blocks round-trip through governed review @smoke", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await createRoundTripFixture(request);
  await seedRoundTripWindows(page, fixture);
  const pageErrors = collectPageErrors(page);
  const surfaces = await openRoundTripSurfaces(page);

  await proveSelectionHandoff(page, request, fixture, surfaces, testInfo);
  await rejectFirstCandidate(page, fixture, surfaces, testInfo);
  await selectStrictSubstring(page, surfaces.editorWindow);
  await expectSelectionSnapshot(request, fixture);
  await acceptSecondCandidate(page, fixture, surfaces, testInfo);

  expect(pageErrors).toEqual([]);
});
