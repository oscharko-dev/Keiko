import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askGrounded,
  cloneRepository,
  clearModelCacheForTests,
  clearProjectRequestForTests,
  deleteChat,
  deleteProject,
  closePdfCitationPreviewSession,
  fetchFilesContent,
  fetchFilesDirectories,
  fetchFilesPreview,
  fetchFilesSearch,
  fetchFilesTree,
  fetchGitBranches,
  fetchGitDeliverySyncExecute,
  fetchGitDeliverySyncPreview,
  fetchGitDiff,
  fetchGitHistory,
  fetchGitRemotes,
  fetchGitSummary,
  fetchGitStatus,
  fetchModels,
  fetchPdfCitationPreviewDocument,
  fetchProjects,
  regenerateDesktopChat,
  fetchStartupUpdatePreflight,
  fetchUpdateRemediationStatus,
  fetchUpdateSessionStatus,
  fetchVoiceCapability,
  openPdfCitationPreviewSession,
  pdfCitationPreviewDocumentUrl,
  prepareUpdateRemediationStatus,
  runGatewayReadiness,
  checkUpdatePreflight,
  cancelUpdateSession,
  retryUpdateSession,
  runUpdateRemediationAction,
  startUpdateSession,
  requestEditorCompletion,
  requestEditorDiagnostics,
  requestEditorFormatting,
  requestEditorHover,
  requestEditorSymbols,
  saveFilesContent,
  sendDesktopChatStream,
  fetchWorkspaceSummary,
  transcribeDictation,
  synthesizeAssistantSpeech,
  verifyUpdateRestart,
  ApiError,
  type StreamHandlers,
} from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("requestEditorCompletion (Issue #1199)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the overlay + cursor to the completion route with the CSRF header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        schemaVersion: "1",
        items: [{ label: "alpha", kind: "field", insertText: "alpha", origin: "deterministic" }],
        isIncomplete: false,
        truncated: false,
        provenance: { sources: ["deterministic-language-service"], modelMode: "deterministic" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestEditorCompletion({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "const value = {};\nvalue.\n",
      position: { line: 1, character: 6 },
      triggerKind: "trigger-character",
      triggerCharacter: ".",
      contextBudgetBytes: 4_096,
    });

    expect(response.items[0]?.label).toBe("alpha");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/completion",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          schemaVersion: "1",
          root: "/repo",
          document: {
            path: "src/a.ts",
            languageId: "typescript",
            text: "const value = {};\nvalue.\n",
          },
          position: { line: 1, character: 6 },
          triggerKind: "trigger-character",
          triggerCharacter: ".",
          contextBudgetBytes: 4_096,
        }),
      }),
    );
  });

  it("forwards an abort signal for superseded-request cancellation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        schemaVersion: "1",
        items: [],
        isIncomplete: false,
        truncated: false,
        provenance: { sources: ["deterministic-language-service"], modelMode: "deterministic" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await requestEditorCompletion(
      {
        root: "/repo",
        path: "src/a.ts",
        languageId: "typescript",
        text: "x",
        position: { line: 0, character: 1 },
        triggerKind: "invoked",
        contextBudgetBytes: 1_024,
      },
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/completion",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("update preflight helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchStartupUpdatePreflight reads the cached startup report from the BFF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        checkedAt: "2026-06-30T12:00:00.000Z",
        currentVersion: "0.2.9",
        targetVersion: "0.2.10",
        updateAvailable: true,
        status: "update-available",
        registryStatus: "ok",
        releaseMetadataStatus: "fallback",
        warnings: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const report = await fetchStartupUpdatePreflight();

    expect(report.targetVersion).toBe("0.2.10");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/update/preflight",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("checkUpdatePreflight posts a manual retry through the CSRF gate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        checkedAt: "2026-06-30T12:05:00.000Z",
        currentVersion: "0.2.9",
        targetVersion: "0.2.11",
        updateAvailable: true,
        status: "update-available",
        registryStatus: "ok",
        releaseMetadataStatus: "live",
        warnings: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const report = await checkUpdatePreflight();

    expect(report.targetVersion).toBe("0.2.11");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/update/preflight/check",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });
});

describe("governed update session helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sessionStatus = {
    schemaVersion: "1",
    installMode: {
      schemaVersion: "1",
      status: "supported",
      packageName: "@oscharko-dev/keiko",
      packageManager: "npm",
    },
    policy: { enabled: true, source: "default" },
  };

  const session = {
    schemaVersion: "1",
    sessionId: "update-1",
    packageName: "@oscharko-dev/keiko",
    targetVersion: "0.2.11",
    phase: "running",
    failureReason: "none",
    startedAt: "2026-06-30T12:00:00.000Z",
    updatedAt: "2026-06-30T12:00:01.000Z",
    cancelable: true,
    retryable: false,
    restartRequired: false,
    message: "Installing update.",
  };

  it("fetchUpdateSessionStatus reads the current governed update session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionStatus));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUpdateSessionStatus();

    expect(result.installMode.status).toBe("supported");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/update/session",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("startUpdateSession posts a target version through the CSRF gate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(session));
    vi.stubGlobal("fetch", fetchMock);

    const result = await startUpdateSession({ targetVersion: "0.2.11" });

    expect(result.sessionId).toBe("update-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/update/session",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({ targetVersion: "0.2.11" }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });

  it("exposes retry, cancel, and restart verification mutation helpers", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(session)));
    vi.stubGlobal("fetch", fetchMock);

    await retryUpdateSession();
    await cancelUpdateSession();
    await verifyUpdateRestart({ targetVersion: "0.2.11" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/update/session/retry",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/update/session",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/update/session/verify-restart",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ targetVersion: "0.2.11" }),
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
  });
});

