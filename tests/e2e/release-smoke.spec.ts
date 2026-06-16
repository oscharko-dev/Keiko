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
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();
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
  // The chat window exposes its name via the section's aria-label, not a heading.
  await expect(page.getByRole("region", { name: "Chat — E2E grounded chat" })).toBeVisible();
  const grounding = page.getByLabel("Grounding mode");
  await expect(grounding).toBeVisible();
  await expect(grounding).toHaveValue("files");
  await expect(grounding.locator("option:checked")).toHaveText("Live Files context");
  await expect(page.getByRole("textbox", { name: "Chat message" })).toBeVisible();

  assertNoPageErrors();
});

async function seedTwoWindows(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "bg-agents",
          type: "agents",
          x: 96,
          y: 72,
          w: 360,
          h: 300,
          z: 1,
          cfg: {},
          max: false,
        },
        {
          id: "active-agents",
          type: "agents",
          x: 520,
          y: 120,
          w: 360,
          h: 300,
          z: 5,
          cfg: {},
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  });
}

// Regression for #1153: the Workspace outline panel is collapsed by default and
// was revealed only on :focus-within. A pointer user clicking a per-window
// action button while the panel was collapsed hit pointer-events:none and the
// click fell through to the canvas — window state never changed. jsdom ignores
// pointer-events, so only a real browser catches this; hence this e2e is the
// primary regression.
test("pointer user can open the outline and act on a background window @smoke", async ({
  page,
}) => {
  const assertNoPageErrors = collectPageErrors(page);
  await seedTwoWindows(page);

  await page.goto("/");

  const surface = page.getByRole("main", { name: "Workspace surface" });
  await expect(surface.locator('[data-window-id="bg-agents"]')).toBeVisible();
  await expect(surface.locator('[data-window-id="active-agents"]')).toBeVisible();

  // Open the outline via its visible toggle affordance using a real mouse.
  await page.getByRole("button", { name: "Show workspace outline" }).click();
  const outline = page.getByRole("region", { name: "Workspace outline" });
  await expect(outline).toBeVisible();

  // Close the BACKGROUND window from the outline with a real pointer click.
  // Pre-fix this click falls through to the canvas and the window stays.
  await outline.getByRole("button", { name: "Close Agents" }).first().click();

  await expect(surface.locator('[data-window-id="bg-agents"]')).toHaveCount(0);
  await expect(surface.locator('[data-window-id="active-agents"]')).toBeVisible();

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
