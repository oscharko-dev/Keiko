import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

vi.mock("./api", () => {
  throw new TypeError("private chunk URL");
});
afterEach(() => {
  resetClientDiagnosticWriter();
  vi.unstubAllGlobals();
});

it("keeps Files binding non-blocking and records a causal body-free prerequisite failure", async () => {
  const { recordReadsContextRelationship } = await import("./connector-relationship");
  const writer = vi.fn();
  setClientDiagnosticWriter(writer);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(
    recordReadsContextRelationship("private-chat", "/private/repo", "files-bind-123"),
  ).toBeUndefined();
  await waitFor(() => expect(writer).toHaveBeenCalledOnce());
  expect(writer).toHaveBeenCalledWith(
    "Files relationship recording failed.",
    expect.objectContaining({
      correlationId: "files-bind-123",
      errorEvidence: expect.objectContaining({ causeChain: expect.arrayContaining(["TypeError"]) }),
    }),
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(writer.mock.calls)).not.toMatch(/private/);
});
