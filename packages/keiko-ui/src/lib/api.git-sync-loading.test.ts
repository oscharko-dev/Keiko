import { afterEach, describe, expect, it, vi } from "vitest";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "./client-diagnostics";
import { fetchGitDeliverySyncPreview, fetchGitDeliverySyncExecute } from "./api";

vi.mock("@oscharko-dev/keiko-contracts/runtime/git-sync", () => {
  throw new TypeError("private chunk URL");
});
afterEach(() => {
  resetClientDiagnosticWriter();
  vi.unstubAllGlobals();
});
describe("git sync validator chunk failure", () => {
  it.each([fetchGitDeliverySyncPreview, fetchGitDeliverySyncExecute])(
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
          correlationId: expect.any(String),
        }),
      );
      expect(JSON.stringify(writer.mock.calls)).not.toMatch(/private chunk URL|private\/repo/);
    },
  );
});
