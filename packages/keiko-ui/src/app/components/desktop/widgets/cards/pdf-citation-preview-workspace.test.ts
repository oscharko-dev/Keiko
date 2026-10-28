import { afterEach, describe, expect, it, vi } from "vitest";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type { PdfPreviewWorkspaceWindow } from "./pdf-citation-preview-session";
import { syncDeferredPdfPreviewWorkspace } from "./pdf-citation-preview-workspace";

vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

type Registry = Pick<
  typeof import("./pdf-citation-preview-session"),
  "syncPdfCitationPreviewWindowRegistry"
>;
type RegistrySpy = ReturnType<typeof vi.fn<Registry["syncPdfCitationPreviewWindowRegistry"]>>;

function deferredRegistry(): {
  load: () => Promise<Registry>;
  resolve: () => void;
  sync: RegistrySpy;
} {
  const sync = vi.fn<Registry["syncPdfCitationPreviewWindowRegistry"]>();
  let resolve = (): void => {};
  const pending = new Promise<Registry>((done) => {
    resolve = (): void => done({ syncPdfCitationPreviewWindowRegistry: sync });
  });
  return { load: () => pending, resolve, sync };
}

async function flushLoad(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.clearAllMocks());

describe("deferred PDF preview workspace membership", () => {
  it("applies the minimal captured membership after loading the existing registry", async () => {
    const registry = deferredRegistry();
    const cfg = { chatId: "chat-original", privateDocument: "not registry state" };
    const wins: PdfPreviewWorkspaceWindow[] = [{ id: "chat", type: "chat", cfg }];
    syncDeferredPdfPreviewWorkspace(wins, registry.load);
    cfg.chatId = "chat-changed";
    wins.length = 0;
    expect(registry.sync).not.toHaveBeenCalled();
    registry.resolve();
    await flushLoad();
    expect(registry.sync).toHaveBeenCalledExactlyOnceWith([
      { id: "chat", type: "chat", minimized: false, cfg: { chatId: "chat-original" } },
    ]);
  });

  it("lets only the current effect publish when older module loading finishes late", async () => {
    const old = deferredRegistry();
    const current = deferredRegistry();
    const stop = syncDeferredPdfPreviewWorkspace(null, old.load);
    stop();
    syncDeferredPdfPreviewWorkspace(
      [{ id: "preview", type: "pdfCitationPreview", cfg: {}, minimized: true }],
      current.load,
    );
    current.resolve();
    old.resolve();
    await flushLoad();
    expect(old.sync).not.toHaveBeenCalled();
    expect(current.sync).toHaveBeenCalledExactlyOnceWith([
      { id: "preview", type: "pdfCitationPreview", cfg: {}, minimized: true },
    ]);
  });

  it("clears registry membership for a current null workspace", async () => {
    const registry = deferredRegistry();
    syncDeferredPdfPreviewWorkspace(null, registry.load);
    registry.resolve();
    await flushLoad();
    expect(registry.sync).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("records a current load failure without the error message or source content", async () => {
    syncDeferredPdfPreviewWorkspace(null, () =>
      Promise.reject(new TypeError("private document content")),
    );
    await flushLoad();
    expect(reportClientDiagnostic).toHaveBeenCalledExactlyOnceWith(
      "PDF preview workspace registry unavailable",
      expect.objectContaining({ errorKind: "unavailable" }),
    );
    expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain("private");
  });

  it("does not report a superseded import failure as current workspace evidence", async () => {
    const stop = syncDeferredPdfPreviewWorkspace([], () => Promise.reject(new Error("private")));
    stop();
    await flushLoad();
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
  });
});
