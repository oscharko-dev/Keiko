import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { editorModifier, selectAllInEditor } from "./support/editor-chord.js";

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
const updateLoopErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }): void => {
  const errors: string[] = [];
  updateLoopErrors.set(page, errors);
  page.on("console", (message): void => {
    if (message.type() === "error" && message.text().includes("Maximum update depth exceeded")) {
      errors.push("Maximum update depth exceeded");
    }
  });
});

test.afterEach(({ page }): void => {
  expect(updateLoopErrors.get(page)).toEqual([]);
});

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
  title = "E2E chat send",
): Promise<{ chat: ChatResponse["chat"]; projectPath: string }> {
  const projectPath = createProjectFixture();
  await ensureProject(request, projectPath);
  const create = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: { projectPath, title, selectedModel: CHAT_MODEL_ID },
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
  // below succeeds because configuration initialization verifies the model before admission — this journey
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

test("preserves typed SQL, globs, arithmetic and inline code in the persisted prompt @smoke", async ({
  page,
  request,
}) => {
  const { chat, projectPath } = await openFixtureComposer(page, request);
  const composer = page.getByRole("textbox", { name: "Chat message" });
  const source =
    "SELECT * FROM t WHERE a * b > 3; 2 * 3 * 4; rm -rf **/node_modules and **/dist; delete *.js and *.ts; `a * b * c`; `*literal*`";
  await composer.pressSequentially(source);
  await page.getByRole("button", { name: "Send message" }).click();
  const params = new URLSearchParams({ chatId: chat.id, projectPath });
  await expect
    .poll(async () => {
      const response = await request.get(`/api/chats/messages?${params.toString()}`);
      const body = (await response.json()) as { messages: { role: string; content: string }[] };
      return body.messages.find((message) => message.role === "user")?.content;
    })
    .toBe(source);
});

test("submits the live Composer text with Enter and clears the draft @smoke", async ({
  page,
  request,
}): Promise<void> => {
  const { chat, projectPath } = await openFixtureComposer(page, request);
  const composer = page.getByRole("textbox", { name: "Chat message" });
  const source = "Immediate Enter send preserves every character.";
  await composer.fill(source);
  await composer.press("Enter");
  const params = new URLSearchParams({ chatId: chat.id, projectPath });
  await expect
    .poll(async () => {
      const response = await request.get(`/api/chats/messages?${params.toString()}`);
      const body = (await response.json()) as { messages: { role: string; content: string }[] };
      return body.messages.find((message) => message.role === "user")?.content;
    })
    .toBe(source);
  await expect(composer).toBeEmpty();
});

async function clearFixtureComposer(page: Page): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Chat message" });
  await composer.press("ControlOrMeta+A");
  await composer.press("Backspace");
  await expect(composer).toHaveText("");
}

async function openFixtureComposer(
  page: Page,
  request: APIRequestContext,
): Promise<Awaited<ReturnType<typeof createChat>>> {
  const fixture = await createChat(request);
  const { chat } = fixture;
  await seedChatWindow(page, chat);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Chat message" })).toBeVisible();
  return fixture;
}

async function expectStoredPrompt(
  request: APIRequestContext,
  fixture: Awaited<ReturnType<typeof createChat>>,
  source: string,
): Promise<void> {
  const params = new URLSearchParams({ chatId: fixture.chat.id, projectPath: fixture.projectPath });
  await expect
    .poll(
      async () => {
        const result = await request.get(`/api/chats/messages?${params.toString()}`);
        const body = (await result.json()) as { messages: { role: string; content: string }[] };
        return body.messages.find((message) => message.role === "user")?.content;
      },
      { timeout: 30000 },
    )
    .toBe(source);
}

