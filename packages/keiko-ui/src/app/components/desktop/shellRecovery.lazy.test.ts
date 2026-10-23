import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = {
  schemaVersion: "1",
  storeState: "ready",
  userRevision: 4,
  workspaceRevision: 7,
  revision: 7,
  etag: "etag-1",
  definitions: [],
  settings: [],
  eventSequence: 1,
};

describe("shell recovery contract loading", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/api");
    vi.doUnmock("@/lib/client-diagnostics");
    vi.doUnmock("@oscharko-dev/keiko-contracts/runtime/editor-m7");
    vi.resetModules();
  });

  it("evaluates the canonical contract only when recovery attempts a reset", async () => {
    const evaluated = vi.fn();
    const mutate = vi.fn().mockResolvedValue({ kind: "ok", snapshot });
    vi.doMock("@/lib/api", () => ({
      fetchEditorSettings: vi.fn().mockResolvedValue(snapshot),
      mutateEditorSettings: mutate,
    }));
    vi.doMock("@oscharko-dev/keiko-contracts/runtime/editor-m7", async () => {
      evaluated();
      return vi.importActual("@oscharko-dev/keiko-contracts/runtime/editor-m7");
    });
    const recovery = await import("./shellRecovery");
    expect(evaluated).not.toHaveBeenCalled();
    await recovery.resetPersistedShortcutOverrides();
    const canonical = await vi.importActual<
      typeof import("@oscharko-dev/keiko-contracts/runtime/editor-m7")
    >("@oscharko-dev/keiko-contracts/runtime/editor-m7");
    expect(evaluated).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls.map((call) => call[0])).toEqual([
      {
        schemaVersion: canonical.EDITOR_M7_SCHEMA_VERSION,
        scope: "user",
        action: "reset",
        expectedRevision: 4,
        settingIds: ["keybindingOverrides"],
      },
      {
        schemaVersion: canonical.EDITOR_M7_SCHEMA_VERSION,
        scope: "workspace",
        action: "reset",
        expectedRevision: 7,
        settingIds: ["keybindingOverrides"],
      },
    ]);
  });

  it("settles each layer refusal without dispatching when the contract cannot load", async () => {
    const mutate = vi.fn();
    const report = vi.fn();
    vi.doMock("@/lib/api", () => ({
      fetchEditorSettings: vi.fn().mockResolvedValue(snapshot),
      mutateEditorSettings: mutate,
    }));
    vi.doMock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: report }));
    vi.doMock("@oscharko-dev/keiko-contracts/runtime/editor-m7", () => {
      throw new TypeError("private provider endpoint failed");
    });
    const loading = import("./shellRecovery");
    await expect(loading).resolves.toHaveProperty("resetPersistedShortcutOverrides");
    const recovery = await loading;
    await expect(recovery.resetPersistedShortcutOverrides()).rejects.toThrow(
      /refused by 2 setting layers/u,
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(report.mock.calls.map((call) => call[0])).toEqual([
      "shell-recovery: user layer reset failed (Error)",
      "shell-recovery: workspace layer reset failed (Error)",
    ]);
    expect(JSON.stringify(report.mock.calls)).not.toContain("private provider endpoint");
  });

  it("joins each native refusal to its request and retains an owning request correlation", async () => {
    const report = vi.fn();
    const mutate = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("private request failure"))
      .mockRejectedValueOnce(
        Object.assign(new TypeError("private correlated failure"), {
          correlationId: "owning-request-correlation",
        }),
      );
    vi.doMock("@/lib/api", () => ({
      fetchEditorSettings: vi.fn().mockResolvedValue(snapshot),
      mutateEditorSettings: mutate,
    }));
    vi.doMock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: report }));
    const recovery = await import("./shellRecovery");
    await expect(recovery.resetPersistedShortcutOverrides()).rejects.toThrow(
      /refused by 2 setting layers/u,
    );
    const userId: unknown = mutate.mock.calls[0]?.[2];
    const workspaceId: unknown = mutate.mock.calls[1]?.[2];
    expect(userId).toEqual(expect.any(String));
    expect(workspaceId).toEqual(expect.any(String));
    expect(userId).not.toBe(workspaceId);
    expect(report.mock.calls.map((call) => call[1])).toEqual([
      {
        correlationId: userId,
        errorKind: "unavailable",
        errorEvidence: { errorClass: "TypeError", frames: [], causeChain: [] },
      },
      {
        correlationId: "owning-request-correlation",
        errorKind: "unavailable",
        errorEvidence: { errorClass: "TypeError", frames: [], causeChain: [] },
      },
    ]);
    expect(JSON.stringify(report.mock.calls)).not.toContain("private");
  });
});