describe("governed update remediation helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const remediation = {
    schemaVersion: 1,
    checkedAt: "2026-06-30T12:00:00.000Z",
    targetVersion: "0.2.11",
    overallStatus: "pending",
    updateCanComplete: false,
    actions: [],
    affectedFeatures: [],
    warnings: [],
  };

  it("fetchUpdateRemediationStatus reads the persisted remediation status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(remediation));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUpdateRemediationStatus();

    expect(result.overallStatus).toBe("pending");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/update/remediation",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("prepareUpdateRemediationStatus posts release impact through the CSRF gate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(remediation));
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      targetVersion: "0.2.11",
      impact: {
        affectedStateStores: ["local-knowledge"],
        remediation: "local-knowledge-reindex-required",
        userActionRequired: true,
      },
      persist: true,
    } as const;

    await prepareUpdateRemediationStatus(request);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/update/remediation/status",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify(request),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });

  it("runUpdateRemediationAction posts the selected action decision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(remediation));
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      actionId: "local-knowledge:reindex",
      targetVersion: "0.2.11",
      decision: "run",
    } as const;

    await runUpdateRemediationAction(request);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/update/remediation/actions",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify(request),
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
  });
});

describe("language-intelligence helpers (Issue #1201)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requestEditorDiagnostics posts a diagnostics operation and unwraps the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        operation: "diagnostics",
        result: {
          diagnostics: [{ range: {}, severity: "error", message: "x", source: "typescript" }],
          truncated: false,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestEditorDiagnostics({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "const x: number = 'no';\n",
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          operation: "diagnostics",
          root: "/repo",
          document: {
            path: "src/a.ts",
            languageId: "typescript",
            text: "const x: number = 'no';\n",
          },
        }),
      }),
    );
  });

  it("requestEditorHover posts a hover operation with the cursor position", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ operation: "hover", result: { contents: "x: number" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestEditorHover({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "const x = 1;\n",
      position: { line: 0, character: 6 },
    });

    expect(result.contents).toBe("x: number");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        body: JSON.stringify({
          operation: "hover",
          root: "/repo",
          document: { path: "src/a.ts", languageId: "typescript", text: "const x = 1;\n" },
          position: { line: 0, character: 6 },
        }),
      }),
    );
  });

  it("requestEditorSymbols posts a symbols operation and forwards the abort signal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ operation: "symbols", result: { symbols: [], truncated: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await requestEditorSymbols(
      { root: "/repo", path: "src/a.ts", languageId: "typescript", text: "export const a = 1;\n" },
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("requestEditorFormatting posts a formatting operation with indentation options", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ operation: "formatting", result: { edits: [], truncated: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await requestEditorFormatting({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "const x   =   1;\n",
      options: { tabSize: 2, insertSpaces: true },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        body: JSON.stringify({
          operation: "formatting",
          root: "/repo",
          document: { path: "src/a.ts", languageId: "typescript", text: "const x   =   1;\n" },
          options: { tabSize: 2, insertSpaces: true },
        }),
      }),
    );
  });
});