async function copyComposerText(
  page: Page,
  composer: ReturnType<Page["getByRole"]>,
  source: string,
): Promise<void> {
  const nativeModifier = await page.evaluate(() =>
    navigator.platform.startsWith("Mac") ? "Meta" : "Control",
  );
  expect(await editorModifier(page)).toBe(nativeModifier);
  await composer.pressSequentially("```");
  await composer.press("Shift+Enter");
  const code = composer.locator(".monaco-editor");
  await expect(code).toBeVisible({ timeout: 30000 });
  const input = code.getByRole("textbox", { name: "Code input" });
  await input.focus();
  for (const [index, line] of source.split("\n").entries()) {
    if (index > 0) await input.press("Enter");
    await page.keyboard.insertText(line);
  }
  await selectAllNativeComposerCode(page, composer);
  await input.press(`${await editorModifier(page)}+C`);
  await page.getByRole("button", { name: "Continue below ↵" }).click();
  await clearFixtureComposer(page);
}

async function selectAllNativeComposerCode(
  page: Page,
  composer: ReturnType<Page["getByRole"]>,
): Promise<void> {
  const modifier = await editorModifier(page);
  if (modifier !== "Meta") {
    await selectAllInEditor(page, composer);
    return;
  }
  // Native macOS profiles bind Monaco's model bounds to arrows, rather than Home/End.
  await page.keyboard.press(`${modifier}+ArrowUp`);
  await page.keyboard.press(`${modifier}+Shift+ArrowDown`);
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

test.describe("native Composer clipboard", () => {
  test("preserves literal pasted prompts through the gateway and shows keyboard focus @smoke", async ({
    page,
    request,
  }) => {
    const { chat, projectPath } = await createChat(request);
    await seedChatWindow(page, chat);
    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Chat message" });
    await expect(composer).toBeVisible();
    await composer.click();
    const scope = page.locator("[data-markdown-composer-scope]");
    await expect
      .poll(() => scope.evaluate((element) => getComputedStyle(element).outlineStyle))
      .toBe("none");
    await composer.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(composer).toBeFocused();
    await expect
      .poll(() => scope.evaluate((element) => getComputedStyle(element).outlineStyle))
      .toBe("solid");
    const source = '@src/__tests__/file.ts\nC:\\temp\\[report]\\file.ts\n  run("* _ [value]");';
    await copyComposerText(page, composer, source);
    await composer.press("ControlOrMeta+V");
    await expect.poll(() => composer.innerText()).toBe(source);
    await page.getByRole("button", { name: "Send message" }).click();
    const params = new URLSearchParams({ chatId: chat.id, projectPath });
    await expect
      .poll(
        async () => {
          const result = await request.get(`/api/chats/messages?${params.toString()}`);
          const body = (await result.json()) as { messages: { role: string; content: string }[] };
          return body.messages.find((message) => message.role === "user")?.content;
        },
        { timeout: 30000 },
      )
      .toBe(source);
  });
  // Native clipboard shortcuts and Monaco must observe the same actual browser platform.
  // Desktop presets can force Windows on macOS; Linux WebKit even defaults to a Macintosh UA.
  // Align the fixture UA with the native platform so Monaco and the OS clipboard use one chord.
  test.use({
    userAgent: async ({ browser }, use) => {
      const probe = await browser.newPage();
      try {
        const userAgent = await probe.evaluate(() =>
          navigator.platform.startsWith("Linux")
            ? navigator.userAgent.replace(/\(Macintosh;[^)]*\)/u, "(X11; Linux)")
            : navigator.userAgent,
        );
        await use(userAgent);
      } finally {
        await probe.close();
      }
    },
  });

  test("loads local highlighting, pastes and scrolls code inside the Composer @smoke", async ({
    page,
    request,
  }) => {
    const fixture = await openFixtureComposer(page, request);
    const composer = page.getByRole("textbox", { name: "Chat message" });
    const source = Array.from(
      { length: 80 },
      (_, index) => `const value${String(index)} = ${String(index)};`,
    ).join("\n");
    await copyComposerText(page, composer, source);
    await composer.pressSequentially("```typescript");
    await composer.press("Shift+Enter");
    const code = composer.locator(".monaco-editor");
    await expect(code).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Loading syntax highlighting…", { exact: true })).toBeHidden();
    const input = code.getByRole("textbox", { name: "Code input" });
    await code.locator(".view-lines").click();
    await input.press(`${await editorModifier(page)}+V`);
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
    await expect
      .poll(async () => (await slider.boundingBox())?.y ?? 0)
      .toBeLessThan(before?.y ?? 0);
    await page.mouse.wheel(0, 400);
    await expect
      .poll(async () => (await slider.boundingBox())?.y ?? 0)
      .toBeCloseTo(before?.y ?? 0, 0);
    await page.getByRole("button", { name: "Continue below ↵" }).click();
    await composer.pressSequentially("Explain the code.");
    await expect(composer.locator("p").last()).toHaveText("Explain the code.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expectStoredPrompt(
      request,
      fixture,
      `\`\`\`typescript\n${source}\n\`\`\`\n\nExplain the code.`,
    );
    await expect(page.getByText(new RegExp(REPLY_MARKER))).toBeVisible({ timeout: 30000 });
  });

  test("detects pasted code, preserves the sent code block and compacts the conversation @smoke", async ({
    page,
    request,
  }) => {
    const fixture = await openFixtureComposer(page, request);
    const composer = page.getByRole("textbox", { name: "Chat message" });
    const source = [
      "export interface Probe { readonly count: number; }",
      ...Array.from(
        { length: 60 },
        (_, index) => `export const count${String(index)}: number = ${String(index)};`,
      ),
    ].join("\n");
    await copyComposerText(page, composer, source);
    await composer.pressSequentially("```");
    await composer.press("Shift+Enter");
    const code = composer.locator(".monaco-editor");
    await expect(code).toBeVisible({ timeout: 30000 });
    await code.locator(".view-lines").click();
    await code
      .getByRole("textbox", { name: "Code input" })
      .press(`${await editorModifier(page)}+V`);
    await expect(page.getByRole("combobox", { name: "Code language" })).toHaveValue("typescript");
    await expect(code.getByRole("textbox", { name: "Code input" })).toBeFocused();
    await page.getByRole("button", { name: "Continue below ↵" }).click();
    await composer.pressSequentially("Explain the code.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expectStoredPrompt(
      request,
      fixture,
      `\`\`\`typescript\n${source}\n\`\`\`\n\nExplain the code.`,
    );
    const prompt = page.locator('article[data-role="user"]');
    await expect
      .poll(() =>
        prompt.evaluate((element) => {
          const bubble = element.querySelector(".chat-msg-bubble");
          return (
            (bubble?.getBoundingClientRect().width ?? 0) / element.getBoundingClientRect().width
          );
        }),
      )
      .toBeGreaterThanOrEqual(0.49);
    await expect(prompt.locator(".sm-code-block-frame")).toBeVisible();
    await expect(prompt.getByRole("button", { name: "Apply in editor" })).toHaveCount(0);
    await expect(page.getByText(new RegExp(REPLY_MARKER))).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: /Conversation context:/ }).click();
    await page.getByRole("button", { name: "Compact context now" }).click();
    await expect(page.getByText(/tokens saved across/)).toBeVisible();
    await expect(page.getByText("The context could not be refreshed.")).toHaveCount(0);
    await expectStoredPrompt(
      request,
      fixture,
      `\`\`\`typescript\n${source}\n\`\`\`\n\nExplain the code.`,
    );
  });
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

