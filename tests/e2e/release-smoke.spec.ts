import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function collectPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
    throw new Error(`Project setup failed (${String(response.status())}): ${await response.text()}`);
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
    throw new Error(`16-source setup failed (${String(atLimit.status())}): ${await atLimit.text()}`);
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

test("app start exposes the workspace shell and health endpoint @smoke", async ({
  page,
  request,
}) => {
  const assertNoPageErrors = collectPageErrors(page);

  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  await expect(health.json()).resolves.toMatchObject({ status: "ok" });

  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Primary workspace navigation" })).toBeVisible();
  await expect(page.getByText("Keiko").first()).toBeVisible();
  await expect(page.locator(".header .hd-tool-cta")).toBeVisible();
  await expect(page.getByLabel(/Keiko version/u)).toBeVisible();

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
  await expect(grounding).toHaveValue("files");
  await expect(grounding.locator("option:checked")).toHaveText("Live Files context");
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
