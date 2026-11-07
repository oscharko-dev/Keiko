import { workspaceStorageArgs } from "./support/workspace-storage.js";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

const CHAT_MODEL_ID = "e2e-chat-model";
const REPLY_MARKER = "KEIKO_M1_CERT_STREAM_OK";
const REPLY_TEXT = `${REPLY_MARKER} deterministic response.`;
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
  // #4206 corpus revision: no routine fact waits for approval, so the governed capture is accepted
  // like the others, and confidential content and personal identifiers are refused in every mode.
  "acceptance:governed:without-approval",
  "denial:health:expected",
  "denial:third-party:expected",
  "denial:secret:expected",
  "denial:confidential:expected",
  "denial:iban:expected",
  "denial:customer-identifier:expected",
  "forget:journal:shown",
  "disabled:no-capture",
] as const;

// Every refusal is the learner's or the turn guard's, recorded in the Journal under its own reason.
// The scripted model proposes each marked sentence as a fact; the product must refuse it.
const DENIED_INPUTS = [
  { reason: "denied-content", text: "M1_DENIED_HEALTH: I take my fixture medication every day." },
  { reason: "third-party", text: "M1_DENIED_THIRD_PARTY: My colleague prefers fixture tables." },
  {
    reason: "credential-shape",
    text: `Use password=${["FAKE", "M1", "SECRET", "PLACEHOLDER"].join("-")} for the fixture.`,
  },
  {
    reason: "sensitive-memory-requires-approval",
    text: "M1_DENIED_CONFIDENTIAL: I am reachable at m1.fixture@example.com.",
  },
  {
    reason: "personal-identifier",
    text: "M1_DENIED_IBAN: I pay from DE89 3704 0044 0532 0130 00.",
  },
  {
    reason: "personal-identifier",
    text: "M1_DENIED_CUSTOMER: I am customer Kundennummer 4711-0815.",
  },
] as const;

interface ChatFixture {
  readonly id: string;
  readonly title: string;
  readonly projectPath: string;
}