test("deletes selected chats with one mouse action and no confirmation @smoke", async ({
  page,
  request,
}) => {
  const { chat, projectPath } = await createChat(request, "Batch deletion first");
  const create = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: { projectPath, title: "Batch deletion second", selectedModel: CHAT_MODEL_ID },
  });
  expect(create.status()).toBe(201);
  const second = (await create.json()) as ChatResponse;
  await seedChatWindow(page, chat);
  await page.addInitScript(() => {
    const windows = JSON.parse(localStorage.getItem("keiko.workspace.v4") ?? "[]") as unknown[];
    localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        ...windows,
        {
          id: "e2e-history-window",
          type: "chatHistory",
          x: 40,
          y: 30,
          w: 800,
          h: 680,
          z: 20,
          cfg: {},
          max: false,
        },
      ]),
    );
  });
  await page.goto("/");
  // The seeded chat window binds its chat and loads its composer chunk after the page is up, and
  // the history panel below must not be driven while that bind is still settling: on a slow CI
  // runner (PR #3876, run 37579726862) the search text typed and the "Select all" click made
  // during the bind never reached the panel, although both controls were visible and enabled.
  // Waiting for the bound composer orders the two windows' startup before the journey begins.
  const chatWindow = page.getByRole("region", { name: `Chat — ${chat.title}` });
  await expect(chatWindow.getByRole("textbox", { name: "Chat message" })).toBeVisible();
  const history = page.getByRole("region", { name: /^Chat History/u });
  await expect(history).toBeVisible();
  await history.getByRole("textbox", { name: "Search chat history" }).fill("Batch deletion");
  await expect(history.getByRole("checkbox", { name: /^Select Batch deletion/u })).toHaveCount(2);
  await history.getByRole("checkbox", { name: "Select all displayed chats" }).check();
  await history.getByRole("button", { name: "Delete selected (2)", exact: true }).click();
  await expect(history.getByRole("checkbox", { name: /^Select Batch deletion/u })).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  for (const id of [chat.id, second.chat.id]) {
    const response = await request.get(
      `/api/chats/messages?${new URLSearchParams({ chatId: id, projectPath }).toString()}`,
    );
    expect(response.status()).toBe(404);
  }
});

