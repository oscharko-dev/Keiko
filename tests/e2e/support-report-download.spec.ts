import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeSupportReport,
  type AnalyzedSupportReport,
} from "@oscharko-dev/keiko-activity-log/reader";
import { readSupportReportFile } from "../../packages/keiko-cli/src/support-export.js";
import { runSupportCli } from "../../packages/keiko-cli/src/support.js";
import { editorM11PairingFragment } from "./support/editor-m11-app-session.js";

const projects: string[] = [];
const title = "Support download regression";
test.use({ viewport: { width: 1280, height: 960 } });
test.afterEach((): void => {
  for (const path of projects.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function createChat(request: APIRequestContext): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "keiko-support-download-"));
  projects.push(root);
  writeFileSync(join(root, "README.md"), "# Synthetic support download fixture\n");
  const headers = { "X-Keiko-CSRF": "1" };
  const project = await request.post("/api/projects", {
    headers,
    data: { path: root, name: title },
  });
  expect(project.ok()).toBe(true);
  const response = await request.post("/api/chats", {
    headers,
    data: { projectPath: root, title, selectedModel: "e2e-chat-model" },
  });
  expect(response.status()).toBe(201);
  const value: unknown = await response.json();
  expect(value).toHaveProperty("chat.id");
  if (typeof value !== "object" || value === null || !("chat" in value)) {
    throw new TypeError("Missing synthetic chat");
  }
  const chat = value.chat;
  if (typeof chat !== "object" || chat === null || !("id" in chat) || typeof chat.id !== "string") {
    throw new TypeError("Missing synthetic chat identity");
  }
  return chat.id;
}

async function openChat(page: Page, chatId: string): Promise<Locator> {
  await page.addInitScript(
    ({ id, name }): void => {
      localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "support-chat",
            type: "chat",
            x: 64,
            y: 40,
            w: 900,
            h: 720,
            z: 10,
            cfg: { chatId: id, title: name },
            max: false,
          },
        ]),
      );
      localStorage.removeItem("keiko.conns.v1");
    },
    { id: chatId, name: title },
  );
  await page.goto(`/${editorM11PairingFragment("support-download")}`);
  const window = page.getByRole("region", { name: `Chat — ${title}` });
  await expect(window).toBeVisible();
  return window;
}

async function failChat(
  page: Page,
  request: APIRequestContext,
): Promise<{
  notice: Locator;
  supportId: string;
}> {
  const window = await openChat(page, await createChat(request));
  await window.getByRole("textbox", { name: "Chat message" }).fill("KEIKO_E2E_SUPPORT_FAILURE");
  await window.getByRole("button", { name: "Send message" }).click();
  const notice = window.getByRole("alert").filter({ hasText: "Support ID:" });
  await expect(notice).toBeVisible();
  const supportId = /Support ID: ([a-zA-Z0-9_-]+)/u.exec(await notice.innerText())?.[1];
  expect(supportId).toBeDefined();
  if (supportId === undefined) throw new TypeError("Missing actual Chat support identity");
  return { notice, supportId };
}

async function saveClickedReport(
  page: Page,
  notice: Locator,
  info: TestInfo,
  name: string,
): Promise<{ bytes: Buffer; artifact: AnalyzedSupportReport }> {
  const downloading = page.waitForEvent("download");
  await notice.getByRole("link", { name: "Download report", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^keiko-support-v1-.*\.json\.gz$/u);
  const path = info.outputPath(`${name}.json.gz`);
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  chmodSync(path, 0o600);
  const bytes = readFileSync(path);
  expect(bytes.byteLength).toBeGreaterThan(100);
  expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
  const canonical = readSupportReportFile(path);
  const artifact = analyzeSupportReport(canonical);
  await assertCliAnalysis(path, artifact, info);
  return { bytes, artifact };
}

async function assertCliAnalysis(
  path: string,
  artifact: AnalyzedSupportReport,
  info: TestInfo,
): Promise<void> {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runSupportCli(
    ["analyze", path, "--json"],
    {
      out: (text): void => {
        output.push(text);
      },
      err: (text): void => {
        errors.push(text);
      },
    },
    {},
    { cwd: info.outputDir, controlActivityStateDir: info.outputPath("cli-control") },
  );
  expect(code, errors.join("")).toBe(0);
  const analyzed: unknown = JSON.parse(output.join(""));
  expect(analyzed).toEqual(artifact);
}

async function prepareReport(notice: Locator): Promise<void> {
  await notice.getByRole("button", { name: "Create error report", exact: true }).click();
  await expect(notice.getByRole("link", { name: "Download report", exact: true })).toBeVisible();
}

function assertOriginalFailure(artifact: AnalyzedSupportReport): void {
  // The canonical projection preserves equality while replacing the original private labels.
  expect(artifact.incident.correlation.rootCorrelationId).toBe("id000001");
  expect(artifact.incident.op).toBe("server.diagnostic.failure");
  expect(artifact.incident.errorKind).not.toBe("unknown");
  expect(artifact.incident.frameCount).toBeGreaterThan(0);
  expect(artifact.analysis.evidence.supportedLineCount).toBeGreaterThan(0);
  const lines = artifact.analysis.timelines.flatMap((timeline) => timeline.lines);
  expect(lines).toContainEqual(
    expect.objectContaining({
      op: "server.diagnostic.failure",
      extra: expect.objectContaining({ code: "GATEWAY_PROVIDER_ERROR" }),
    }),
  );
  expect(lines).toContainEqual(
    expect.objectContaining({
      op: "client.diagnostic",
      extra: expect.objectContaining({ clientKind: "sse-error" }),
    }),
  );
}

test("clicks, saves and strictly analyzes repeated and regenerated causal reports @smoke", async ({
  page,
  request,
}, info): Promise<void> => {
  const { notice, supportId } = await failChat(page, request);
  const producing = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/diagnostics/report"),
  );
  await prepareReport(notice);
  const produced = await producing;
  expect(produced.ok()).toBe(true);
  const requested: unknown = produced.request().postDataJSON();
  expect(requested).toHaveProperty("correlationId", supportId);
  const responseBody: unknown = await produced.json();
  const first = await saveClickedReport(page, notice, info, "first");
  expect(responseBody).toHaveProperty("summary.reportDigest", first.artifact.reportDigest);
  assertOriginalFailure(first.artifact);
  const repeated = await saveClickedReport(page, notice, info, "repeated");
  expect(repeated.bytes).toEqual(first.bytes);
  const link = notice.getByRole("link", { name: "Download report", exact: true });
  const previousHref = await link.getAttribute("href");
  await notice.getByRole("button", { name: "Regenerate report", exact: true }).click();
  await expect(link).not.toHaveAttribute("href", previousHref ?? "");
  const regenerated = await saveClickedReport(page, notice, info, "regenerated");
  assertOriginalFailure(regenerated.artifact);
});

