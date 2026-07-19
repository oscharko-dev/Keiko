import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

const CHAT_MODEL_ID = "e2e-chat-model";
const REPLY_MARKER = "KEIKO_M1_CERT_STREAM_OK";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const BASELINE_PATH = join(process.cwd(), "docs", "qa", "memoriaviva-m1-baseline.md");
const temporaryProjects: string[] = [];

const MODE_LABELS: Readonly<Record<CodingWorkbenchMode, string>> = {
  "governed-assist": "Ask for approval",
  "supervised-coding": "Supervised workspace",
  "autonomous-delivery": "Full access",
};

const METRIC_CORPUS_LABELS = [
  "capture:governed:correct",
  "capture:supervised:correct",
  "capture:autonomous:correct",
  "capture:voice:correct",
  "capture:correction-repeat:correct",
  "capture:correction-first:correct",
  "proposal:governed:accepted",
  "denial:health:expected",
  "denial:third-party:expected",
  "denial:secret:expected",
  "disabled:no-capture",
] as const;

const DENIED_INPUTS = [
  { reason: "denied-category", text: "The fixture medical record changed this week." },
  { reason: "denied-category", text: "My colleague is moving to another fixture team." },
  {
    reason: "credential-shape",
    text: `Use password=${["FAKE", "M1", "SECRET", "PLACEHOLDER"].join("-")} for the fixture.`,
  },
] as const;

interface ChatFixture {
  readonly id: string;
  readonly title: string;
  readonly projectPath: string;
}

interface RecentCapture {
  readonly outcome: "captured" | "proposed" | "auto-accepted" | "rejected";
  readonly mode?: CodingWorkbenchMode;
  readonly reason: string;
  readonly memoryId?: string;
  readonly bodyExcerpt?: string;
}

interface RecentResponse {
  readonly captures: readonly RecentCapture[];
  readonly total: number;
}

interface CertificationContext {
  readonly page: Page;
  readonly request: APIRequestContext;
  readonly chat: ChatFixture;
  readonly chatWindow: Locator;
  readonly since: number;
}

interface MetricCounters {
  correctCaptures: number;
  totalCaptures: number;
  acceptedProposals: number;
  totalProposals: number;
  repeatedCorrectionTurns: number;
  totalCorrectiveTurns: number;
}

function createProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-m1-certification-"));
  temporaryProjects.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# MemoriaViva M1 certification fixture\n", "utf8");
  return root;
}

async function createChat(request: APIRequestContext): Promise<ChatFixture> {
  const projectPath = createProjectFixture();
  const project = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: projectPath, name: "MemoriaViva M1 certification" },
  });
  expect(project.ok(), await project.text().catch(() => "")).toBe(true);
  const response = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: { projectPath, title: "MemoriaViva M1 certification", selectedModel: CHAT_MODEL_ID },
  });
  expect(response.status(), await response.text().catch(() => "")).toBe(201);
  const body = (await response.json()) as { readonly chat: { id: string; title: string } };
  return { ...body.chat, projectPath };
}