test("locks layout while native scrolling works in an unselected window @smoke", async ({
  page,
  request,
}) => {
  const { chat, projectPath } = await createChat(request);
  for (let index = 0; index < 12; index++) {
    const response = await request.post("/api/chats", {
      headers: MUTATION_HEADERS,
      data: { projectPath, title: `Scroll fixture ${String(index)}`, selectedModel: CHAT_MODEL_ID },
    });
    expect(response.status()).toBe(201);
  }
  await page.addInitScript(
    ({ chatId, title }) => {
      localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "e2e-scroll-first",
            type: "chatHistory",
            x: 30,
            y: 30,
            w: 520,
            h: 450,
            z: 10,
            cfg: {},
            max: false,
          },
          {
            id: "e2e-scroll-second",
            type: "chat",
            x: 580,
            y: 30,
            w: 520,
            h: 450,
            z: 20,
            cfg: { chatId, title },
            max: false,
          },
        ]),
      );
    },
    { chatId: chat.id, title: chat.title },
  );
  await page.goto("/");
  const windows = page.locator('.window[data-window-id^="e2e-scroll-"]');
  await expect(windows).toHaveCount(2);
  const lock = page.getByRole("button", { name: "Lock layout", exact: true });
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  const first = windows.first();
  const header = first.locator("[data-window-header]");
  const initialBox = await first.boundingBox();
  if (initialBox === null) throw new Error("Missing window geometry");
  const headBox = await header.boundingBox();
  if (headBox === null) throw new Error("Missing header geometry");
  await page.mouse.move(headBox.x + 150, headBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(headBox.x + 250, headBox.y + 110, { steps: 8 });
  await page.mouse.up();
  expect(await first.boundingBox()).toEqual(initialBox);
  const scrollRegion = first.getByRole("tabpanel");
  await scrollRegion.hover();
  await page.mouse.wheel(0, 450);
  await expect.poll(() => scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(first).not.toHaveAttribute("data-selected", "true");
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "false");
});
