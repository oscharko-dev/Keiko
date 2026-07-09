import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHAT_MODEL_ID = "e2e-chat-model";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const tempProjects: string[] = [];

test.use({ viewport: { width: 1280, height: 960 } });

interface ChatResponse {
  readonly chat: { readonly id: string; readonly title: string };
}

interface ChatFixture {
  readonly chat: ChatResponse["chat"];
  readonly projectPath: string;
}

interface ChatScrollMetrics {
  readonly bodyOverflowY: string;
  readonly bodyScrollRange: number;
  readonly chatOverflowY: string;
  readonly chatScrollRange: number;
  readonly clampedChatScrollTop: number;
}

function createProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-chatresize-"));
  tempProjects.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "# Keiko chat resize fixture\n", "utf8");
  return root;
}

async function createChat(request: APIRequestContext): Promise<ChatFixture> {
  const projectPath = createProjectFixture();
  const project = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: projectPath, name: "Keiko chat resize E2E" },
  });
  if (!project.ok()) throw new Error(`Project setup failed (${String(project.status())})`);
  const create = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: { projectPath, title: "E2E chat resize", selectedModel: CHAT_MODEL_ID },
  });
  expect(create.status(), await create.text().catch(() => "")).toBe(201);
  return { chat: ((await create.json()) as ChatResponse).chat, projectPath };
}

async function createMessage(
  request: APIRequestContext,
  fixture: ChatFixture,
  role: "user" | "assistant",
  content: string,
  timestamp: number,
): Promise<void> {
  const response = await request.post("/api/chats/messages", {
    headers: MUTATION_HEADERS,
    data: {
      chatId: fixture.chat.id,
      projectPath: fixture.projectPath,
      role,
      content,
      timestamp,
    },
  });
  expect(response.status(), await response.text().catch(() => "")).toBe(201);
}

async function seedLongTranscript(request: APIRequestContext, fixture: ChatFixture): Promise<void> {
  for (let index = 0; index < 36; index += 1) {
    await createMessage(
      request,
      fixture,
      "user",
      `Resize regression prompt ${String(index + 1)} with enough text to occupy the log.`,
      index * 2 + 1,
    );
    await createMessage(
      request,
      fixture,
      "assistant",
      `Resize regression answer ${String(index + 1)}.\n\n${"The chat window should retain one bounded scrollbar after a resize. ".repeat(5)}`,
      index * 2 + 2,
    );
  }
}

async function seedChatWindow(page: Page, chat: ChatResponse["chat"]): Promise<void> {
  await page.addInitScript(
    ({ chatId, title }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "e2e-chat-resize-window",
            type: "chat",
            x: 72,
            y: 48,
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

async function dragSouthResizeHandle(page: Page, deltaY: number): Promise<void> {
  const handle = page.locator('.window[data-window-id="e2e-chat-resize-window"] .wz-s');
  await expect(handle).toBeAttached();
  const box = await handle.boundingBox();
  if (box === null) throw new Error("Chat resize handle has no bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + deltaY, { steps: 8 });
  await page.mouse.up();
}

async function readScrollMetrics(page: Page): Promise<ChatScrollMetrics> {
  return page.locator('.window[data-window-id="e2e-chat-resize-window"]').evaluate((windowNode) => {
    const body = windowNode.querySelector<HTMLElement>(".win-body");
    const chat = windowNode.querySelector<HTMLElement>(".chatw-scroll");
    if (body === null || chat === null) {
      throw new Error("Chat scroll surfaces were not rendered");
    }
    chat.scrollTop = chat.scrollHeight;
    const bodyStyle = window.getComputedStyle(body);
    const chatStyle = window.getComputedStyle(chat);
    return {
      bodyOverflowY: bodyStyle.overflowY,
      bodyScrollRange: body.scrollHeight - body.clientHeight,
      chatOverflowY: chatStyle.overflowY,
      chatScrollRange: chat.scrollHeight - chat.clientHeight,
      clampedChatScrollTop: chat.scrollTop,
    };
  });
}

test.afterEach(() => {
  for (const root of tempProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chat resize keeps the outer window body clipped and the transcript scrollbar bounded", async ({
  page,
  request,
}) => {
  const fixture = await createChat(request);
  await seedLongTranscript(request, fixture);
  await seedChatWindow(page, fixture.chat);

  await page.goto("/");
  const chatWindow = page.getByRole("region", { name: "Chat — E2E chat resize" });
  await expect(chatWindow).toBeVisible();
  await expect(chatWindow.getByText("Resize regression answer 36")).toBeVisible();

  await dragSouthResizeHandle(page, -360);
  await expect
    .poll(() => readScrollMetrics(page))
    .toMatchObject({
      bodyOverflowY: "hidden",
      chatOverflowY: "auto",
    });

  const metrics = await readScrollMetrics(page);
  expect(metrics.bodyScrollRange).toBeLessThanOrEqual(1);
  expect(metrics.chatScrollRange).toBeGreaterThan(120);
  expect(metrics.clampedChatScrollTop).toBeLessThanOrEqual(metrics.chatScrollRange + 1);
});
