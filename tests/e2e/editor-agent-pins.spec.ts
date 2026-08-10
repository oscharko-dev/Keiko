/**
 * Editor-agent invariant pins — restoring the invariants that retired with the #1394/#1395
 * suites (see the retirement notes in ADR-0058 and ADR-0066) against today's product surface.
 *
 * The test drives the REAL editor: the M11 editor is mounted in the browser on a registered
 * project (the local-human trust act, #2612/#2686), registers its own agent session and SSE
 * bridge, and the suite discovers that live session through `GET /api/editor/agent/sessions` —
 * no synthetic snapshot, no mocked seam.
 *
 * Pin (#1395, ADR-0062 / M11 authority): on the direct agent channel,
 *   - a changeset targeting the always-on deny list (`.env`) is denied and audited as
 *     `denied-sensitive-path` (`applyChangeset` is the one mutation whose targets travel with
 *     the action; `applyTextEdits`/`applyPatch` are server-bound to the active buffer),
 *   - a contained write WITHOUT a registered Authority Envelope fails closed as
 *     `authority-missing` — it must never quietly queue,
 *   - and the served audit feed stays content-free: neither payload may appear in it.
 * The test fails by construction if the denial, the fail-closed default, or the redaction
 * breaks.
 *
 * The #1394 undo/redo round-trip pin is NOT here yet: the product loses the undo history across
 * the agent-review remount, tracked with full evidence and the finished test draft in #3070.
 * Two contributing keiko-editor defects (undo-clearing `setValue` sync, duplicate undo stop on
 * identical host edits) are already fixed and pinned in KeikoCodeEditor.test.tsx.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

import {
  cleanupEditorWorkspaces,
  collectPageErrors,
  createEditorWorkspace,
  openEditorWorkspace,
  seedEditorWindow,
} from "./support/editorWorkspace.js";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const RELATIVE_PATH = "src/pinned.ts";
const PINNED_LINE = 'export const pinned = "before";';
const INITIAL_CONTENT = `${PINNED_LINE}\n`;
const DENIED_SECRET = "E2E_SECRET_EDIT_1395";
const CONTAINED_EDIT_MARKER = "AGENT_CONTAINED_EDIT_1395";
const EDITOR_WINDOW_ID = "editor-agent-pins";
// The deny-listed workspace file the agent must never write. It EXISTS in the fixture — the real
// threat model — so every structural preflight is satisfied and the sensitivity decision answers.
const ENV_RELATIVE_PATH = ".env";
const ENV_BEFORE = "PLACEHOLDER=1\n";
const SENSITIVE_PATCH = [
  `--- a/${ENV_RELATIVE_PATH}`,
  `+++ b/${ENV_RELATIVE_PATH}`,
  "@@ -1,1 +1,1 @@",
  "-PLACEHOLDER=1",
  `+${DENIED_SECRET}`,
].join("\n");

test.use({ viewport: { width: 1600, height: 1000 } });

interface AuditRecord {
  readonly actionType?: string;
  readonly disposition?: string;
  readonly outcome?: string;
  readonly denyReason?: string;
  readonly conflictCode?: string;
  readonly editCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function registerProject(request: APIRequestContext, root: string): Promise<void> {
  // M11 (#2612/#2686): registering the folder as a project IS the local-human trust act; an
  // unregistered root cannot be resolved by the editor and falls back to the default project.
  const project = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name: "Keiko editor agent pins E2E" },
  });
  if (!project.ok()) {
    throw new Error(`Project setup failed (${String(project.status())}): ${await project.text()}`);
  }
}

interface LiveEditorSession {
  readonly sessionId: string;
  readonly activeFileContentHash: string;
}

async function liveEditorSession(
  request: APIRequestContext,
  root: string,
): Promise<LiveEditorSession | null> {
  const response = await request.get("/api/editor/agent/sessions");
  if (!response.ok()) return null;
  const body = (await response.json()) as { sessions?: readonly unknown[] };
  const session = body.sessions?.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.workspaceRoot === root &&
      candidate.activeFile === RELATIVE_PATH,
  );
  if (!isRecord(session)) return null;
  const { sessionId, activeFileContentHash } = session;
  return typeof sessionId === "string" && typeof activeFileContentHash === "string"
    ? { sessionId, activeFileContentHash }
    : null;
}

async function waitForEditorSession(
  request: APIRequestContext,
  root: string,
): Promise<LiveEditorSession> {
  await expect.poll(async () => liveEditorSession(request, root)).not.toBeNull();
  const session = await liveEditorSession(request, root);
  if (session === null) throw new Error("Editor session did not register.");
  return session;
}

interface DirectActionOutcome {
  readonly httpStatus: number;
  readonly status: string;
  readonly code: string | undefined;
}

function parseActionOutcome(httpStatus: number, raw: string): DirectActionOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Action response is not JSON (${String(httpStatus)}): ${raw}`);
  }
  const result = isRecord(parsed) && isRecord(parsed.result) ? parsed.result : undefined;
  if (result === undefined || typeof result.status !== "string") {
    throw new Error(`Action response carries no result (${String(httpStatus)}): ${raw}`);
  }
  const conflict = isRecord(result.conflict) ? result.conflict : undefined;
  return {
    httpStatus,
    status: result.status,
    code: typeof conflict?.code === "string" ? conflict.code : undefined,
  };
}

/**
 * Post an `applyTextEdits` on the DIRECT agent channel (no browser bridge capability). The
 * preconditions bind to the session's own reported content hash so the structural DIRTY/VERSION/
 * HASH gates pass and the decision under test (the authority default) is the one that answers.
 */