describe("fetchWorkspaceSummary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the workspace summary route with required dir and optional filters", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          summary: {
            root: "/repo",
            sourceDirs: [],
            testDirs: [],
            languages: [],
            counts: { discovered: 0, denied: 0, ignored: 0 },
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkspaceSummary({ dir: "/repo" });
    await fetchWorkspaceSummary({ dir: "/repo space", task: "src/index.ts", budget: 128 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/workspace?dir=%2Frepo",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/workspace?dir=%2Frepo+space&task=src%2Findex.ts&budget=128",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });
});

describe("files API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes directory picker, tree, preview, and editor requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ path: "/repo space", parent: null, entries: [], roots: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ root: "/repo space", path: "src/app.ts", entries: [], truncated: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          root: "/repo space",
          path: "src/app.ts",
          name: "app.ts",
          sizeBytes: 10,
          modifiedAt: 1,
          extension: "ts",
          mime: "text/plain",
          symlink: false,
          kind: "text",
          content: "const x = 1;\n",
          truncated: false,
          maxBytes: 1_000_000,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          root: "/repo space",
          path: "src/app.ts",
          name: "app.ts",
          sizeBytes: 10,
          modifiedAt: 1,
          extension: "ts",
          mime: "text/plain",
          symlink: false,
          content: "const x = 1;\n",
          maxBytes: 1_000_000,
          session: {
            schemaVersion: "1",
            version: { sizeBytes: 10, modifiedAt: 1, contentHash: "a".repeat(64) },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          root: "/repo space",
          path: "src/app.ts",
          name: "app.ts",
          sizeBytes: 10,
          modifiedAt: 2,
          extension: "ts",
          mime: "text/plain",
          symlink: false,
          content: "const x = 2;\n",
          maxBytes: 1_000_000,
          session: {
            schemaVersion: "1",
            version: { sizeBytes: 10, modifiedAt: 2, contentHash: "b".repeat(64) },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchFilesDirectories("/repo space");
    await fetchFilesTree("/repo space", "src/app.ts");
    await fetchFilesPreview("/repo space", "src/app.ts");
    await fetchFilesContent("/repo space", "src/app.ts");
    await saveFilesContent({
      root: "/repo space",
      path: "src/app.ts",
      content: "const x = 2;\n",
      expectedModifiedAt: 1,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/files/directories?root=%2Frepo+space",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/files/tree?root=%2Frepo+space&path=src%2Fapp.ts",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/files/preview?root=%2Frepo+space&path=src%2Fapp.ts",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/files/content?root=%2Frepo+space&path=src%2Fapp.ts",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/files/content",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          root: "/repo space",
          path: "src/app.ts",
          content: "const x = 2;\n",
          expectedModifiedAt: 1,
        }),
      }),
    );
  });

  it("encodes repository file search requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        root: "/repo space",
        query: "coding context",
        results: [],
        truncated: false,
        scannedFileCount: 0,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchFilesSearch("/repo space", "coding context", 12);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/search?root=%2Frepo+space&q=coding+context&limit=12",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("serializes the version-aware baseVersion token on save (Issue #1197)", async () => {
    const baseVersion = { sizeBytes: 12, modifiedAt: 7, contentHash: "a".repeat(64) };
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        root: "/repo",
        path: "src/app.ts",
        name: "app.ts",
        sizeBytes: 13,
        modifiedAt: 9,
        extension: "ts",
        mime: "text/plain",
        symlink: false,
        content: "const x = 3;\n",
        maxBytes: 1_000_000,
        session: {
          schemaVersion: "1",
          version: { sizeBytes: 13, modifiedAt: 9, contentHash: "b".repeat(64) },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const saved = await saveFilesContent({
      root: "/repo",
      path: "src/app.ts",
      content: "const x = 3;\n",
      baseVersion,
    });

    expect(saved.session.version.contentHash).toBe("b".repeat(64));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/content",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          root: "/repo",
          path: "src/app.ts",
          content: "const x = 3;\n",
          baseVersion,
        }),
      }),
    );
  });

  it("encodes Git status, branch list, and diff requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: "1",
          root: "/repo space",
          repositoryRoot: "/repo space",
          state: "available",
          available: true,
          branch: "main",
          detached: false,
          clean: false,
          stagedCount: 0,
          unstagedCount: 1,
          untrackedCount: 0,
          conflictedCount: 0,
          changes: [],
          truncated: false,
          maxChanges: 500,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: "1",
          root: "/repo space",
          repositoryRoot: "/repo space",
          available: true,
          state: "available",
          branches: [{ name: "main", headRefHash: "abc123", current: true }],
          truncated: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: "1",
          root: "/repo space",
          repositoryRoot: "/repo space",
          state: "available",
          available: true,
          path: "src/app.ts",
          scope: "worktree",
          diff: "diff --git a/src/app.ts b/src/app.ts\n",
          truncated: false,
          maxBytes: 131072,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchGitStatus("/repo space");
    await fetchGitBranches("/repo space");
    await fetchGitDiff({ root: "/repo space", path: "src/app.ts", scope: "worktree" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/git/status?root=%2Frepo+space",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/git/branches?root=%2Frepo+space",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/git/diff?root=%2Frepo+space&path=src%2Fapp.ts&scope=worktree",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("encodes Git summary, history, and remotes requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: "1",
          root: "/repo space",
          state: "available",
          available: true,
          branch: "main",
          detached: false,
          ahead: 0,
          behind: 0,
          stagedCount: 0,
          unstagedCount: 0,
          untrackedCount: 0,
          conflictedCount: 0,
          clean: true,
          remotes: [],
          truncated: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: "1",
          root: "/repo space",
          state: "available",
          available: true,
          entries: [],
          limit: 25,
          skip: 50,
          truncated: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: "1",
          root: "/repo space",
          state: "available",
          available: true,
          remotes: [],
          truncated: false,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchGitSummary("/repo space");
    await fetchGitHistory({ root: "/repo space", limit: 25, skip: 50 });
    await fetchGitRemotes("/repo space");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/git/summary?root=%2Frepo+space",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/git/history?root=%2Frepo+space&limit=25&skip=50",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/git/remotes?root=%2Frepo+space",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("posts fetch and pull sync preview/execute envelopes with CSRF", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: "1",
          operation: "fetch",
          available: true,
          state: "available",
          branch: "main",
          detached: false,
          ahead: 0,
          behind: 0,
          hasRemote: true,
          hasUpstream: true,
          dirty: false,
          executable: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: "1",
          operation: "pull",
          status: "succeeded",
          available: true,
          branch: "main",
          truncated: false,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchGitDeliverySyncPreview({
      operation: "fetch",
      projectId: "/repo space",
      remote: "origin",
    });
    await fetchGitDeliverySyncExecute({
      operation: "pull",
      projectId: "/repo space",
      remote: "origin",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/git-delivery/fetch/preview",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          schemaVersion: "1",
          projectId: "/repo space",
          remote: "origin",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/git-delivery/pull/execute",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          schemaVersion: "1",
          projectId: "/repo space",
          remote: "origin",
        }),
      }),
    );
  });
});

