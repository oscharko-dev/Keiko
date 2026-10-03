import { afterEach, describe, expect, it, vi } from "vitest";
import { recordResponseCorrelationId } from "./bff-correlation";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "./client-diagnostics";
import {
  observeFilesDirectoryRead,
  startFilesNavigationEvidence,
} from "./files-navigation-evidence";

afterEach(() => {
  resetClientDiagnosticWriter();
  vi.restoreAllMocks();
});

describe("body-free folder navigation evidence", () => {
  it("joins the read's response correlation to the stage and never records file bodies", async () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const response = { root: "/private/customer", content: "private document" };
    recordResponseCorrelationId(response, "request-directory-01");
    expect(await observeFilesDirectoryRead(async () => response)).toBe(response);
    const start = writer.mock.calls[0]?.[1];
    expect(writer.mock.calls[1]?.[1]).toMatchObject({
      correlationId: start?.correlationId,
      parentCorrelationId: "request-directory-01",
      stageReport: { stage: "files directory load", phase: "settled" },
    });
    expect(JSON.stringify(writer.mock.calls)).not.toContain("private");
  });

  it("records failures under the started correlation and settles even a failed read", async () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const failure = new TypeError("private body");
    await expect(
      observeFilesDirectoryRead(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
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
