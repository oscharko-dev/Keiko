import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";

// GEN-TEST-RELEASE-GATE-002 / GEN-TEST-E2E-006 — the ONLY CI browser gate never sent a chat message:
// the central product flow (composer -> POST /api/desktop/chat/stream -> BFF -> gateway -> provider
// SSE -> streamed token render -> persistence) had ZERO end-to-end coverage, and the e2e fixture
// made it impossible by pointing the model at https://provider.invalid. This spec closes that gap.
// playwright.config.ts starts a deterministic loopback provider (tests/e2e/support/model-mock-server.mjs)
// and repoints the runtime config's baseUrl at it, so a REAL send reaches a real gateway + a real
// (deterministic) provider and we can assert both the streamed render AND server-side persistence.

const CHAT_MODEL_ID = "e2e-chat-model";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
// Must match tests/e2e/support/model-mock-server.mjs REPLY_MARKER exactly.
const REPLY_MARKER = "KEIKO_E2E_STREAM_OK";
const tempProjects: string[] = [];

// The desktop shell does not scroll; a floating chat window's composer + send button must fit inside
// the viewport for Playwright to click them. Give the page enough height for the seeded window.
test.use({ viewport: { width: 1280, height: 960 } });

interface ChatResponse {
  readonly chat: { readonly id: string; readonly title: string };
}

function createProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-chatsend-"));
  tempProjects.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Keiko chat-send smoke fixture\n", "utf8");
  return root;
}

async function ensureProject(request: APIRequestContext, projectPath: string): Promise<void> {
  const response = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: projectPath, name: "Keiko chat-send E2E" },
  });
  if (!response.ok()) {
    throw new Error(
      `Project setup failed (${String(response.status())}): ${await response.text()}`,
    );
  }
}

async function createChat(
  request: APIRequestContext,
): Promise<{ chat: ChatResponse["chat"]; projectPath: string }> {
  const projectPath = createProjectFixture();
  await ensureProject(request, projectPath);
  const create = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: { projectPath, title: "E2E chat send", selectedModel: CHAT_MODEL_ID },
  });
  expect(create.status(), await create.text().catch(() => "")).toBe(201);
  const created = (await create.json()) as ChatResponse;
  return { chat: created.chat, projectPath };
}

