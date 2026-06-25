/**
 * Issue #1395 — Agent editor action governance, policy, and audit (ADR-0062).
 *
 * Browser-level Playwright tests that drive the REAL packaged app (`node dist/cli/index.js ui`).
 * The webServer is defined in playwright.issue-1395-editor-agent.config.ts.
 *
 * What is proven against the real running server + a real browser:
 *
 * AC1/AC4 — A mutating agent action recorded in the bounded audit ledger is served by the real
 *           `GET /api/editor/agent/audit` feed (the exact data path the recent-actions panel reads).
 * AC2     — The policy denies a write to a deny-listed sensitive path (`.env`) with OUT_OF_SCOPE.
 * AC3     — The served audit feed carries no raw edit content, only bounded counts/enums.
 *
 * A live browser bridge for the synthetic session is established via `new EventSource(...)` in the
 * page so write actions reach the queue (the #1392 liveness gate). The panel's DOM rendering is
 * covered by EditorAgentActionsPanel.test.tsx (component + jest-axe); the live editor-pane mount of
 * the panel requires a pre-configured workspace deep-link and is deferred to manual capture, the same
 * documented limitation as the #1394 browser suite.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1", "Content-Type": "application/json" };
const AGENT_SCHEMA_VERSION = "1" as const;
const HASH = "a".repeat(64);

interface AuditRecord {
  readonly actionType: string;
  readonly disposition: string;
  readonly outcome: string;
  readonly denyReason?: string;
  readonly conflictCode?: string;
  readonly editCount?: number;
}

function createWorkspace(): { root: string; relPath: string } {
  const root = mkdtempSync(join(tmpdir(), "keiko-1395-e2e-"));
  mkdirSync(join(root, "src"));
  const relPath = "src/widget.ts";
  writeFileSync(join(root, relPath), "export const VALUE = 1;\n", "utf8");
  return { root, relPath };
}

async function registerAgentSnapshot(
  request: APIRequestContext,
  sessionId: string,
  root: string,
  relPath: string,
): Promise<void> {
  const res = await request.post("/api/editor/agent/snapshot", {
    headers: MUTATION_HEADERS,
    data: JSON.stringify({
      schemaVersion: AGENT_SCHEMA_VERSION,
      kind: "snapshot",
      snapshot: {
        schemaVersion: AGENT_SCHEMA_VERSION,
        sessionId,
        windowId: "e2e-window",
        workspaceRoot: root,
        activePaneId: "pane-1",
        panes: [{ paneId: "pane-1", activeFile: relPath, openFiles: [relPath] }],
        dirtyFiles: [],
        activeFile: relPath,
        cursor: null,
        selection: null,
        diagnosticsSummary: null,
        textMode: "none",
        updatedAt: Date.now(),
      },
    }),
  });
  expect(res.ok()).toBe(true);
}

/** Open a live SSE bridge for the session inside the page so write actions reach the queue. */
async function openBridge(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((sid) => {
    const w = window as unknown as { __keikoBridge?: EventSource };
    w.__keikoBridge = new EventSource(
      `/api/editor/agent/events?sessionId=${encodeURIComponent(sid)}`,
    );
  }, sessionId);
  await page.waitForTimeout(750);
}

async function postApplyTextEdits(
  request: APIRequestContext,
  sessionId: string,
  file: string,
  newText: string,
): Promise<{ httpStatus: number; status: string; code?: string | undefined }> {
  const id = `e2e-${String(Date.now())}-${String(Math.round(Math.random() * 1e6))}`;
  const res = await request.post("/api/editor/agent/actions", {
    headers: MUTATION_HEADERS,
    data: JSON.stringify({
      schemaVersion: AGENT_SCHEMA_VERSION,
      actionId: id,
      idempotencyKey: id,
      sessionId,
      type: "applyTextEdits",
      target: { file },
      expectedContentHash: HASH,
      textEdits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText },
      ],
    }),
  });
  const body = (await res.json()) as { result: { status: string; conflict?: { code: string } } };
  return { httpStatus: res.status(), status: body.result.status, code: body.result.conflict?.code };
}

async function fetchAudit(request: APIRequestContext, sessionId: string): Promise<AuditRecord[]> {
  const res = await request.get(
    `/api/editor/agent/audit?sessionId=${encodeURIComponent(sessionId)}`,
  );
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { records: AuditRecord[] };
  return body.records;
}

test("governs and audits agent editor actions end to end (AC1, AC2, AC3, AC4)", async ({
  page,
  request,
}) => {
  const { root, relPath } = createWorkspace();
  const sessionId = `e2e-1395-${String(Date.now())}`;
  try {
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
    await registerAgentSnapshot(request, sessionId, root, relPath);
    await openBridge(page, sessionId);

    // A contained, non-sensitive write is admitted for human review (review-required → queued).
    const allowed = await postApplyTextEdits(request, sessionId, relPath, "hello");
    expect(allowed.httpStatus).toBe(202);
    expect(allowed.status).toBe("queued");

    // AC2: a write to a deny-listed sensitive path is denied (OUT_OF_SCOPE).
    const denied = await postApplyTextEdits(request, sessionId, ".env", "E2E_SECRET_EDIT");
    expect(denied.httpStatus).toBe(409);
    expect(denied.code).toBe("OUT_OF_SCOPE");

    // AC1/AC4: both governed actions are visible in the real audit feed the panel consumes.
    const records = await fetchAudit(request, sessionId);
    expect(records.length).toBe(2);
    const review = records.find((r) => r.disposition === "review-required");
    const block = records.find((r) => r.disposition === "denied");
    expect(review?.outcome).toBe("queued");
    expect(review?.editCount).toBe(1);
    expect(block?.denyReason).toBe("denied-sensitive-path");
    expect(block?.conflictCode).toBe("OUT_OF_SCOPE");

    // AC3: the served feed carries no raw edit content, only bounded metadata.
    expect(JSON.stringify(records)).not.toContain("E2E_SECRET_EDIT");

    await page.screenshot({ path: "test-results/editor-agent-1395-audit.png" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
