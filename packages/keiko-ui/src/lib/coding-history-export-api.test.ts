import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportCodingTask, saveCodingTaskExport } from "./coding-history-api";
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
  vi.useRealTimers();
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function exportBody(content: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    format: "json",
    fileName: "keiko-coding-task-task-one.json",
    mediaType: "application/json",
    content,
    messageCount: 1,
    byteCount: new TextEncoder().encode(content).byteLength,
    truncated: false,
    ...overrides,
  };
}

describe("coding task export client", () => {
  it("waits for pairing, names the format and carries the initiating correlation", async () => {
    fetchMock.mockResolvedValue(response(exportBody("{}\n")));
    await expect(
      exportCodingTask("task/one", "json", "ui_export-load-0001"),
    ).resolves.toMatchObject({ fileName: "keiko-coding-task-task-one.json" });
    expect(codingAppSessionPairingSettled).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/coding-workbench/history/task%2Fone/export?format=json",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      [CORRELATION_HEADER]: "ui_export-load-0001",
    });
  });

  it("counts multi-byte text by its bytes, not its characters", async () => {
    const content = "Größe ✓\n";
    fetchMock.mockResolvedValue(response(exportBody(content)));
    await expect(exportCodingTask("task-one", "json")).resolves.toMatchObject({ content });
  });

  it.each([
    ["another format", { format: "markdown" }],
    ["another media type", { mediaType: "text/html" }],
    ["a path in the file name", { fileName: "../keiko-coding-task-x.json" }],
    ["a foreign file name", { fileName: "report.json" }],
    ["a byte count that is not the content", { byteCount: 1 }],
    ["a negative count", { messageCount: -1 }],
    ["a count above the ceiling", { byteCount: 9 * 1024 * 1024 }],
    ["a missing truncation flag", { truncated: undefined }],
    ["no content", { content: undefined }],
  ])("refuses a response with %s instead of saving it", async (_name, overrides) => {
    fetchMock.mockResolvedValue(response(exportBody("{}\n", overrides)));
    await expect(exportCodingTask("task-one", "json")).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  it("refuses a body that is not an object", async () => {
    fetchMock.mockResolvedValue(response(null));
    await expect(exportCodingTask("task-one", "json")).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
    });
  });

  it("propagates a refused export with its code", async () => {
    fetchMock.mockResolvedValue(
      response({ error: { code: "CODING_HISTORY_UNAVAILABLE", message: "No" } }, 404),
    );
    await expect(exportCodingTask("task-one", "markdown")).rejects.toMatchObject({
      code: "CODING_HISTORY_UNAVAILABLE",
      status: 404,
    });
  });
});

describe("saving a coding task export", () => {
  it("downloads the exact text through the browser and then releases the object URL", () => {
    vi.useFakeTimers();
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:keiko-export";
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const seen: { download?: string; href?: string; attached?: boolean } = {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      seen.download = this.download;
      seen.href = this.href;
      seen.attached = document.body.contains(this);
    });
    saveCodingTaskExport({
      fileName: "keiko-coding-task-task-one.md",
      mediaType: "text/markdown",
      content: "# Keiko\n",
    });
    expect(click).toHaveBeenCalledOnce();
    expect(seen).toEqual({
      download: "keiko-coding-task-task-one.md",
      href: "blob:keiko-export",
      attached: true,
    });
    expect(created[0]?.type).toBe("text/markdown;charset=utf-8");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:keiko-export");
    click.mockRestore();
  });
});
