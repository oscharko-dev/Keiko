import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHAT_MODEL_ID = "e2e-chat-model";
const REPLY_MARKER = "KEIKO_E2E_STREAM_OK";
const CAPTURE_MARKER = "KEIKO_E2E_JOURNAL_CAPTURE";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const temporaryProjects: string[] = [];

interface ChatResponse {
  readonly chat: { readonly id: string; readonly title: string };
}

interface RecentCapture {
  readonly outcome: "captured" | "proposed" | "auto-accepted" | "rejected";
  readonly occurredAt: number;
  readonly memoryId?: string;
}

interface RecentResponse {
  readonly captures: readonly RecentCapture[];
}

function createProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-memory-journal-"));
  temporaryProjects.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Memory Journal smoke fixture\n", "utf8");
  return root;
}

async function createChat(
  request: APIRequestContext,
): Promise<{ readonly chat: ChatResponse["chat"]; readonly projectPath: string }> {
  const projectPath = createProjectFixture();
  const project = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: projectPath, name: "Memory Journal E2E" },
  });
  expect(project.ok(), await project.text().catch(() => "")).toBe(true);
  const response = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: { projectPath, title: "Memory Journal E2E", selectedModel: CHAT_MODEL_ID },
  });
  expect(response.status(), await response.text().catch(() => "")).toBe(201);
  const created = (await response.json()) as ChatResponse;
  return { chat: created.chat, projectPath };
}

async function seedChatWindow(page: Page, chat: ChatResponse["chat"]): Promise<void> {
  await page.addInitScript(
    ({ chatId, title }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "memory-journal-chat",
            type: "chat",
            x: 42,
            y: 36,
            w: 900,
            h: 780,
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

async function sendTurn(chatWindow: Locator, text: string): Promise<void> {
  const replies = chatWindow.getByText(new RegExp(REPLY_MARKER));
  const previousCount = await replies.count();
  const composer = chatWindow.getByRole("textbox", { name: "Chat message" });
  await composer.fill(text);
  await chatWindow.getByRole("button", { name: "Send message" }).click();
  await expect(replies).toHaveCount(previousCount + 1, { timeout: 30_000 });
}

async function fetchRecent(request: APIRequestContext, since: number): Promise<RecentResponse> {
  const params = new URLSearchParams({ since: String(since), order: "desc" });
  const response = await request.get(`/api/memory?${params.toString()}`);
  expect(response.ok(), await response.text().catch(() => "")).toBe(true);
  return (await response.json()) as RecentResponse;
}

function persistedCaptures(response: RecentResponse): readonly RecentCapture[] {
  return response.captures.filter(
    (capture) => capture.outcome !== "rejected" && capture.memoryId !== undefined,
  );
}

async function expectPersistedCount(
  request: APIRequestContext,
  since: number,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => persistedCaptures(await fetchRecent(request, since)).length, {
      timeout: 15_000,
    })
    .toBe(count);
}

async function openMemoryWindow(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "MemoriaViva" }).click();
  const window = page.getByRole("region", { name: "MemoriaViva" });
  await expect(window.getByRole("heading", { name: "MemoriaViva" })).toBeVisible();
  return window;
}

async function retrieveMemoryIds(
  request: APIRequestContext,
  chat: ChatResponse["chat"],
  projectPath: string,
): Promise<readonly string[]> {
  const response = await request.post("/api/memory/context", {
    headers: MUTATION_HEADERS,
    data: {
      projectPath,
      chatId: chat.id,
      queryText: "deterministic release windows",
      budgetTokens: 1_200,
    },
  });
  expect(response.ok(), await response.text().catch(() => "")).toBe(true);
  const body = (await response.json()) as {
    readonly included: readonly { readonly memoryId: string }[];
  };
  return body.included.map(({ memoryId }) => memoryId);
}

interface JournalJourneyContext {
  readonly page: Page;
  readonly request: APIRequestContext;
  readonly chatWindow: Locator;
  readonly chat: ChatResponse["chat"];
  readonly projectPath: string;
  readonly since: number;
}

async function exerciseDeniedCaptures(context: JournalJourneyContext): Promise<void> {
  let memoryWindow = await openMemoryWindow(context.page);
  const memorySwitch = memoryWindow.getByRole("switch", {
    name: "Use MemoriaViva in chat requests",
  });
  await memorySwitch.click();
  await expect(memorySwitch).toHaveAttribute("aria-checked", "false");
  await context.page.getByRole("button", { name: "Close MemoriaViva window" }).click();
  await sendTurn(context.chatWindow, "This disabled-memory turn must not create a Journal entry.");
  await expectPersistedCount(context.request, context.since, 0);

  memoryWindow = await openMemoryWindow(context.page);
  await memoryWindow.getByRole("button", { name: "Journal", exact: true }).click();
  await expect(memoryWindow.getByTestId("memory-journal-empty")).toBeVisible();
  await expect(memoryWindow.getByRole("status")).toHaveCount(1);
  await memoryWindow.getByRole("button", { name: "Back" }).click();
  await memoryWindow.getByRole("switch", { name: "Use MemoriaViva in chat requests" }).click();
  await context.page.getByRole("button", { name: "Close MemoriaViva window" }).click();

  await sendTurn(
    context.chatWindow,
    "Use password=FAKE-JOURNAL-SECRET-PLACEHOLDER for this fixture.",
  );
  await expectPersistedCount(context.request, context.since, 0);
}

