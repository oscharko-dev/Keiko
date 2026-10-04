import { afterEach, describe, expect, it, vi } from "vitest";
import { correlationIdOf } from "./client-error-summary";
import {
  setClientDiagnosticWriter,
  resetClientDiagnosticWriter,
  takeClientDiagnosticLoss,
} from "./client-diagnostics";
import {
  resetFilesNavigationEvidenceForTests,
  observeFilesDirectoryRead,
  startFilesNavigationEvidence,
} from "./files-navigation-evidence";

afterEach(() => {
  resetClientDiagnosticWriter();
  resetFilesNavigationEvidenceForTests();
  takeClientDiagnosticLoss();
  vi.restoreAllMocks();
});

describe("body-free folder navigation evidence", () => {
  it("passes the stage correlation to the real request producer without recording bodies", async () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const response = { root: "/private/customer", content: "private document" };
    const read = vi.fn(async (_correlationId: string) => response);
    expect(await observeFilesDirectoryRead(read)).toBe(response);
    const start = writer.mock.calls[0]?.[1];
    expect(writer.mock.calls[1]?.[1]).toMatchObject({
      correlationId: start?.correlationId,
      stageReport: { stage: "files directory load", phase: "settled" },
    });
    expect(read).toHaveBeenCalledWith(start?.correlationId);
    expect(JSON.stringify(writer.mock.calls)).not.toContain("private");
  });

  it("records failures under the started correlation and settles even a failed read", async () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const failure = new TypeError("private body");
    const captured = await observeFilesDirectoryRead(async () => {
      throw failure;
    }).catch((error: unknown) => error);
    expect(correlationIdOf(captured)).toBe(writer.mock.calls[0]?.[1]?.correlationId);
    expect(captured).toHaveProperty("cause", failure);
    const start = writer.mock.calls[0]?.[1];
    expect(writer.mock.calls[1]?.[1]).toMatchObject({
      correlationId: start?.correlationId,
      errorEvidence: { errorClass: "TypeError" },
    });
    expect(writer.mock.calls[2]?.[1]).toMatchObject({
      correlationId: start?.correlationId,
      stageReport: { phase: "settled" },
    });
    expect(JSON.stringify(writer.mock.calls)).not.toContain("private body");
  });

  it("bounds durations when the clock advances or steps backwards", () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(0);
    startFilesNavigationEvidence("files directory navigation")();
    expect(writer.mock.calls[1]?.[1]?.stageReport).toMatchObject({ durationMs: 0 });
  });
});

it("bounds successful read stages separately while preserving failed read correlation", async () => {
  const writer = vi.fn();
  setClientDiagnosticWriter(writer);
  for (let index = 0; index < 20; index += 1)
    await observeFilesDirectoryRead(async () => undefined);
  expect(writer.mock.calls.filter((call) => call[1]?.stageReport !== undefined)).toHaveLength(16);
  expect(takeClientDiagnosticLoss()).toEqual({ postsThrottled: 24 });
  const error = await observeFilesDirectoryRead(async () => {
    throw new TypeError("private");
  }).catch((error: unknown) => error);
  const failureMeta = writer.mock.calls.at(-1)?.[1];
  expect(correlationIdOf(error)).toBe(failureMeta?.correlationId);
  expect(failureMeta?.errorEvidence.errorClass).toBe("TypeError");
});

describe("body-free source preview evidence", () => {
  it("records admitted text bytes and editing capability without document identity or content", () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    startFilesNavigationEvidence("files source preview")(
      {
        kind: "text",
        sizeBytes: 2048,
        canEdit: false,
        root: "/private/customer",
        path: "private.html",
        content: "private body",
      },
      "applied",
    );
    expect(writer.mock.calls.at(-1)?.[1]?.stageReport).toMatchObject({
      phase: "settled",
      preview: { previewKind: "text", sourceTextBytesRead: 2048, canEdit: false },
    });
    expect(JSON.stringify(writer.mock.calls)).not.toContain("private");
  });
  it("does not invent read counts for a failed request", () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    startFilesNavigationEvidence("files source preview")(undefined, "failed");
    expect(writer.mock.calls.at(-1)?.[1]?.stageReport?.preview).toBeUndefined();
  });
});
