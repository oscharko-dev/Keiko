import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
            h: 760,
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

  await chatWindow.getByRole("button", { name: "Send message" }).click();

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