describe("fetchModels", () => {
  afterEach(() => {
    clearModelCacheForTests();
    vi.unstubAllGlobals();
  });

  it("reuses the in-flight model registry request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([fetchModels(), fetchModels()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("clears the model registry cache after a failed request", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchModels().then(
      () => {
        throw new Error("Expected fetchModels to reject.");
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("offline");
      },
    );
    await expect(fetchModels()).resolves.toEqual({ models: [] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchVoiceCapability (Issue #493)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the content-free voice capability from /api/voice/capability", async () => {
    const voice = {
      available: true,
      profile: "speech-to-text",
      capabilities: { speechToText: true, speechOutput: false, realtimeVoice: false },
      transport: { websocketControl: true, webrtcMedia: false },
      providerLocality: "azure-foundry",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ voice }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchVoiceCapability()).resolves.toEqual({ voice });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/capability",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("surfaces an unavailable resolution without throwing", async () => {
    const voice = {
      available: false,
      profile: "none",
      capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
      transport: { websocketControl: false, webrtcMedia: false },
      reason: "no-voice-provider",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ voice }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchVoiceCapability()).resolves.toEqual({ voice });
  });
});

describe("transcribeDictation (Issue #495)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts base64 audio to /api/voice/transcribe with the JSON + CSRF envelope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ transcript: "hello there", confidence: 0.92 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeDictation({
      audio: "QUJDRA==",
      mimeType: "audio/webm",
      durationMs: 1500,
      language: "en",
    });

    expect(result).toEqual({ transcript: "hello there", confidence: 0.92 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/transcribe",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          audio: "QUJDRA==",
          mimeType: "audio/webm",
          durationMs: 1500,
          language: "en",
        }),
      }),
    );
  });

  it("propagates a coded ApiError (e.g. VOICE_UNAVAILABLE) without logging the body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: { code: "VOICE_UNAVAILABLE", message: "Speech-to-text is not available." } },
          503,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribeDictation({ audio: "QUJDRA==", mimeType: "audio/webm" }),
    ).rejects.toMatchObject({ code: "VOICE_UNAVAILABLE", status: 503 });
  });

  it("maps a provider error to a transcribe ApiError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: { code: "VOICE_PROVIDER_ERROR", message: "Could not transcribe the audio." } },
          502,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const error = await transcribeDictation({ audio: "QUJDRA==", mimeType: "audio/webm" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("VOICE_PROVIDER_ERROR");
  });
});