test("saves a canonical limited causal report when the loaded browser loses the BFF @smoke", async ({
  page,
  request,
}, info): Promise<void> => {
  const { notice, supportId } = await failChat(page, request);
  // This blocks the real browser's API traffic, while the isolated BFF and other specs remain healthy.
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await prepareReport(notice);
  const { artifact } = await saveClickedReport(page, notice, info, "offline");
  expect(artifact.incident.correlation.rootCorrelationId).toBe(supportId);
  expect(artifact.incident.clientReport?.availabilityReason).toBe("service-unavailable");
  expect(artifact.incident.clientReport?.failure?.errorEvidence?.errorClass).toBe("ApiError");
  expect(artifact.incident.clientReport?.failure?.context).toContain("kind:sse-error");
  expect(artifact.incident.frameCount).toBe(0);
  expect(artifact.analysis.evidence.supportedLineCount).toBe(0);
  expect(artifact.selection.status).toBe("insufficient");
});

test("saves an HTTP limited report preserving the displayed cause without a paired session @smoke", async ({
  page,
  request,
}, info): Promise<void> => {
  const { notice, supportId } = await failChat(page, request);
  await page.context().clearCookies();
  const producing = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/diagnostics/report"),
  );
  await prepareReport(notice);
  const produced = await producing;
  expect(produced.ok()).toBe(true);
  expect(produced.request().postDataJSON()).toHaveProperty("correlationId", supportId);
  const href = await notice
    .getByRole("link", { name: "Download report", exact: true })
    .getAttribute("href");
  const downloadUrl = new URL(href ?? "", produced.url());
  expect(downloadUrl.origin).toBe(new URL(produced.url()).origin);
  expect(downloadUrl.pathname.split("/").slice(1, -1)).toEqual([
    "api",
    "diagnostics",
    "report",
    "download",
  ]);
  expect(await produced.json()).toHaveProperty("downloadPath", href);
  const { artifact } = await saveClickedReport(page, notice, info, "unpaired");
  expect(artifact.incident.correlation.rootCorrelationId).toBe(supportId);
  expect(artifact.incident.clientReport?.availabilityReason).toBe("session-unavailable");
  expect(artifact.incident.clientReport?.failure?.errorEvidence?.errorClass).toBe("ApiError");
  expect(artifact.incident.clientReport?.failure?.context).toContain("kind:sse-error");
  expect(artifact.incident.op).toBe("unattributed");
  expect(artifact.incident.frameCount).toBe(0);
  expect(artifact.analysis.evidence.supportedLineCount).toBe(0);
  expect(artifact.selection.status).toBe("insufficient");
});

async function assertScrollableNoticeStack(stack: Locator): Promise<void> {
  const bounds = await stack.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const parent = element.parentElement?.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      parentTop: parent?.top,
      parentBottom: parent?.bottom,
      scrollable: element.scrollHeight > element.clientHeight,
    };
  });
  expect(bounds.parentTop).toBeDefined();
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.parentTop ?? 0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.parentBottom ?? 0);
  expect(bounds.scrollable).toBe(true);
  await expect(stack).toHaveCSS("overflow-y", "auto");
}

test("keeps stacked workspace error reports reachable on a short narrow viewport @smoke", async ({
  page,
}, info): Promise<void> => {
  await page.setViewportSize({ width: 320, height: 240 });
  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      json: {
        status: "ok",
        version: "1.2.3",
        diagnostics: {
          readiness: "degraded",
          reasons: ["sink-unwritable"],
          writer: "production-file",
          lostEvents: 1,
        },
      },
    });
  });
  await page.goto(`/${editorM11PairingFragment("support-download")}`);
  const readiness = page
    .getByRole("status")
    .filter({ hasText: "Error reports may currently be incomplete." });
  await expect(readiness).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("Synthetic viewport failure") }),
    );
  });
  const failure = page.getByRole("alert").filter({ hasText: "Keiko encountered an error." });
  await expect(failure).toBeVisible();
  const stack = page.locator(".stage > div").filter({ has: readiness }).filter({ has: failure });
  await expect(stack).toHaveCount(1);
  await expect(readiness.locator("..")).toHaveCSS("position", "static");
  await expect(failure).toHaveCSS("position", "static");
  await assertScrollableNoticeStack(stack);
  await prepareReport(failure);
  await saveClickedReport(page, failure, info, "short-viewport");
  await failure.getByRole("button", { name: "Close", exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(readiness).toBeVisible();
  await page.screenshot({ path: info.outputPath("short-viewport.png") });
});