async function captureAndOpenJournal(
  context: JournalJourneyContext,
): Promise<{ readonly memoryId: string; readonly memoryWindow: Locator; readonly row: Locator }> {
  await sendTurn(
    context.chatWindow,
    `${CAPTURE_MARKER}: remember the deterministic release window.`,
  );
  await expectPersistedCount(context.request, context.since, 1);
  const recent = await fetchRecent(context.request, context.since);
  const memoryId = persistedCaptures(recent)[0]?.memoryId;
  expect(memoryId).toBeDefined();

  const memoryWindow = await openMemoryWindow(context.page);
  await memoryWindow.getByRole("button", { name: "Journal", exact: true }).click();
  const rows = memoryWindow.getByTestId("memory-journal-row");
  // Two rows: the just-captured proposal, plus a content-free "Refused" row for the earlier
  // secret-content turn from exerciseDeniedCaptures() — #2551 made denied/secret captures
  // visible-but-content-free in the Journal for transparency (certified by
  // tests/e2e/memoriaviva-m1-certification.spec.ts's certifyContentFreeJournalRefusal), so a
  // refused turn is no longer literally absent from the Journal, only its content is withheld.
  await expect(rows).toHaveCount(2);
  const row = memoryWindow.locator(
    `[data-testid="memory-journal-row"][data-memory-id="${memoryId ?? ""}"]`,
  );
  await expect(row).toHaveAttribute("data-memory-id", memoryId ?? "");
  await expect(row.getByText("Ask for approval")).toBeVisible();
  await expect(row.getByText("Awaiting review")).toBeVisible();
  await expect(row.getByText(/^Capture reason /)).toBeVisible();
  const refusedRow = rows.filter({ hasNotText: "Awaiting review" });
  await expect(refusedRow).toHaveCount(1);
  await expect(refusedRow.getByText("Refused", { exact: true })).toBeVisible();
  await expect(
    refusedRow.getByText("Capture refused by policy. No content was retained."),
  ).toBeVisible();
  return { memoryId: memoryId ?? "", memoryWindow, row };
}

async function keepCapture(
  context: JournalJourneyContext,
  memoryId: string,
  row: Locator,
): Promise<void> {
  const keep = row.getByRole("button", { name: "Keep" });
  await keep.click();
  await expect(keep).toHaveAttribute("aria-pressed", "true");
  await expect(row.getByText("Kept")).toBeVisible();
  await expect
    .poll(async () => retrieveMemoryIds(context.request, context.chat, context.projectPath))
    .toContain(memoryId);
}

async function exerciseFailedForget(
  page: Page,
  memoryWindow: Locator,
  row: Locator,
  memoryId: string,
): Promise<Locator> {
  const forgetUrl = `**/api/memory/${encodeURIComponent(memoryId)}/forget`;
  await page.route(forgetUrl, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL", message: "redacted" } }),
    });
  });
  const forget = row.getByRole("button", { name: "Forget" });
  await forget.click();
  await expect(memoryWindow.getByRole("alert")).toContainText("could not be forgotten");
  await expect(row).toBeVisible();
  await expect(forget).toBeFocused();
  await page.unroute(forgetUrl);
  return forget;
}

async function completeForget(
  context: JournalJourneyContext,
  memoryWindow: Locator,
  forget: Locator,
  memoryId: string,
): Promise<void> {
  await forget.click();
  // The kept capture's row is removed, but the content-free "Refused" row from the earlier
  // secret-content turn was never persisted (no memoryId), so it is not affected by this Forget
  // and remains — one row, not the empty state. Focus moves to that remaining row, not the
  // heading (the heading is only focused when the list becomes fully empty).
  const rows = memoryWindow.getByTestId("memory-journal-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByText("Refused", { exact: true })).toBeVisible();
  await expect(rows).toBeFocused();
  await expect(memoryWindow.getByRole("status")).toContainText("Memory forgotten");
  await expect
    .poll(async () => persistedCaptures(await fetchRecent(context.request, context.since)).length)
    .toBe(0);
  await expect
    .poll(async () => retrieveMemoryIds(context.request, context.chat, context.projectPath))
    .not.toContain(memoryId);
}

test.afterEach(() => {
  for (const root of temporaryProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test.use({ viewport: { width: 1440, height: 1000 } });

test("disabled capture stays empty; secret input stays absent; a captured proposal is newest and legible; Keep promotes it; failed Forget is closed; successful Forget removes it from Journal and retrieval @smoke", async ({
  page,
  request,
}) => {
  const since = Date.now() - 1_000;
  const { chat, projectPath } = await createChat(request);
  await seedChatWindow(page, chat);
  await page.goto("/");
  const chatWindow = page.getByRole("region", { name: "Chat — Memory Journal E2E" });
  await expect(chatWindow).toBeVisible();
  const context = { page, request, chatWindow, chat, projectPath, since };
  await exerciseDeniedCaptures(context);
  const { memoryId, memoryWindow, row } = await captureAndOpenJournal(context);
  await keepCapture(context, memoryId, row);
  const forget = await exerciseFailedForget(page, memoryWindow, row, memoryId);
  await completeForget(context, memoryWindow, forget, memoryId);
});