async function seedChatWindow(page: Page, chat: ChatResponse["chat"]): Promise<void> {
  await page.addInitScript(
    ({ chatId, title }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "e2e-chat-window",
            type: "chat",
            x: 64,
            y: 40,
            w: 900,
            h: Math.min(760, Math.max(400, window.innerHeight - 230)),
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

test.afterEach(() => {
  for (const root of tempProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sends a chat message and streams a persisted assistant reply @smoke", async ({
  page,
  request,
}) => {
  const { chat, projectPath } = await createChat(request);
  await seedChatWindow(page, chat);

  await page.goto("/");
  const chatWindow = page.getByRole("region", { name: "Chat — E2E chat send" });
  await expect(chatWindow).toBeVisible();
  const composer = chatWindow.getByRole("textbox", { name: "Chat message" });
  await expect(composer).toBeVisible();
  await composer.click();
  await composer.fill("Ping the deterministic provider");
  const sendButton = chatWindow.getByRole("button", { name: "Send message" });
  // Relocated pin (0.3.12, tri-state readiness — the customer restart incident): a model this
  // process never probed is UNKNOWN, not blocked, so the very first send needs NO manual
  // Settings readiness check and no reload. The send button is usable immediately; the send
  // below succeeds because the SERVER verifies the model on demand at admission — this journey
  // now proves the whole self-service path in a real browser.
  await expect(sendButton).toBeEnabled();

  await sendButton.click();

  // The user's message echoes into the transcript immediately, and the assistant reply arrives as
  // streamed SSE deltas. Asserting the deterministic marker renders proves the WHOLE path worked:
  // composer -> /api/desktop/chat/stream -> gateway -> loopback provider -> streamed render.
  await expect(chatWindow.getByText("Ping the deterministic provider")).toBeVisible();
  await expect(chatWindow.getByText(new RegExp(REPLY_MARKER))).toBeVisible({ timeout: 30_000 });

  // Persistence: the server must have stored the assistant turn (not just painted it client-side).
  // Read it back through the messages API — a stream that renders but never persists (the exact
  // buffered-disconnect / phantom-persist failure class W3/W8 flagged) fails HERE, not on render.
  await expect
    .poll(
      async () => {
        const params = new URLSearchParams({ chatId: chat.id, projectPath });
        const res = await request.get(`/api/chats/messages?${params.toString()}`);
        if (!res.ok()) return `HTTP ${String(res.status())}`;
        return await res.text();
      },
      { timeout: 15_000 },
    )
    .toContain(REPLY_MARKER);

  // And it survives a reload (re-hydrated from the store, not from in-memory client state).
  await page.goto("/");
  const reopened = page.getByRole("region", { name: "Chat — E2E chat send" });
  await expect(reopened.getByText(new RegExp(REPLY_MARKER))).toBeVisible({ timeout: 30_000 });
});

async function openFixtureComposer(page: Page, request: APIRequestContext): Promise<void> {
  const { chat } = await createChat(request);
  await seedChatWindow(page, chat);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Chat message" })).toBeVisible();
}

test("removes heading formatting after deleting its last character @smoke", async ({
  page,
  request,
}) => {
  await openFixtureComposer(page, request);
  const composer = page.getByRole("textbox", { name: "Chat message" });
  await composer.pressSequentially("# Hallo");
  await expect(composer.locator("h1")).toHaveText("Hallo");
  for (let count = 0; count < 6; count += 1) await composer.press("Backspace");
  await expect(composer.locator("h1")).toHaveCount(0);
  await composer.pressSequentially("Normal");
  await expect(composer.locator("p")).toHaveText("Normal");
});

test("loads local highlighting, pastes and scrolls code inside the Composer @smoke", async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openFixtureComposer(page, request);
  const composer = page.getByRole("textbox", { name: "Chat message" });
  await composer.pressSequentially("```typescript");
  await composer.press("Shift+Enter");
  const code = composer.locator(".monaco-editor");
  await expect(code).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Loading syntax highlighting…", { exact: true })).toBeHidden();
  const source = Array.from(
    { length: 80 },
    (_, index) => `const value${String(index)} = ${String(index)};`,
  ).join("\n");
  const input = code.getByRole("textbox", { name: "Code input" });
  await code.locator(".view-lines").click();
  // Native clipboard paste follows the OS, independent of Monaco's user-agent command bindings.
  await page.evaluate((content) => navigator.clipboard.writeText(content), source);
  await input.press("ControlOrMeta+V");
  await code.hover();
  await expect
    .poll(() =>
      code
        .locator(".view-line span")
        .evaluateAll((nodes) => new Set(nodes.map((node) => getComputedStyle(node).color)).size),
    )
    .toBeGreaterThan(1);
  const slider = code.locator(
    ".overflow-guard > .monaco-scrollable-element > .scrollbar.vertical > .slider",
  );
  const before = await slider.boundingBox();
  expect(before).not.toBeNull();
  await code.hover();
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await slider.boundingBox())?.y ?? 0).toBeLessThan(before?.y ?? 0);
  await page.mouse.wheel(0, 400);
  await expect
    .poll(async () => (await slider.boundingBox())?.y ?? 0)
    .toBeCloseTo(before?.y ?? 0, 0);
  await page.getByRole("button", { name: "Continue below ↵" }).click();
  await composer.pressSequentially("Explain the code.");
  await expect(composer.locator("p").last()).toHaveText("Explain the code.");
});

test("keeps model selection and context disclosure inside a short viewport @smoke", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1116, height: 850 });
  await openFixtureComposer(page, request);
  const model = page.getByRole("combobox", { name: "Models", exact: true });
  await model.click();
  await expect(page.getByPlaceholder("Search models...")).toHaveCount(0);
  const menu = page.getByRole("listbox");
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(850);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Conversation context:/ }).click();
  const panel = page.getByRole("region", { name: "Conversation context", exact: true });
  await expect(panel).toBeVisible();
  const bounds = await panel.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(850);
});

test("scrolls and searches twelve models while hiding unsupported attachments @smoke", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1116, height: 850 });
  await page.route("**/api/models", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { models: ModelCapability[] };
    const model = body.models.find((entry) => entry.id === CHAT_MODEL_ID);
    if (model === undefined) throw new TypeError("Missing configured fixture model");
    await route.fulfill({
      response,
      json: {
        models: Array.from({ length: 12 }, (_, index) => ({
          ...model,
          id: index === 0 ? CHAT_MODEL_ID : `e2e-model-${String(index)}`,
          supportsImageInput: false,
          supportsDocumentInput: false,
        })),
      },
    });
  });
  await openFixtureComposer(page, request);
  await expect(page.getByRole("button", { name: "Attach file", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Models", exact: true }).click();
  const menu = page.getByRole("listbox");
  await menu.hover();
  await page.mouse.wheel(0, 1000);
  await expect(page.getByRole("option", { name: "e2e-model-11", exact: true })).toBeInViewport();
  const search = page.getByRole("searchbox", { name: "Search models...", exact: true });
  await search.fill("model-11");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(menu.getByRole("option")).toHaveText("e2e-model-11");
});
