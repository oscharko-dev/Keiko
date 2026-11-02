import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientDiagnosticWriter } from "./client-diagnostics";

const COMMAND_RUNNER = "@oscharko-dev/keiko-contracts/runtime/command-runner";

// The command validators load lazily (#3918). A failed chunk load must surface as one correlated
// MODULE_LOAD_FAILED error and one body-free diagnostic, before any request leaves the client.
describe("command validator module load failure (#3918)", () => {
  afterEach(() => {
    vi.doUnmock(COMMAND_RUNNER);
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(["catalog", "run"] as const)(
    "reports the %s validator load failure once with its correlation and sends no request",
    async (kind) => {
      vi.resetModules();
      vi.doMock(COMMAND_RUNNER, () => {
        throw new Error("fixture chunk load failure");
      });
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const diagnostics = await import("./client-diagnostics");
      const writer = vi.fn<ClientDiagnosticWriter>();
      diagnostics.setClientDiagnosticWriter(writer);
      const api = await import("./commands-api");

      const request =
        kind === "catalog"
          ? api.fetchCommandCatalog("/fixture-project")
          : api.createCommandRun({ projectId: "/fixture-project", taskId: "npm-script:test" });

      await expect(request).rejects.toMatchObject({ code: "MODULE_LOAD_FAILED", status: 0 });
      expect(fetch).not.toHaveBeenCalled();
      expect(writer).toHaveBeenCalledTimes(1);
      const meta = writer.mock.calls[0]?.[1];
      expect(meta).toMatchObject({
        kind: "other",
        errorKind: "unavailable",
        moduleLoadFailure: "command-runner",
        correlationId: expect.stringMatching(/\S/u),
      });
      await expect(request).rejects.toMatchObject({ correlationId: meta?.correlationId });
      expect(JSON.stringify(writer.mock.calls)).not.toContain("fixture chunk load failure");
      diagnostics.resetClientDiagnosticWriter();
    },
  );
});