describe("runGatewayReadiness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the optional model id and deep probe options without clearing the model cache", async () => {
    const report = {
      modelId: "test-chat-model",
      checkedAt: "2026-06-24T09:00:00.000Z",
      overallStatus: "ready",
      probes: [],
      verifiedCapabilities: {},
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(report));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runGatewayReadiness("test-chat-model", { includeDeepProbes: true }),
    ).resolves.toEqual(report);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/gateway/readiness",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          modelId: "test-chat-model",
          options: { includeDeepProbes: true },
        }),
      }),
    );
  });
});

describe("fetchProjects", () => {
  afterEach(() => {
    clearProjectRequestForTests();
    vi.unstubAllGlobals();
  });

  it("reuses the in-flight project list request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ projects: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([fetchProjects(), fetchProjects(), fetchProjects()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("does not cache a resolved project list response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ projects: [{ path: "/repo/a" }] }))
      .mockResolvedValueOnce(jsonResponse({ projects: [{ path: "/repo/b" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchProjects()).resolves.toEqual({ projects: [{ path: "/repo/a" }] });
    await expect(fetchProjects()).resolves.toEqual({ projects: [{ path: "/repo/b" }] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("cloneRepository", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a repository clone request with the CSRF header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        project: {
          path: "/repo/app",
          name: "app",
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 1,
          available: true,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cloneRepository({
        repositoryUrl: "https://github.com/acme/app.git",
        destinationPath: "/repo/app",
      }),
    ).resolves.toMatchObject({ project: { path: "/repo/app", name: "app" } });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repositories/clone",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          repositoryUrl: "https://github.com/acme/app.git",
          destinationPath: "/repo/app",
        }),
      }),
    );
  });
});

