import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODING_TASK_IMPORT_MAX_BYTES,
  type CodingTaskImportResponse,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { CODING_HISTORY_CHANGED, importCodingTask } from "./coding-history-api";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { CORRELATION_HEADER } from "./bff-correlation";

vi.mock("./coding-app-session-client", () => ({ codingAppSessionPairingSettled: vi.fn() }));
vi.mock("./client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(codingAppSessionPairingSettled).mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function importBody(overrides: Record<string, unknown> = {}): CodingTaskImportResponse {
  return {
    task: {
      id: "task-imported",
      title: "Imported",
      projectPath: "/projects/example",
      modelId: "coding",
      branch: "feature/x",
      workspaceId: "workspace-one",
      taskId: "task-one",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      origin: "imported",
    },
    source: "opencode-session",
    messageCount: 3,
    omittedMessageCount: 0,
    skippedMessageCount: 1,
    ...overrides,
  } as CodingTaskImportResponse;
}

const content = '{"info":{"title":"Größe ✓"},"messages":[]}';

// #3904 AC4: the picked file goes to the local server only, as it is; a file above the bound is
// refused before it is read.
describe("coding task import client", () => {
  it("posts the file's exact text with the initiating correlation and announces the change", async () => {
    fetchMock.mockResolvedValue(response(importBody()));
    const changed = vi.fn();
    window.addEventListener(CODING_HISTORY_CHANGED, changed);
    try {
      await expect(importCodingTask(new Blob([content]), "ui_import-0001")).resolves.toMatchObject({
        source: "opencode-session",
        messageCount: 3,
      });
    } finally {
      window.removeEventListener(CODING_HISTORY_CHANGED, changed);
    }
    expect(codingAppSessionPairingSettled).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/coding-workbench/history/import");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({ method: "POST", body: content, signal: expect.any(AbortSignal) });
    expect(init?.headers).toMatchObject({ [CORRELATION_HEADER]: "ui_import-0001" });
    expect(changed).toHaveBeenCalledOnce();
  });

  it("refuses a file above the bound before reading or sending it", async () => {
    const big = new Blob([new Uint8Array(CODING_TASK_IMPORT_MAX_BYTES + 1)]);
    const text = vi.spyOn(big, "text");
    await expect(importCodingTask(big)).rejects.toMatchObject({
      code: "CODING_HISTORY_IMPORT_TOO_LARGE",
      status: 413,
    });
    expect(text).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a task that is not imported", { task: { ...importBody().task, origin: undefined } }],
    ["a task without an id", { task: { ...importBody().task, id: "" } }],
    ["no task", { task: null }],
    ["an unknown source", { source: "chat-export" }],
    ["no message", { messageCount: 0 }],
    ["a negative count", { omittedMessageCount: -1 }],
    ["a missing count", { skippedMessageCount: undefined }],
  ])("refuses a response with %s and announces nothing", async (_name, overrides) => {
    fetchMock.mockResolvedValue(response(importBody(overrides)));
    const changed = vi.fn();
    window.addEventListener(CODING_HISTORY_CHANGED, changed);
    try {
      await expect(importCodingTask(new Blob([content]))).rejects.toMatchObject({
        code: "CONTRACT_VALIDATION_FAILED",
        status: 502,
      });
    } finally {
      window.removeEventListener(CODING_HISTORY_CHANGED, changed);
    }
    expect(changed).not.toHaveBeenCalled();
  });

  it("surfaces the server's refusal code", async () => {
    fetchMock.mockResolvedValue(
      response(
        { error: { code: "CODING_HISTORY_IMPORT_NO_WORKSPACE", message: "Open a workspace." } },
        409,
      ),
    );
    await expect(importCodingTask(new Blob([content]))).rejects.toMatchObject({
      code: "CODING_HISTORY_IMPORT_NO_WORKSPACE",
      status: 409,
    });
  });
});