async function postDirectTextEdit(
  request: APIRequestContext,
  session: LiveEditorSession,
  edit: { readonly file: string; readonly newText: string },
): Promise<DirectActionOutcome> {
  const actionId = `pin-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
  const response = await request.post("/api/editor/agent/actions", {
    headers: MUTATION_HEADERS,
    data: {
      schemaVersion: "1",
      actionId,
      idempotencyKey: actionId,
      sessionId: session.sessionId,
      type: "applyTextEdits",
      origin: "agent",
      target: { file: edit.file },
      expectedContentHash: session.activeFileContentHash,
      textEdits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: edit.newText,
        },
      ],
    },
  });
  return parseActionOutcome(response.status(), await response.text());
}

/** Post an `applyChangeset` on the DIRECT agent channel; its targets travel with the action. */
async function postDirectChangeset(
  request: APIRequestContext,
  session: LiveEditorSession,
  changeset: { readonly patch: string; readonly file: string; readonly beforeContent: string },
): Promise<DirectActionOutcome> {
  const actionId = `pin-changeset-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
  const response = await request.post("/api/editor/agent/actions", {
    headers: MUTATION_HEADERS,
    data: {
      schemaVersion: "1",
      actionId,
      idempotencyKey: actionId,
      sessionId: session.sessionId,
      type: "applyChangeset",
      origin: "agent",
      changeset: {
        patch: changeset.patch,
        files: [{ file: changeset.file, expectedContentHash: sha256Hex(changeset.beforeContent) }],
      },
    },
  });
  return parseActionOutcome(response.status(), await response.text());
}

async function fetchAuditRecords(
  request: APIRequestContext,
  sessionId: string,
): Promise<readonly AuditRecord[]> {
  const response = await request.get(
    `/api/editor/agent/audit?sessionId=${encodeURIComponent(sessionId)}`,
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { records?: readonly AuditRecord[] };
  return body.records ?? [];
}

test.afterAll(() => {
  cleanupEditorWorkspaces();
});

interface PinFixture {
  readonly workspace: Locator;
  readonly session: LiveEditorSession;
}

/** Register the fixture root as a project (the trust act) and mount the real editor on it. */
async function openPinnedEditor(page: Page, request: APIRequestContext): Promise<PinFixture> {
  const { root } = createEditorWorkspace([
    { path: RELATIVE_PATH, content: INITIAL_CONTENT },
    { path: ENV_RELATIVE_PATH, content: ENV_BEFORE },
  ]);
  await registerProject(request, root);
  await seedEditorWindow(page, {
    root,
    active: RELATIVE_PATH,
    openFiles: [RELATIVE_PATH],
    windowId: EDITOR_WINDOW_ID,
  });
  await page.goto("/");
  const workspace = await openEditorWorkspace(page);
  await expect(workspace.locator(".view-line").filter({ hasText: PINNED_LINE })).toBeVisible();
  const session = await waitForEditorSession(request, root);
  return { workspace, session };
}

test("denies sensitive-path and unauthorized agent writes and serves a redacted audit (#1395 pin)", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const pageErrors = collectPageErrors(page);
  const { workspace, session } = await openPinnedEditor(page, request);

  // A changeset targeting the always-on deny list is refused and never reaches the editor. The
  // wire code is bounded (a conflict), and the governance reason lands in the audit ledger below.
  const denied = await postDirectChangeset(request, session, {
    patch: SENSITIVE_PATCH,
    file: ENV_RELATIVE_PATH,
    beforeContent: ENV_BEFORE,
  });
  expect(denied.httpStatus).toBeGreaterThanOrEqual(400);
  expect(denied.status).not.toBe("queued");

  // M11 fail-closed default: a contained write on the direct agent channel WITHOUT a registered
  // Authority Envelope is denied as authority-missing — it must never quietly queue.
  const unauthorized = await postDirectTextEdit(request, session, {
    file: RELATIVE_PATH,
    newText: `// ${CONTAINED_EDIT_MARKER}\n`,
  });
  expect(unauthorized.httpStatus).toBeGreaterThanOrEqual(400);
  expect(unauthorized.status).not.toBe("queued");

  // Both decisions are recorded in the served audit feed the recent-actions panel consumes.
  await expect
    .poll(async () => (await fetchAuditRecords(request, session.sessionId)).length)
    .toBeGreaterThanOrEqual(2);
  const records = await fetchAuditRecords(request, session.sessionId);
  const evidence = JSON.stringify({ denied, unauthorized, records });
  const sensitive = records.find((record) => record.denyReason === "denied-sensitive-path");
  const failClosed = records.find((record) => record.denyReason === "authority-missing");
  expect(sensitive, evidence).toBeDefined();
  expect(failClosed, evidence).toBeDefined();
  expect(sensitive?.actionType).toBe("applyChangeset");
  expect(sensitive?.disposition).toBe("denied");
  expect(failClosed?.actionType).toBe("applyTextEdits");
  expect(failClosed?.disposition).toBe("denied");

  // Redaction pin: the feed carries bounded metadata only — never edit content. This assertion
  // fails if the audit ledger ever starts serving raw text from either denied action.
  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain(DENIED_SECRET);
  expect(serialized).not.toContain(CONTAINED_EDIT_MARKER);

  // The denials never mutated the mounted buffer.
  await expect(workspace.locator(".view-line").filter({ hasText: PINNED_LINE })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