describe("delete helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats 204 DELETE responses as success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteProject("/repo/project");
    await deleteChat("chat-123");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/projects?path=%2Frepo%2Fproject",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: "{}",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/chats?id=chat-123",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: "{}",
      }),
    );
  });

  it("propagates fetch network errors for deleteProject and deleteChat", async () => {
    const networkError = new TypeError("fetch failed");
    const fetchMock = vi.fn().mockRejectedValue(networkError);
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteProject("/repo/project")).rejects.toBe(networkError);
    await expect(deleteChat("chat-123")).rejects.toBe(networkError);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/projects?path=%2Frepo%2Fproject",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/chats?id=chat-123",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

// Issue #185 — grounded repository Q&A wire helper.
describe("askGrounded", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the request body and CSRF header to /api/chats/messages/grounded", async () => {
    const response = {
      userMessageId: "msg-u",
      assistantMessageId: "msg-a",
      content: "Inspected 1 file(s) for: how does foo work?",
      citations: [
        {
          scopePath: "src/foo.ts",
          lineRange: { startLine: 1, endLine: 10 },
          score: 0.8,
          stableId: "atom-1",
        },
      ],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 42,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await askGrounded({
      chatId: "chat-1",
      content: "how does foo work?",
      modelId: "example-chat-model",
    });
    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/messages/grounded",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chatId: "chat-1",
          content: "how does foo work?",
          modelId: "example-chat-model",
        }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });

  it("rejects with an AbortError when the signal is aborted before the fetch resolves", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new DOMException("The user aborted a request.", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = askGrounded(
      { chatId: "chat-1", content: "q", modelId: "example-chat-model" },
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ---------------------------------------------------------------------------
// consumeSseStream — residual lineBuffer flush (Issue #3 / WP-API)
// ---------------------------------------------------------------------------

function makeSseStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx++]));
      } else {
        controller.close();
      }
    },
  });
}

function makeStreamHandlers(overrides: Partial<StreamHandlers> = {}): StreamHandlers {
  return {
    onToken: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onCancelled: vi.fn(),
    ...overrides,
  };
}

function makeSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("sendDesktopChatStream — SSE residual lineBuffer flush", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ITEM #3: a 'done' frame whose final data line arrives WITHOUT a trailing \n
  // must still dispatch onDone. Against the pre-fix code this test is RED
  // because the residual lineBuffer is never flushed when read.done fires.
  it("dispatches onDone when the final done frame has no trailing newline", async () => {
    const donePayload = { chat: { id: "c1" }, messages: [] };
    // Normal SSE: two chunks. First carries the event line + data line.
    // Second chunk is the data payload with NO trailing \n\n — simulating a
    // proxy that drops the terminal blank line.
    const stream = makeSseStream([
      "event: done\n",
      `data: ${JSON.stringify(donePayload)}`, // intentionally no trailing \n
    ]);

    const handlers = makeStreamHandlers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSseResponse(stream)));

    await sendDesktopChatStream(
      { chatId: "c1", projectPath: "/repo", content: "hello" },
      new AbortController().signal,
      handlers,
    );

    expect(handlers.onDone).toHaveBeenCalledTimes(1);
    expect(handlers.onDone).toHaveBeenCalledWith(expect.objectContaining({ chat: { id: "c1" } }));
    expect(handlers.onToken).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  // Regression: normal \n\n-terminated streams must still work correctly.
  it("dispatches onDone for a normally newline-terminated done frame", async () => {
    const donePayload = { chat: { id: "c2" }, messages: [] };
    const stream = makeSseStream([`event: done\ndata: ${JSON.stringify(donePayload)}\n\n`]);

    const handlers = makeStreamHandlers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSseResponse(stream)));

    await sendDesktopChatStream(
      { chatId: "c2", projectPath: "/repo", content: "hello" },
      new AbortController().signal,
      handlers,
    );

    expect(handlers.onDone).toHaveBeenCalledTimes(1);
    expect(handlers.onError).not.toHaveBeenCalled();
  });
});