async function seedChatWindow(page: Page, chat: ChatFixture): Promise<void> {
  await page.addInitScript(
    ({ chatId, title }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "m1-certification-chat",
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

async function setupContext(page: Page, request: APIRequestContext): Promise<CertificationContext> {
  const since = Date.now() - 1_000;
  const chat = await createChat(request);
  await seedChatWindow(page, chat);
  await page.goto("/");
  const chatWindow = page.getByRole("region", { name: `Chat — ${chat.title}` });
  await expect(chatWindow).toBeVisible();
  return { page, request, chat, chatWindow, since };
}

async function openMemoryWindow(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "MemoriaViva" }).click();
  const window = page.getByRole("region", { name: "MemoriaViva" });
  await expect(window.getByRole("heading", { name: "MemoriaViva" })).toBeVisible();
  return window;
}

async function closeMemoryWindow(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close MemoriaViva window" }).click();
}

async function setMode(page: Page, mode: CodingWorkbenchMode): Promise<void> {
  const window = await openMemoryWindow(page);
  const radio = window.getByRole("radio", { name: MODE_LABELS[mode] });
  await expect(radio).toBeEnabled();
  await radio.click();
  const persistedRadio = window.getByRole("radio", { name: MODE_LABELS[mode] });
  await expect(persistedRadio).toBeChecked();
  await expect(persistedRadio).toBeEnabled();
  await closeMemoryWindow(page);
}

async function setMemoryEnabled(page: Page, enabled: boolean): Promise<void> {
  const window = await openMemoryWindow(page);
  const control = window.getByRole("switch", { name: "Use MemoriaViva in chat requests" });
  const current = (await control.getAttribute("aria-checked")) === "true";
  if (current !== enabled) await control.click();
  await expect(control).toHaveAttribute("aria-checked", String(enabled));
  await closeMemoryWindow(page);
}

async function sendTurn(chatWindow: Locator, text: string): Promise<void> {
  const replies = chatWindow.getByText(new RegExp(REPLY_MARKER));
  const previousCount = await replies.count();
  const composer = chatWindow.getByRole("textbox", { name: "Chat message" });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(replies).toHaveCount(previousCount + 1, { timeout: 30_000 });
}

async function recent(request: APIRequestContext, since: number): Promise<RecentResponse> {
  const response = await request.get(`/api/memory?since=${String(since)}&order=desc&limit=200`);
  expect(response.ok(), await response.text().catch(() => "")).toBe(true);
  return (await response.json()) as RecentResponse;
}

async function storedMemoryIds(request: APIRequestContext): Promise<readonly string[]> {
  const response = await request.get("/api/memory?limit=200&offset=0");
  expect(response.ok(), await response.text().catch(() => "")).toBe(true);
  const body = (await response.json()) as { readonly memories: readonly { readonly id: string }[] };
  return body.memories.map(({ id }) => id);
}

async function waitForCapture(
  context: CertificationContext,
  marker: string,
  mode: CodingWorkbenchMode,
  outcome: "proposed" | "auto-accepted",
): Promise<RecentCapture> {
  await expect
    .poll(async () => {
      const captures = (await recent(context.request, context.since)).captures;
      return captures.some(
        (capture) =>
          capture.mode === mode &&
          capture.outcome === outcome &&
          capture.bodyExcerpt?.includes(marker) === true,
      );
    })
    .toBe(true);
  const captures = (await recent(context.request, context.since)).captures;
  const capture = captures.find((item) => item.bodyExcerpt?.includes(marker) === true);
  if (capture === undefined) throw new Error(`Missing capture marker ${marker}`);
  return capture;
}

function recordCorrectCapture(metrics: MetricCounters): void {
  metrics.correctCaptures += 1;
  metrics.totalCaptures += 1;
}

async function certifyGovernedJournal(
  context: CertificationContext,
  memoryId: string,
  metrics: MetricCounters,
): Promise<void> {
  const window = await openMemoryWindow(context.page);
  await window.getByRole("button", { name: "Journal", exact: true }).click();
  const row = window.locator(`[data-memory-id="${memoryId}"]`);
  await expect(row.getByText("Ask for approval")).toBeVisible();
  await expect(row.getByText("Awaiting review")).toBeVisible();
  await row.getByRole("button", { name: "Keep" }).click();
  await expect(row.getByText("Kept")).toBeVisible();
  metrics.acceptedProposals += 1;
  await row.getByRole("button", { name: "Forget" }).click();
  await expect
    .poll(async () => (await storedMemoryIds(context.request)).includes(memoryId))
    .toBe(false);
  await closeMemoryWindow(context.page);
}

async function certifyModeCaptures(
  context: CertificationContext,
  metrics: MetricCounters,
): Promise<string> {
  await setMode(context.page, "governed-assist");
  await sendTurn(
    context.chatWindow,
    "M1_GOVERNED_CAPTURE establishes the fixture release cadence.",
  );
  const governed = await waitForCapture(
    context,
    "M1_GOVERNED_CAPTURE",
    "governed-assist",
    "proposed",
  );
  expect(governed.memoryId).toBeDefined();
  recordCorrectCapture(metrics);
  metrics.totalProposals += 1;
  await certifyGovernedJournal(context, governed.memoryId ?? "", metrics);

  await setMode(context.page, "supervised-coding");
  await sendTurn(
    context.chatWindow,
    "M1_SUPERVISED_CAPTURE establishes the certified-supervised detail.",
  );
  const supervised = await waitForCapture(
    context,
    "M1_SUPERVISED_CAPTURE",
    "supervised-coding",
    "auto-accepted",
  );
  expect(supervised.memoryId).toBeDefined();
  recordCorrectCapture(metrics);

  await setMode(context.page, "autonomous-delivery");
  await sendTurn(context.chatWindow, "M1_AUTONOMOUS_CAPTURE establishes a silent-learn fact.");
  await waitForCapture(context, "M1_AUTONOMOUS_CAPTURE", "autonomous-delivery", "auto-accepted");
  recordCorrectCapture(metrics);
  return supervised.memoryId ?? "";
}

async function certifyVoicePath(
  context: CertificationContext,
  recalledMemoryId: string,
  metrics: MetricCounters,
): Promise<void> {
  const response = await context.request.post("/api/desktop/chat/voice-turn", {
    headers: MUTATION_HEADERS,
    data: {
      chatId: context.chat.id,
      projectPath: context.chat.projectPath,
      messages: [
        {
          role: "user",
          content: "Recall the certified-supervised detail, then note M1_VOICE_CAPTURE.",
        },
        {
          role: "assistant",
          content: "The prior memory was recalled and the voice turn committed.",
        },
      ],
      memory: { enabled: true, mode: "autonomous-delivery", budgetTokens: 1_200, context: {} },
    },
  });
  expect(response.ok(), await response.text().catch(() => "")).toBe(true);
  const body = (await response.json()) as {
    readonly memory?: { readonly context: { readonly memories: readonly { memoryId: string }[] } };
  };
  expect(body.memory?.context.memories.map(({ memoryId }) => memoryId)).toContain(recalledMemoryId);
  await waitForCapture(context, "M1_VOICE_CAPTURE", "autonomous-delivery", "auto-accepted");
  recordCorrectCapture(metrics);
}

async function certifyCorrectionMetrics(
  context: CertificationContext,
  metrics: MetricCounters,
): Promise<void> {
  const samples = [
    {
      marker: "M1_REPEAT_CORRECTION",
      text: "The fixture repeats a correction to an existing detail. M1_REPEAT_CORRECTION",
      repeated: true,
    },
    {
      marker: "M1_FIRST_CORRECTION",
      text: "The fixture supplies a first correction to a build detail. M1_FIRST_CORRECTION",
      repeated: false,
    },
  ] as const;
  for (const sample of samples) {
    await sendTurn(context.chatWindow, sample.text);
    await waitForCapture(context, sample.marker, "autonomous-delivery", "auto-accepted");
    recordCorrectCapture(metrics);
    metrics.totalCorrectiveTurns += 1;
    if (sample.repeated) metrics.repeatedCorrectionTurns += 1;
  }
}

async function rejectedCount(
  context: CertificationContext,
  mode: CodingWorkbenchMode,
  reason: string,
): Promise<number> {
  return (await recent(context.request, context.since)).captures.filter(
    (capture) =>
      capture.outcome === "rejected" && capture.mode === mode && capture.reason === reason,
  ).length;
}

async function sendAndAwaitRejection(
  context: CertificationContext,
  mode: CodingWorkbenchMode,
  input: (typeof DENIED_INPUTS)[number],
): Promise<void> {
  const before = await rejectedCount(context, mode, input.reason);
  await sendTurn(context.chatWindow, input.text);
  await expect.poll(() => rejectedCount(context, mode, input.reason)).toBe(before + 1);
}

async function certifyModeIndependentDenials(context: CertificationContext): Promise<void> {
  const before = await storedMemoryIds(context.request);
  const modes: readonly CodingWorkbenchMode[] = [
    "governed-assist",
    "supervised-coding",
    "autonomous-delivery",
  ];
  for (const mode of modes) {
    await setMode(context.page, mode);
    for (const input of DENIED_INPUTS) await sendAndAwaitRejection(context, mode, input);
  }
  expect(await storedMemoryIds(context.request)).toEqual(before);
}

async function certifyDisabledPath(context: CertificationContext): Promise<void> {
  await setMemoryEnabled(context.page, false);
  const beforeRecent = await recent(context.request, context.since);
  const beforeStored = await storedMemoryIds(context.request);
  await sendTurn(context.chatWindow, "M1_DISABLED_CAPTURE must remain absent.");
  expect(await recent(context.request, context.since)).toEqual(beforeRecent);
  expect(await storedMemoryIds(context.request)).toEqual(beforeStored);
  await setMemoryEnabled(context.page, true);
}

async function certifyContentFreeJournalRefusal(context: CertificationContext): Promise<void> {
  const window = await openMemoryWindow(context.page);
  await window.getByRole("button", { name: "Journal", exact: true }).click();
  const row = window
    .getByTestId("memory-journal-row")
    .filter({ hasText: "Capture reason denied-category" })
    .first();
  await expect(row).toHaveAttribute("data-outcome", "rejected");
  await expect(row).not.toHaveAttribute("data-memory-id");
  await expect(row.getByText("Capture refused by policy. No content was retained.")).toBeVisible();
  await expect(row.getByText("Refused", { exact: true })).toBeVisible();
  await expect(row.getByRole("button")).toHaveCount(0);
  for (const input of DENIED_INPUTS) await expect(row).not.toContainText(input.text);
  await closeMemoryWindow(context.page);
}

function rate(numerator: number, denominator: number): string {
  return denominator === 0 ? "0.0000" : (numerator / denominator).toFixed(4);
}

function renderBaseline(metrics: MetricCounters): string {
  const corpusHash = createHash("sha256").update(METRIC_CORPUS_LABELS.join("\n")).digest("hex");
  return `# MemoriaViva M1 learning-metric baseline

Recorded by \`npm run test:e2e:memoriaviva-m1\` from the deterministic, labeled M1 certification corpus. The corpus identity is content-free: \`sha256:${corpusHash}\`.

| Metric                   | Numerator | Denominator | Baseline |
| ------------------------ | --------: | ----------: | -------: |
| Repeated-correction rate |         ${String(metrics.repeatedCorrectionTurns)} |           ${String(metrics.totalCorrectiveTurns)} |   ${rate(metrics.repeatedCorrectionTurns, metrics.totalCorrectiveTurns)} |
| Proposal-acceptance rate |         ${String(metrics.acceptedProposals)} |           ${String(metrics.totalProposals)} |   ${rate(metrics.acceptedProposals, metrics.totalProposals)} |
| Capture precision        |         ${String(metrics.correctCaptures)} |           ${String(metrics.totalCaptures)} |   ${rate(metrics.correctCaptures, metrics.totalCaptures)} |

## Measurement contract for M8

- Repeated-correction rate = corrective turns that repeat a correction to an already captured fact divided by all labeled corrective turns.
- Proposal-acceptance rate = accepted proposals divided by all proposals emitted by the labeled corpus.
- Capture precision = captures labeled correct divided by all captures emitted by the labeled corpus.
- M8 must rerun the same labels and denominator rules, report counts plus four-decimal rates, and compare against this corpus hash or document an intentional corpus revision.

## Content-safety contract

This evidence contains only metric names, counts, rates, and a hash of content-free labels. It contains no memory body, rejected utterance, secret, endpoint, customer identifier, or personal data.
`;
}

function writeAndVerifyBaseline(metrics: MetricCounters): void {
  expect(metrics).toEqual({
    correctCaptures: 6,
    totalCaptures: 6,
    acceptedProposals: 1,
    totalProposals: 1,
    repeatedCorrectionTurns: 1,
    totalCorrectiveTurns: 2,
  });
  const generated = renderBaseline(metrics);
  const committed = readFileSync(BASELINE_PATH, "utf8");
  writeFileSync(BASELINE_PATH, generated, "utf8");
  expect(committed).toBe(generated);
  for (const input of DENIED_INPUTS) expect(generated).not.toContain(input.text);
  expect(generated).not.toMatch(/\bpassword\s*=/iu);
  expect(generated).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu);
}

test.afterEach(() => {
  for (const root of temporaryProjects.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("certifies the real default-on M1 chat, voice, Journal, denial, forget, and metric paths", async ({
  page,
  request,
}) => {
  const context = await setupContext(page, request);
  const metrics: MetricCounters = {
    correctCaptures: 0,
    totalCaptures: 0,
    acceptedProposals: 0,
    totalProposals: 0,
    repeatedCorrectionTurns: 0,
    totalCorrectiveTurns: 0,
  };
  const supervisedMemoryId = await certifyModeCaptures(context, metrics);
  await certifyVoicePath(context, supervisedMemoryId, metrics);
  await certifyCorrectionMetrics(context, metrics);
  await certifyModeIndependentDenials(context);
  await certifyDisabledPath(context);
  await certifyContentFreeJournalRefusal(context);
  writeAndVerifyBaseline(metrics);
});
