import { afterEach, describe, expect, it, vi } from "vitest";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "./client-diagnostics";
import {
  fetchGitDeliverySyncPreview,
  fetchGitDeliverySyncExecute,
  fetchGitDeliverySyncApprove,
  fetchGitHistory,
} from "./api";

vi.mock("./coding-workbench-lazy-fetchers", () => {
  throw new TypeError("private chunk URL");
});
afterEach(() => {
  resetClientDiagnosticWriter();
  vi.unstubAllGlobals();
});
describe("git sync validator chunk failure", () => {
  it.each([fetchGitDeliverySyncPreview, fetchGitDeliverySyncExecute, fetchGitDeliverySyncApprove])(
    "logs the failed prerequisite before making any Git request",
    async (fetchSync) => {
      const writer = vi.fn();
      setClientDiagnosticWriter(writer);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        fetchSync({ operation: "fetch", projectId: "/private/repo" }),
      ).rejects.toBeDefined();
      expect(fetch).not.toHaveBeenCalled();
      expect(writer).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          moduleLoadFailure: "git-sync",
          errorEvidence: expect.objectContaining({ causeChain: ["TypeError"] }),
          correlationId: expect.any(String),
        }),
      );
      expect(JSON.stringify(writer.mock.calls)).not.toMatch(/private chunk URL|private\/repo/);
    },
  );
});

it("records history module failure with its own operation identity", async () => {
  const writer = vi.fn();
  setClientDiagnosticWriter(writer);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(fetchGitHistory({ root: "/private/repo" })).rejects.toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
  expect(writer).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      moduleLoadFailure: "git-history",
      errorEvidence: expect.objectContaining({ causeChain: ["TypeError"] }),
    }),
  );
});