describe("regenerateDesktopChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the assistant turn id to the regenerate route with CSRF and an abort signal", async () => {
    const controller = new AbortController();
    const response = { chat: { id: "chat-1" }, messages: [{ id: "a1", role: "assistant" }] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await regenerateDesktopChat(
      {
        chatId: "chat-1",
        projectPath: "/repo",
        assistantMessageId: "a1",
        modelId: "example-chat-model",
        memory: { enabled: false, context: { userId: "user-1" } },
      },
      controller.signal,
    );

    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/desktop/chat/regenerate",
      expect.objectContaining({
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          chatId: "chat-1",
          projectPath: "/repo",
          assistantMessageId: "a1",
          modelId: "example-chat-model",
          memory: { enabled: false, context: { userId: "user-1" } },
        }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });
});

describe("synthesizeAssistantSpeech (Issue #1558)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the visible text inside the JSON + CSRF envelope and returns the audio", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ audio: "QUJDRA==", mimeType: "audio/mpeg" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesizeAssistantSpeech({ text: "the visible answer" });

    expect(result).toEqual({ audio: "QUJDRA==", mimeType: "audio/mpeg" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/speak",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({ text: "the visible answer" }),
      }),
    );
  });

  it("forwards an abort signal so a stop / mute can cancel pending synthesis", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ audio: "QUJDRA==", mimeType: "audio/mpeg" }));
    vi.stubGlobal("fetch", fetchMock);

    await synthesizeAssistantSpeech({ text: "answer" }, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/speak",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("surfaces a content-free VOICE_UNAVAILABLE as an ApiError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { code: "VOICE_UNAVAILABLE", message: "unavailable" } }, 503),
      );
    vi.stubGlobal("fetch", fetchMock);

    const error = await synthesizeAssistantSpeech({ text: "answer" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("VOICE_UNAVAILABLE");
    expect((error as ApiError).status).toBe(503);
  });
});

describe("pdf citation preview api helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens a preview session through the local-knowledge BFF route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        outcome: "authorized",
        display: {
          documentLabel: "Policy wording.pdf",
          sourceLabel: "Local capsule",
          pageNumber: 7,
          pageLabel: "Page 7",
          anchorQuality: "page-only",
        },
        session: {
          handle: "preview-session-1",
          expiresAt: "2026-06-28T12:00:00.000Z",
          reused: false,
          byteLength: 4096,
          contentType: "application/pdf",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await openPdfCitationPreviewSession({
      chatId: "chat-1",
      assistantMessageId: "msg-1",
      marker: 3,
      stableId: "stable-1",
    });

    expect(response.outcome).toBe("authorized");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/citation-preview/open",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          chatId: "chat-1",
          assistantMessageId: "msg-1",
          marker: 3,
          stableId: "stable-1",
        }),
      }),
    );
  });

  it("closes a preview session through the DELETE route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await closePdfCitationPreviewSession("preview/session#1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/citation-preview/sessions/preview%2Fsession%231",
      expect.objectContaining({
        method: "DELETE",
        body: "{}",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });

  it("passes an expected preview session version when closing a session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await closePdfCitationPreviewSession("preview/session#1", "2026-06-28T12:00:00.000Z");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/citation-preview/sessions/preview%2Fsession%231",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ expectedExpiresAt: "2026-06-28T12:00:00.000Z" }),
      }),
    );
  });

  it("fetches preview PDF bytes without JSON headers and forwards an abort signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const bytes = await fetchPdfCitationPreviewDocument("preview/session#1", controller.signal);

    expect(Array.from(bytes)).toEqual([9, 8, 7]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/citation-preview/sessions/preview%2Fsession%231/document",
      expect.objectContaining({
        cache: "no-store",
        signal: controller.signal,
        headers: expect.objectContaining({
          Accept: "application/pdf",
        }),
      }),
    );
  });

  it("builds an encoded preview PDF document URL for PDF.js range loading", () => {
    expect(pdfCitationPreviewDocumentUrl("preview/session#1")).toBe(
      "/api/local-knowledge/citation-preview/sessions/preview%2Fsession%231/document",
    );
  });
});