interface RecentCapture {
  readonly eventId: string;
  readonly outcome: "captured" | "proposed" | "auto-accepted" | "rejected" | "forgotten";
  readonly mode?: CodingWorkbenchMode;
  readonly provenance: { readonly initiatorSurface: string };
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
  acceptedWithoutApproval: number;
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
    ({ argument: { chatId, title }, storageKeys }) => {
      window.localStorage.setItem(
        storageKeys.workspace,
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
      window.localStorage.removeItem(storageKeys.connections);
    },
    await workspaceStorageArgs(page, { chatId: chat.id, title: chat.title }),
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
): Promise<RecentCapture> {
  await expect
    .poll(async () => {
      const captures = (await recent(context.request, context.since)).captures;
      return captures.some(
        (capture) =>
          capture.mode === mode &&
          capture.outcome === "auto-accepted" &&
          capture.bodyExcerpt?.includes(marker) === true,
      );
    })
    .toBe(true);
  const captures = (await recent(context.request, context.since)).captures;
  const capture = captures.find((item) => item.bodyExcerpt?.includes(marker) === true);
  if (capture === undefined) throw new Error(`Missing capture marker ${marker}`);
  return capture;
}

function recordObservedCaptures(
  metrics: MetricCounters,
  before: readonly RecentCapture[],
  after: readonly RecentCapture[],
  correctMarker: string,
): void {
  const previousEventIds = new Set(before.map(({ eventId }) => eventId));
  const emitted = after.filter(
    (capture) => capture.outcome !== "rejected" && !previousEventIds.has(capture.eventId),
  );
  metrics.totalCaptures += emitted.length;
  metrics.correctCaptures += emitted.filter(
    (capture) => capture.bodyExcerpt?.includes(correctMarker) === true,
  ).length;
  metrics.acceptedWithoutApproval += emitted.filter(
    ({ outcome }) => outcome === "auto-accepted",
  ).length;
}

async function sendMeasuredTurn(
  context: CertificationContext,
  text: string,
  marker: string,
  mode: CodingWorkbenchMode,
  metrics: MetricCounters,
): Promise<RecentCapture> {
  const before = (await recent(context.request, context.since)).captures;
  await sendTurn(context.chatWindow, text);
  const capture = await waitForCapture(context, marker, mode);
  const after = (await recent(context.request, context.since)).captures;
  recordObservedCaptures(metrics, before, after, marker);
  return capture;
}

// In Ask for approval the fact is in use without a click (#4206); forgetting it from the Journal
// deletes it and leaves a content-free Forgotten entry in its place.
async function certifyGovernedJournal(
  context: CertificationContext,
  memoryId: string,
): Promise<void> {
  const window = await openMemoryWindow(context.page);
  await window.getByRole("button", { name: "Journal", exact: true }).click();
  const row = window.locator(`[data-memory-id="${memoryId}"]`);
  // Nothing waits for review, so the row names no mode: no approval was asked for.
  await expect(row.getByText("Auto-captured")).toBeVisible();
  await expect(row.getByText("Awaiting review")).toHaveCount(0);
  await expect(row.getByText("Ask for approval")).toHaveCount(0);
  await row.getByRole("button", { name: "Forget" }).click();
  await expect
    .poll(async () => (await storedMemoryIds(context.request)).includes(memoryId))
    .toBe(false);
  await expect
    .poll(async () =>
      (await recent(context.request, context.since)).captures.some(
        (capture) => capture.outcome === "forgotten" && capture.memoryId === undefined,
      ),
    )
    .toBe(true);
  await closeMemoryWindow(context.page);
}

async function certifyModeCaptures(
  context: CertificationContext,
  metrics: MetricCounters,
): Promise<string> {
  await setMode(context.page, "governed-assist");
  const governed = await sendMeasuredTurn(
    context,
    "M1_GOVERNED_CAPTURE: I use a governed release cadence.",
    "M1_GOVERNED_CAPTURE",
    "governed-assist",
    metrics,
  );
  expect(governed.memoryId).toBeDefined();
  await certifyGovernedJournal(context, governed.memoryId ?? "");

  await setMode(context.page, "supervised-coding");
  const supervised = await sendMeasuredTurn(
    context,
    "M1_SUPERVISED_CAPTURE: I keep the certified-supervised detail in a weekly cadence.",
    "M1_SUPERVISED_CAPTURE",
    "supervised-coding",
    metrics,
  );
  expect(supervised.memoryId).toBeDefined();

  await setMode(context.page, "autonomous-delivery");
  await sendMeasuredTurn(
    context,
    "M1_AUTONOMOUS_CAPTURE: I prefer autonomous release notes.",
    "M1_AUTONOMOUS_CAPTURE",
    "autonomous-delivery",
    metrics,
  );
  return supervised.memoryId ?? "";
}

async function certifyVoicePath(
  context: CertificationContext,
  recalledMemoryId: string,
  metrics: MetricCounters,
): Promise<void> {
  const captureMarkers = [
    "M1_GOVERNED_CAPTURE",
    "M1_SUPERVISED_CAPTURE",
    "M1_AUTONOMOUS_CAPTURE",
    "M1_VOICE_CAPTURE",
  ] as const;
  const before = (await recent(context.request, context.since)).captures;
  const countMarker = (captures: readonly RecentCapture[], marker: string): number =>
    captures.filter((capture) => capture.bodyExcerpt?.includes(marker) === true).length;
  // Realtime Voice never routes its transcript through the control socket (voice-realtime.ts): a
  // settled spoken final is answered by this same canonical chat request. What makes THIS a voice
  // certification rather than a second desktop one is `memory.surface` — the origin the UI's
  // canonical-voice delivery declares (#2550). Without it the server cannot tell the surfaces apart
  // and every voice capture is filed as desktop, so asserting the surface below is the whole point.
  const response = await context.request.post("/api/desktop/chat", {
    headers: MUTATION_HEADERS,
    data: {
      chatId: context.chat.id,
      projectPath: context.chat.projectPath,
      content:
        "Recall the certified-supervised detail. M1_VOICE_CAPTURE: I prefer voice-first summaries.",
      memory: {
        enabled: true,
        mode: "autonomous-delivery",
        surface: "voice",
        budgetTokens: 1_200,
        context: {},
      },
    },
  });
  expect(response.ok(), await response.text().catch(() => "")).toBe(true);
  const body = (await response.json()) as {
    readonly messages: readonly { readonly role: string; readonly content: string }[];
    readonly memory?: { readonly context: { readonly memories: readonly { memoryId: string }[] } };
  };
  expect(body.memory?.context.memories.map(({ memoryId }) => memoryId)).toContain(recalledMemoryId);
  expect(body.messages.find(({ role }) => role === "assistant")?.content).toBe(REPLY_TEXT);
  const voiceCapture = await waitForCapture(context, "M1_VOICE_CAPTURE", "autonomous-delivery");
  // The decisive assertion: the spoken turn is attributed to Voice, so the Journal can show what was
  // learned during voice and offer one-click forget on exactly those rows.
  expect(voiceCapture.provenance.initiatorSurface).toBe("voice");
  const after = (await recent(context.request, context.since)).captures;
  assertTypedTurnsUnchangedAndDesktopAttributed(before, after, captureMarkers.slice(0, -1));
  expect(countMarker(after, "M1_VOICE_CAPTURE") - countMarker(before, "M1_VOICE_CAPTURE")).toBe(1);
  recordObservedCaptures(metrics, before, after, "M1_VOICE_CAPTURE");
}

// The voice turn must add exactly one capture without disturbing the typed ones, and every capture
// that is NOT the voice one must stay on the desktop surface — proving the two surfaces remain
// distinguishable in both directions rather than the run simply relabelling everything as voice.
//
// The desktop side is asserted over what the projection actually returns, not marker by marker:
// certifyGovernedJournal deliberately forgets the governed-assist capture, and M1.2's monotonic
// forgotten-suppression then correctly drops that decision from the recent view. A per-marker lookup
// would find nothing for it and mistake correct suppression for a missing attribution. The
// non-emptiness assertion keeps this from passing vacuously.
function assertTypedTurnsUnchangedAndDesktopAttributed(
  before: readonly RecentCapture[],
  after: readonly RecentCapture[],
  typedMarkers: readonly string[],
): void {
  const countMarker = (captures: readonly RecentCapture[], marker: string): number =>
    captures.filter((capture) => capture.bodyExcerpt?.includes(marker) === true).length;
  for (const marker of typedMarkers) {
    expect(countMarker(after, marker)).toBe(countMarker(before, marker));
  }
  // A person's forget (#4206) is a record-free Journal entry derived by the vault, not a turn
  // capture, so it carries no turn surface.
  const desktop = after.filter(
    (capture) =>
      capture.outcome !== "forgotten" && capture.bodyExcerpt?.includes("M1_VOICE_CAPTURE") !== true,
  );
  expect(desktop.length).toBeGreaterThan(0);
  expect(desktop.map((capture) => capture.provenance.initiatorSurface)).toEqual(
    desktop.map(() => "conversation-center"),
  );
}

async function certifyCorrectionMetrics(
  context: CertificationContext,
  metrics: MetricCounters,
): Promise<void> {
  const samples = [
    {
      marker: "M1_REPEAT_CORRECTION",
      text: "M1_REPEAT_CORRECTION: I run the nightly build on Mondays.",
      repeated: true,
    },
    {
      marker: "M1_FIRST_CORRECTION",
      text: "M1_FIRST_CORRECTION: I sign every release tag.",
      repeated: false,
    },
  ] as const;
  for (const sample of samples) {
    await sendMeasuredTurn(context, sample.text, sample.marker, "autonomous-delivery", metrics);
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
    .filter({ has: context.page.locator('[data-reason="denied-content"]') })
    .first();
  await expect(row).toHaveAttribute("data-outcome", "rejected");
  await expect(row).not.toHaveAttribute("data-memory-id");
  await expect(row.getByText("Capture refused by policy. No content was retained.")).toBeVisible();
  await expect(row.getByText("Refused", { exact: true })).toBeVisible();
  // A person reads why, not a policy code.
  await expect(row.getByText("Why: It touched a protected topic, such as health.")).toBeVisible();
  await expect(row).not.toContainText("denied-content");
  await expect(row.getByRole("button")).toHaveCount(0);
  const voiceRow = window
    .getByTestId("memory-journal-row")
    .filter({ hasText: "M1_VOICE_CAPTURE" })
    .first();
  await expect(voiceRow.getByText("Surface Voice")).toBeVisible();
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
| Approval-free acceptance |         ${String(metrics.acceptedWithoutApproval)} |           ${String(metrics.totalCaptures)} |   ${rate(metrics.acceptedWithoutApproval, metrics.totalCaptures)} |
| Capture precision        |         ${String(metrics.correctCaptures)} |           ${String(metrics.totalCaptures)} |   ${rate(metrics.correctCaptures, metrics.totalCaptures)} |

## Measurement contract for M8

- Repeated-correction rate = corrective turns that repeat a correction to an already captured fact divided by all labeled corrective turns.
- Approval-free acceptance = captures accepted without a review step divided by all captures emitted by the labeled corpus, in every mode (#4206).
- Capture precision = captures labeled correct divided by all captures emitted by the labeled corpus.
- M8 must rerun the same labels and denominator rules, report counts plus four-decimal rates, and compare against this corpus hash or document an intentional corpus revision.

## Content-safety contract

This evidence contains only metric names, counts, rates, and a hash of content-free labels. It contains no memory body, rejected utterance, secret, endpoint, customer identifier, or personal data.
`;
}

function verifyCommittedBaseline(metrics: MetricCounters): void {
  expect(metrics).toEqual({
    correctCaptures: 6,
    totalCaptures: 6,
    acceptedWithoutApproval: 6,
    repeatedCorrectionTurns: 1,
    totalCorrectiveTurns: 2,
  });
  const generated = renderBaseline(metrics);
  const committed = readFileSync(BASELINE_PATH, "utf8");
  // Compare only — never write here. Writing before the assertion would let a genuinely drifted
  // baseline self-heal on the very run that should catch the drift, defeating the guard: the first
  // run fails correctly, but the file is already rewritten by then, so a rerun reads the new
  // content and passes. Regenerate deliberately (docs/qa/memoriaviva-m1-baseline.md's own
  // instructions) when the metrics genuinely change; never let the test do it silently.
  expect(committed).toBe(generated);
  for (const input of DENIED_INPUTS) expect(generated).not.toContain(input.text);
  expect(generated).not.toMatch(/\bpassword\s*=/iu);
  expect(generated).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu);
  expect(generated).not.toMatch(/\bDE89\b|Kundennummer/u);
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
    acceptedWithoutApproval: 0,
    repeatedCorrectionTurns: 0,
    totalCorrectiveTurns: 0,
  };
  const supervisedMemoryId = await certifyModeCaptures(context, metrics);
  await certifyVoicePath(context, supervisedMemoryId, metrics);
  await certifyCorrectionMetrics(context, metrics);
  await certifyModeIndependentDenials(context);
  await certifyDisabledPath(context);
  await certifyContentFreeJournalRefusal(context);
  verifyCommittedBaseline(metrics);
});
