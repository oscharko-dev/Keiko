import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askGrounded,
  applyWorkspaceReplace,
  applyGatewayVerifiedCapabilities,
  cloneRepository,
  resetConfigRequestCache,
  resetModelRequestCache,
  clearVoiceCapabilityCacheForTests,
  clearProjectRequestForTests,
  deleteChat,
  deleteProject,
  closePdfCitationPreviewSession,
  fetchFilesContent,
  fetchFilesPreview,
  fetchFilesSearch,
  fetchFilesTree,
  fetchWorkspaceSearch,
  fetchWorkspaceSymbols,
  fetchWorkspaceReplacePreview,
  fetchGitBranches,
  fetchGitDeliverySyncExecute,
  fetchGitDeliverySyncPreview,
  fetchGitDiff,
  fetchGitStructuredDiff,
  fetchGitBlame,
  fetchGitHistory,
  fetchGitRemotes,
  fetchGitSummary,
  fetchGitStatus,
  fetchConfig,
  fetchModels,
  fetchManagedLspSettings,
  fetchNativeFileDialogCapability,
  fetchPdfCitationPreviewDocument,
  fetchProjects,
  openNativeFileDialog,
  mutateManagedLspSettings,
  regenerateDesktopChat,
  fetchStartupUpdatePreflight,
  fetchUpdateRemediationStatus,
  fetchUpdateSessionStatus,
  fetchVoiceCapability,
  openPdfCitationPreviewSession,
  postEditorAgentActionResult,
  postEditorAgentSessionSnapshot,
  queueEditorAgentBridgeAction,
  pdfCitationPreviewDocumentUrl,
  prepareUpdateRemediationStatus,
  reconnectProject,
  runGatewayReadiness,
  setupGateway,
  checkUpdatePreflight,
  cancelUpdateSession,
  retryUpdateSession,
  runUpdateRemediationAction,
  startUpdateSession,
  requestEditorCodeActions,
  requestEditorCompletion,
  requestEditorDefinition,
  requestEditorTypeDefinition,
  requestEditorImplementation,
  requestEditorCallHierarchy,
  requestEditorInlayHints,
  requestEditorSemanticTokens,
  requestEditorDiagnostics,
  requestEditorFormatting,
  requestEditorHover,
  requestEditorReferences,
  requestEditorRenameApply,
  requestEditorRenamePrepare,
  requestEditorSignatureHelp,
  requestEditorSymbols,
  saveFilesContent,
  sendDesktopChatStream,
  fetchWorkspaceSummary,
  transcribeDictation,
  synthesizeAssistantSpeech,
  verifyUpdateRestart,
  ApiError,
  StreamingUnavailableError,
  type StreamHandlers,
  fetchEditorLocalHistory,
  fetchEditorLocalHistoryEntry,
  setEditorLocalHistoryPinned,
  deleteEditorLocalHistory,
  mutateEditorProfile,
  exportEditorProfile,
  previewEditorProfileImport,
  applyEditorProfileImport,
  previewCodingWorkbenchIssue,
  fetchGitHubIssueReaderAuthorization,
  updateGitHubIssueReaderAuthorization,
  fetchCodingWorkbenchJourneyRefresh,
  connectGitChangeToChat,
  refreshGitChangeScope,
  fetchGitDeliveryCommitApprove,
  fetchGitDeliveryPushApprove,
  fetchGitDeliveryPrApprove,
  fetchGitDeliveryPrMarkReadyApprove,
  fetchGitDeliveryPrMarkReadyExecute,
  proposePrMarkReady,
  proposeCommit,
  proposePush,
  fetchGitDeliveryPrDescriptionPreview,
  fetchGitDeliveryPrDescriptionApprove,
  fetchGitDeliveryPrDescriptionApply,
  fetchGitDeliveryPrDescriptionStatus,
  applyGitChangeChatDescription,
  type GitHubIssuePreviewResponseWire,
} from "./api";
import {
  MANAGED_LSP_TEST_LANGUAGES,
  managedLspTestConfigurationDefaults,
} from "@/test-utils/managed-lsp-settings-fixture";
import { CORRELATION_HEADER } from "./bff-correlation";
import { journeyFixture } from "@/app/components/desktop/widgets/coding-workbench/_journeyOutcomeTestSupport";
import {
  isGitObjectId,
  isSafeGitRefName,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository";

const API_SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "api.ts"), "utf8");
const MANAGED_LSP_VALIDATORS_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "managed-lsp-response-validators.ts"),
  "utf8",
);

describe("managed language settings API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads managed LSP response validation through its dedicated lazy adapter", () => {
    const eagerContractsImports = [
      ...API_SOURCE.matchAll(
        /import\s*\{([\s\S]*?)\}\s*from\s*["']@oscharko-dev\/keiko-contracts["'];/gu,
      ),
    ]
      .map((match) => match[1] ?? "")
      .join("\n");

    expect(eagerContractsImports).not.toContain("parseManagedLspControlResponse");
    expect(eagerContractsImports).not.toContain("parseManagedLspControlMutationResponse");
    expect(API_SOURCE).toContain('import("./managed-lsp-response-validators")');

    const adapterImport = MANAGED_LSP_VALIDATORS_SOURCE.match(
      /import\s*\{([\s\S]*?)\}\s*from\s*"@oscharko-dev\/keiko-contracts\/runtime\/managed-lsp-route";/u,
    );
    expect(
      (adapterImport?.[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
        .sort(),
    ).toEqual(["parseManagedLspControlMutationResponse", "parseManagedLspControlResponse"]);
  });

  it("encodes the workspace root and forwards abortable no-store reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(managedLspSettingsResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await fetchManagedLspSettings("/workspace/a b", controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/lsp/settings?root=%2Fworkspace%2Fa%20b",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it("fails closed when the managed language settings envelope is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ languages: [] })));

    await expect(fetchManagedLspSettings("/workspace/a")).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  it("sends revision, CSRF, ETag, idempotency, and cancellation on mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(managedLspMutationResponse(4)));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await mutateManagedLspSettings(
      { root: "/workspace/a", language: "python", action: "restart", expectedRevision: 3 },
      '"lspcfg-3-abcdefghijklmnop"',
      "request-1",
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/lsp/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          root: "/workspace/a",
          language: "python",
          action: "restart",
          expectedRevision: 3,
        }),
        headers: expect.objectContaining({
          "X-Keiko-CSRF": "1",
          "If-Match": '"lspcfg-3-abcdefghijklmnop"',
          "Idempotency-Key": "request-1",
        }),
        signal: controller.signal,
      }),
    );
  });

  it("fails closed when the managed language mutation envelope is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ kind: "ok", revision: 4, etag: '"lspcfg-4-abcdefghijklmnop"' }),
        ),
    );

    await expect(
      mutateManagedLspSettings(
        { root: "/workspace/a", language: "python", action: "restart", expectedRevision: 3 },
        '"lspcfg-3-abcdefghijklmnop"',
        "request-1",
      ),
    ).rejects.toMatchObject({ code: "CONTRACT_VALIDATION_FAILED", status: 502 });
  });
});

function managedLspStatus(
  revision: number,
  language: (typeof MANAGED_LSP_TEST_LANGUAGES)[number] = "python",
): Record<string, unknown> {
  return {
    ok: true,
    schemaVersion: "1",
    language,
    configurationRevision: revision,
    state: "disabled",
    reasonCode: "WORKSPACE_ACTIVATION_UNSET",
    policyResult: "allowed",
  };
}

function managedLspSetting(
  language: (typeof MANAGED_LSP_TEST_LANGUAGES)[number],
): Record<string, unknown> {
  return {
    language,
    workspaceActivation: "unset",
    configured: false,
    restartRequired: false,
    restartFields: [],
    provenance: null,
  };
}

function managedLspSettingsResponse(): Record<string, unknown> {
  return {
    storeState: "absent",
    revision: 0,
    etag: '"lspcfg-0-abcdefghijklmnop"',
    evidenceCount: 0,
    languages: MANAGED_LSP_TEST_LANGUAGES.map((language) => managedLspStatus(0, language)),
    settings: MANAGED_LSP_TEST_LANGUAGES.map(managedLspSetting),
    configurations: [],
    configurationDefaults: managedLspTestConfigurationDefaults(0, '"lspcfg-0-abcdefghijklmnop"'),
    health: [],
    providerMetadata: [],
  };
}

function managedLspMutationResponse(revision: number): Record<string, unknown> {
  return {
    kind: "ok",
    changed: true,
    revision,
    etag: `"lspcfg-${String(revision)}-abcdefghijklmnop"`,
    status: managedLspStatus(revision),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("editor agent bridge capability serialization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches the capability only to explicit bridge request envelopes", async () => {
    const capability = "A".repeat(43);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ snapshot: null, bridgeDecisionCapability: capability }))
      .mockResolvedValueOnce(jsonResponse({ result: { status: "succeeded" } }))
      .mockResolvedValueOnce(jsonResponse({ result: { status: "queued" } }));
    vi.stubGlobal("fetch", fetchMock);
    const snapshot = {
      schemaVersion: "1",
      sessionId: "session-1",
      windowId: "window-1",
      workspaceRoot: "/repo",
      activePaneId: "pane-1",
      panes: [{ paneId: "pane-1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
      dirtyFiles: [],
      activeFile: "src/a.ts",
      cursor: null,
      selection: null,
      diagnosticsSummary: null,
      activeFileContentHash: "a".repeat(64),
      textMode: "none",
      updatedAt: 1,
    } as const;

    await postEditorAgentSessionSnapshot(snapshot, capability);
    await postEditorAgentActionResult({
      schemaVersion: "1",
      kind: "result",
      bridgeDecisionCapability: capability,
      result: {
        schemaVersion: "1",
        actionId: "action-1",
        sessionId: "session-1",
        status: "succeeded",
      },
    });
    const action = {
      schemaVersion: "1",
      actionId: "action-2",
      idempotencyKey: "key-2",
      sessionId: "session-1",
      type: "applyPatch",
      patch: "patch",
    } as const;
    await queueEditorAgentBridgeAction(action, capability);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/editor/agent/snapshot",
      expect.objectContaining({
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "snapshot",
          snapshot,
          bridgeDecisionCapability: capability,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/editor/agent/actions",
      expect.objectContaining({
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "result",
          bridgeDecisionCapability: capability,
          result: {
            schemaVersion: "1",
            actionId: "action-1",
            sessionId: "session-1",
            status: "succeeded",
          },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/editor/agent/actions",
      expect.objectContaining({
        body: JSON.stringify({
          schemaVersion: "1",
          kind: "action",
          action,
          bridgeDecisionCapability: capability,
        }),
      }),
    );
  });
});

describe("Coding Workbench provider API isolation (issue #2639)", () => {
  it("keeps CodingWorkbench provider validators out of api.ts eager imports", () => {
    // The three provider profile fetchers live in ./coding-workbench-provider-api so that the
    // desktop shell's first-load chunk does not drag in `coding-workbench` /
    // `coding-workbench-evidence` (~12 KiB gzip) via the codex-auth validators. Any regression
    // that re-eagerly imports them from ./api will fail this assertion (and, once CI/Linux
    // measures it, the check:editor-bundle-size ceiling).
    const eagerContractsImports = [
      ...API_SOURCE.matchAll(
        /import\s*\{([\s\S]*?)\}\s*from\s*["']@oscharko-dev\/keiko-contracts["'];/gu,
      ),
    ]
      .map((match) => match[1] ?? "")
      .join("\n");

    expect(eagerContractsImports).not.toContain("validateCodingWorkbenchCodexSubscriptionProfile");
    expect(eagerContractsImports).not.toContain("validateCodingWorkbenchCodexAuthSetupPlan");
    expect(API_SOURCE).not.toContain("fetchCodingWorkbenchSidecarGatewayProfile");
    expect(API_SOURCE).not.toContain("fetchCodingWorkbenchCodexSubscriptionProfile");
    expect(API_SOURCE).not.toContain("prepareCodingWorkbenchCodexSubscriptionSetup");
  });
});

describe("Coding Workbench issue/journey/PR-description lazy adapter (epic #3384 final-audit F18)", () => {
  it("keeps the issue-preview, journey-refresh and PR-description-application validators out of api.ts's eager imports", () => {
    // `previewCodingWorkbenchIssue`, `fetchCodingWorkbenchJourneyRefresh` and the
    // `fetchGitDeliveryPrDescription*` fetchers keep their names, signatures and behaviour in
    // api.ts (every existing caller — in and out of the Coding Workbench tree — is unaffected), but
    // their contract validators moved to ./coding-workbench-lazy-fetchers, loaded only through
    // `await import(...)` at call time (the same technique already proven by
    // managed-lsp-response-validators.ts above). Before this fix these five bindings landed in
    // api.ts's own eager `@oscharko-dev/keiko-contracts/runtime/*` imports, pulling
    // `coding-workbench-runtime` (via `isGitHubOwnerAndRepo` and the issue-preview bounds),
    // `git-journey-validation` (via `isJourneyOutcome`), `pr-description` (via
    // `PR_DESCRIPTION_LANGUAGES`) and `pr-description-application` (via
    // `isPrDescriptionApplicationStatus`/`PR_DESCRIPTION_APPLICATION_REASON_STATES`) into the
    // desktop shell's first-load chunk (~11 KiB gzip).
    const eagerContractsRuntimeImports = [
      ...API_SOURCE.matchAll(
        /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*["']@oscharko-dev\/keiko-contracts\/runtime\/[^"']+["'];/gu,
      ),
    ]
      .map((match) => match[1] ?? "")
      .join("\n");

    expect(eagerContractsRuntimeImports).not.toContain("isGitHubOwnerAndRepo");
    expect(eagerContractsRuntimeImports).not.toContain(
      "CODING_WORKBENCH_ISSUE_PREVIEW_TITLE_MAX_CHARS",
    );
    expect(eagerContractsRuntimeImports).not.toContain(
      "CODING_WORKBENCH_ISSUE_PREVIEW_EXCERPT_MAX_CHARS",
    );
    expect(eagerContractsRuntimeImports).not.toContain("GITHUB_ISSUE_NUMBER_MAX");
    expect(eagerContractsRuntimeImports).not.toContain("isJourneyOutcome");
    expect(eagerContractsRuntimeImports).not.toContain("PR_DESCRIPTION_LANGUAGES");
    expect(eagerContractsRuntimeImports).not.toContain("isPrDescriptionApplicationStatus");
    expect(eagerContractsRuntimeImports).not.toContain("PR_DESCRIPTION_APPLICATION_REASON_STATES");
    expect(API_SOURCE).toContain('import("./coding-workbench-lazy-fetchers")');
  });
});

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
      editorSessionId: "editor-session-1",
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
          editorSessionId: "editor-session-1",
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

  it("requestEditorDefinition posts a definition operation with the cursor position", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ operation: "definition", result: { locations: [], truncated: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await requestEditorDefinition({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "foo();\n",
      position: { line: 0, character: 1 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        body: JSON.stringify({
          operation: "definition",
          root: "/repo",
          document: { path: "src/a.ts", languageId: "typescript", text: "foo();\n" },
          position: { line: 0, character: 1 },
        }),
      }),
    );
  });

  it("posts type-definition, implementation, call-hierarchy, and inlay-hints operations", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          operation: "navigation",
          result: { locations: [], roots: [], hints: [] },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "foo();\n",
    };

    await requestEditorTypeDefinition({ ...input, position: { line: 0, character: 1 } });
    await requestEditorImplementation({ ...input, position: { line: 0, character: 1 } });
    await requestEditorCallHierarchy({ ...input, position: { line: 0, character: 1 } });
    await requestEditorInlayHints({
      ...input,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
    });

    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).operation)).toEqual(
      ["typeDefinition", "implementation", "callHierarchy", "inlayHints"],
    );
  });

  it("posts a versioned Rust full-document semantic-token request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ schemaVersion: "1", supported: false }));
    vi.stubGlobal("fetch", fetchMock);

    await requestEditorSemanticTokens({
      root: "/repo",
      path: "src/lib.rs",
      text: "fn main() {}\n",
      version: 9,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language/semantic-tokens",
      expect.objectContaining({
        body: JSON.stringify({
          schemaVersion: "1",
          root: "/repo",
          document: {
            path: "src/lib.rs",
            languageId: "rust",
            text: "fn main() {}\n",
            version: 9,
          },
        }),
      }),
    );
  });

  it("requestEditorReferences posts a references operation with the cursor position", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        operation: "references",
        result: { locations: [], includesDeclaration: true, truncated: false },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await requestEditorReferences({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "foo();\n",
      position: { line: 0, character: 1 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        body: JSON.stringify({
          operation: "references",
          root: "/repo",
          document: { path: "src/a.ts", languageId: "typescript", text: "foo();\n" },
          position: { line: 0, character: 1 },
        }),
      }),
    );
  });

  it("requestEditorCodeActions posts a codeActions operation with range and diagnostics", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        operation: "codeActions",
        result: { actions: [], truncated: false, returnedCount: 0, totalCount: 0 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };

    await requestEditorCodeActions({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "foo",
      range,
      diagnostics: [{ range, severity: "error", message: "x", source: "typescript" }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        body: JSON.stringify({
          operation: "codeActions",
          root: "/repo",
          document: { path: "src/a.ts", languageId: "typescript", text: "foo" },
          range,
          diagnostics: [{ range, severity: "error", message: "x", source: "typescript" }],
        }),
      }),
    );
  });

  it("requestEditorSignatureHelp posts a signatureHelp operation with the cursor position", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        operation: "signatureHelp",
        result: {
          signatures: [],
          activeSignature: null,
          activeParameter: null,
          truncated: false,
          returnedCount: 0,
          totalCount: 0,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await requestEditorSignatureHelp({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "foo(",
      position: { line: 0, character: 4 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        body: JSON.stringify({
          operation: "signatureHelp",
          root: "/repo",
          document: { path: "src/a.ts", languageId: "typescript", text: "foo(" },
          position: { line: 0, character: 4 },
        }),
      }),
    );
  });

  it("requestEditorRenamePrepare posts a renamePrepare operation", async () => {
    const range = { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ operation: "renamePrepare", result: { range, placeholder: "foo" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await requestEditorRenamePrepare({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "foo",
      position: { line: 0, character: 1 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        body: JSON.stringify({
          operation: "renamePrepare",
          root: "/repo",
          document: { path: "src/a.ts", languageId: "typescript", text: "foo" },
          position: { line: 0, character: 1 },
        }),
      }),
    );
  });

  it("requestEditorRenameApply posts a renameApply operation with the new name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        operation: "renameApply",
        result: {
          schemaVersion: "1",
          files: [],
          truncated: false,
          filesTruncated: false,
          returnedFileCount: 0,
          totalFileCount: 0,
          returnedEditCount: 0,
          totalEditCount: 0,
          unreadableFileCount: 0,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await requestEditorRenameApply({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "foo",
      position: { line: 0, character: 1 },
      newName: "bar",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        body: JSON.stringify({
          operation: "renameApply",
          root: "/repo",
          document: { path: "src/a.ts", languageId: "typescript", text: "foo" },
          position: { line: 0, character: 1 },
          newName: "bar",
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

  it("encodes tree, preview, and editor requests", async () => {
    const fetchMock = vi
      .fn()
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
      "/api/files/tree?root=%2Frepo+space&path=src%2Fapp.ts",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/files/preview?root=%2Frepo+space&path=src%2Fapp.ts",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/files/content?root=%2Frepo+space&path=src%2Fapp.ts",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
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

  it("posts native dialog requests with the CSRF envelope and never logs paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        cancelled: false,
        selections: [{ path: "/repo space/docs", kind: "directory" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await openNativeFileDialog({
      mode: "open-directory",
      title: "Ordner wählen",
      defaultPath: "/repo space",
    });

    expect(response.selections[0]?.path).toBe("/repo space/docs");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/native-file-dialog/open",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          mode: "open-directory",
          title: "Ordner wählen",
          defaultPath: "/repo space",
        }),
      }),
    );
  });

  it("fetches the native dialog capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ supported: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchNativeFileDialogCapability()).resolves.toEqual({ supported: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/native-file-dialog/capability",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
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

  it("posts workspace search requests to the user-facing editor search route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [],
        truncated: false,
        filesScanned: 0,
        elapsedMs: 3,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkspaceSearch({
      root: "/repo",
      query: "needle",
      mode: "literal",
      caseSensitive: false,
      includeGlobs: ["src/**/*.ts"],
      excludeGlobs: ["dist/**"],
      maxResults: 25,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/workspace-search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          root: "/repo",
          query: "needle",
          mode: "literal",
          caseSensitive: false,
          includeGlobs: ["src/**/*.ts"],
          excludeGlobs: ["dist/**"],
          maxResults: 25,
        }),
      }),
    );
  });

  it("posts workspace replace preview and apply requests to the governed routes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          files: [],
          fileCount: 0,
          editCount: 0,
          truncated: false,
          omittedFileCount: 0,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ appliedCount: 1, conflictCount: 0, conflicts: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkspaceReplacePreview({
      root: "/repo",
      query: "needle",
      mode: "literal",
      caseSensitive: false,
      includeGlobs: [],
      excludeGlobs: [],
      replacement: "thread",
      maxFiles: 20,
    });
    await applyWorkspaceReplace({
      root: "/repo",
      files: [
        {
          path: "src/app.ts",
          baseContentHash: "a".repeat(64),
          edits: [
            {
              range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 7 },
              originalText: "needle",
              newText: "thread",
            },
          ],
        },
      ],
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/editor/workspace-search/replace-preview",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/editor/workspace-search/replace-apply",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
  });

  it("posts workspace symbol search requests to the governed symbol route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [],
        truncated: false,
        filesScanned: 0,
        elapsedMs: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkspaceSymbols({ root: "/repo", query: "parseConfig", maxResults: 20 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/workspace-symbols",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
        body: JSON.stringify({ root: "/repo", query: "parseConfig", maxResults: 20 }),
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

  it("rejects malformed contract-owned Git responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        schemaVersion: "1",
        root: "/repo space",
        state: "available",
        available: true,
        branch: "main",
        detached: false,
        clean: true,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        changes: "not-an-array",
        truncated: false,
        maxChanges: 500,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitStatus("/repo space")).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  it("encodes structured diff, blame, and optional ignored-status reads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: "1",
          scope: "staged",
          files: [],
          truncated: false,
          totalFiles: 0,
          totalBytes: 0,
          maxBytes: 524288,
          maxFiles: 400,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: "1",
          path: "src/a.ts",
          startLine: 1,
          lines: [],
          truncated: false,
          totalLines: 0,
          totalBytes: 0,
          maxBytes: 262144,
          maxLines: 2000,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          schemaVersion: "1",
          root: "/repo space",
          state: "available",
          available: true,
          branch: "main",
          detached: false,
          clean: true,
          stagedCount: 0,
          unstagedCount: 0,
          untrackedCount: 0,
          conflictedCount: 0,
          changes: [],
          truncated: false,
          maxChanges: 500,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchGitStructuredDiff({ root: "/repo space", path: "src/a.ts", scope: "staged" });
    await fetchGitBlame({ root: "/repo space", path: "src/a.ts", startLine: 1, maxLines: 20 });
    await fetchGitStatus("/repo space", { includeIgnored: true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/git/diff/structured?root=%2Frepo+space&scope=staged&path=src%2Fa.ts",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/git/blame?root=%2Frepo+space&path=src%2Fa.ts&startLine=1&maxLines=20",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/git/status?root=%2Frepo+space&includeIgnored=true",
      expect.any(Object),
    );
  });

  // #2906 review (comment 3865167732): fetchGitStructuredDiff had no `signal` parameter at all,
  // so the git-gutter bridge's per-refresh AbortController could never stop an in-flight
  // structured-diff request early -- a superseded refresh just had its stale result ignored on
  // arrival while the request kept running underneath it. This is a GET (read) request, so
  // fetchJson's withReadDeadline composes the caller's signal with its own read-deadline signal
  // (AbortSignal.any) rather than forwarding it verbatim -- same as the "abortable no-store reads"
  // case above -- so the assertion is that the composed signal reacts to the caller aborting, not
  // strict object identity.
  it("forwards an abort signal from fetchGitStructuredDiff to the underlying fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        schemaVersion: "1",
        scope: "staged",
        files: [],
        truncated: false,
        totalFiles: 0,
        totalBytes: 0,
        maxBytes: 524288,
        maxFiles: 400,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await fetchGitStructuredDiff(
      { root: "/repo", path: "src/a.ts", scope: "staged" },
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/git/diff/structured?root=%2Frepo&scope=staged&path=src%2Fa.ts",
      expect.any(Object),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal?.aborted).toBe(false);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
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
    resetModelRequestCache();
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

describe("setupGateway", () => {
  afterEach(() => {
    resetConfigRequestCache();
    resetModelRequestCache();
    clearVoiceCapabilityCacheForTests();
    vi.unstubAllGlobals();
  });

  it("maps browser transport failures to a setup-specific ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    let thrown: unknown;
    try {
      await setupGateway({ baseUrl: "https://api.openai.com/v1", apiKey: "secret" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({
      code: "GATEWAY_SETUP_NETWORK_ERROR",
      status: 0,
    } satisfies Partial<ApiError>);
    expect((thrown as Error).message).toContain("local setup service");
    expect((thrown as Error).message).not.toBe("Failed to fetch");
  });

  it.each([
    {
      name: "a non-network TypeError",
      rejection: new TypeError("request schema validation failed"),
    },
    {
      name: "a non-TypeError rejected value",
      rejection: { code: "PLAIN_OBJECT", message: "Failed to fetch" },
    },
  ])("rethrows $name unchanged", async ({ rejection }) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(rejection));

    await expect(
      setupGateway({ baseUrl: "https://api.openai.com/v1", apiKey: "secret" }),
    ).rejects.toBe(rejection);
  });

  it("preserves BFF setup errors instead of treating them as transport failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "GATEWAY_SETUP_FAILED",
              message: "Credentials could not be verified.",
            },
          },
          502,
        ),
      ),
    );

    await expect(
      setupGateway({ baseUrl: "https://api.openai.com/v1", apiKey: "secret" }),
    ).rejects.toMatchObject({
      code: "GATEWAY_SETUP_FAILED",
      status: 502,
    } satisfies Partial<ApiError>);
  });
});

describe("fetchConfig", () => {
  afterEach(() => {
    resetConfigRequestCache();
    vi.unstubAllGlobals();
  });

  it("reuses the in-flight config request across simultaneous callers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        config: null,
        configPresent: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([fetchConfig(), fetchConfig(), fetchConfig()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/config",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("clears the config request cache after a failed request", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(jsonResponse({ config: null, configPresent: false }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchConfig().then(
      () => {
        throw new Error("Expected fetchConfig to reject.");
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("offline");
      },
    );
    await expect(fetchConfig()).resolves.toMatchObject({ configPresent: false });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchVoiceCapability (Issue #493)", () => {
  afterEach(() => {
    clearVoiceCapabilityCacheForTests();
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

  it("shares one in-flight and fulfilled capability probe until configuration changes", async () => {
    const voice = {
      available: false,
      profile: "none",
      capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
      transport: { websocketControl: false, webrtcMedia: false },
      reason: "no-voice-provider",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ voice }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([fetchVoiceCapability(), fetchVoiceCapability(), fetchVoiceCapability()]);
    await fetchVoiceCapability();

    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("encodes the model id and patches only the explicitly confirmed verified fields", async () => {
    const model = { id: "model/one", toolCalling: false };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, model }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      applyGatewayVerifiedCapabilities("model/one", { toolCalling: false }),
    ).resolves.toEqual({ ok: true, model });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/gateway/capabilities/model%2Fone",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ fields: { toolCalling: false } }),
      }),
    );
  });
});

describe("fetchProjects", () => {
  afterEach(() => {
    clearProjectRequestForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it("caches a resolved project list briefly and refreshes after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ projects: [{ path: "/repo/a" }] }))
      .mockResolvedValueOnce(jsonResponse({ projects: [{ path: "/repo/b" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchProjects()).resolves.toEqual({ projects: [{ path: "/repo/a" }] });
    await expect(fetchProjects()).resolves.toEqual({ projects: [{ path: "/repo/a" }] });
    vi.setSystemTime(1_700_000_002_001);
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

describe("reconnectProject", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("revalidates an existing project through PATCH without invoking creation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        project: {
          path: "/repo/existing",
          name: "existing",
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 2,
          available: true,
          workspaceAvailable: true,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconnectProject("/repo/existing")).resolves.toMatchObject({
      project: { path: "/repo/existing", workspaceAvailable: true },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects?path=%2Frepo%2Fexisting",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
        body: "{}",
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
    await deleteChat("chat-123", "/repo/project");

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
        body: JSON.stringify({
          projectPath: "/repo/project",
          confirmation: { chatId: "chat-123", irreversible: true },
        }),
      }),
    );
  });

  it("propagates fetch network errors for deleteProject and deleteChat", async () => {
    const networkError = new TypeError("fetch failed");
    const fetchMock = vi.fn().mockRejectedValue(networkError);
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteProject("/repo/project")).rejects.toBe(networkError);
    await expect(deleteChat("chat-123", "/repo/project")).rejects.toBe(networkError);

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

  it("rejects malformed contract-owned SSE payloads with a user-facing ApiError", async () => {
    const stream = makeSseStream([
      `event: done\ndata: ${JSON.stringify({ chat: { id: "c3" }, messages: "bad" })}\n\n`,
    ]);

    const handlers = makeStreamHandlers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSseResponse(stream)));

    await expect(
      sendDesktopChatStream(
        { chatId: "c3", projectPath: "/repo", content: "hello" },
        new AbortController().signal,
        handlers,
      ),
    ).rejects.toMatchObject({
      code: "MALFORMED_DESKTOP_CHAT_STREAM_EVENT",
      message: "The chat stream returned an invalid event. Retry the request.",
    });

    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onCancelled).not.toHaveBeenCalled();
  });

  it("rejects malformed SSE JSON with a user-facing ApiError", async () => {
    const stream = makeSseStream(["event: token\ndata: {not-json}\n\n"]);

    const handlers = makeStreamHandlers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSseResponse(stream)));

    await expect(
      sendDesktopChatStream(
        { chatId: "c4", projectPath: "/repo", content: "hello" },
        new AbortController().signal,
        handlers,
      ),
    ).rejects.toMatchObject({
      code: "MALFORMED_DESKTOP_CHAT_STREAM_EVENT",
    });

    expect(handlers.onToken).not.toHaveBeenCalled();
  });
});

// RB-6 / ADR-0173 D5 — sendDesktopChatStream is rebuilt on the same buildBffHeaders /
// newClientCorrelationId path bffFetchJson (./http) already uses, instead of a hand-built header
// object with no correlation id at all.
describe("sendDesktopChatStream — correlation id threading", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a well-formed X-Keiko-Correlation-Id header on the stream request", async () => {
    const stream = makeSseStream([
      `event: done\ndata: ${JSON.stringify({ chat: {}, messages: [] })}\n\n`,
    ]);
    const fetchMock = vi.fn().mockResolvedValue(makeSseResponse(stream));
    vi.stubGlobal("fetch", fetchMock);

    await sendDesktopChatStream(
      { chatId: "c5", projectPath: "/repo", content: "hello" },
      new AbortController().signal,
      makeStreamHandlers(),
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    // buildBffHeaders returns a plain record (#3241 review: it merges every HeadersInit shape into
    // it); normalize through the Headers API so the assertion stays case-insensitive.
    const headers = new Headers(init.headers);
    expect(headers.get(CORRELATION_HEADER)).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Keiko-CSRF")).toBe("1");
  });

  it("attaches the server-echoed correlation id to a pre-stream StreamingUnavailableError", async () => {
    const response = new Response(
      JSON.stringify({ error: { code: "STREAMING_UNSUPPORTED", message: "no stream" } }),
      {
        status: 409,
        headers: {
          "Content-Type": "application/json",
          [CORRELATION_HEADER]: "server-echoed-stream-000123",
        },
      },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    try {
      await sendDesktopChatStream(
        { chatId: "c6", projectPath: "/repo", content: "hello" },
        new AbortController().signal,
        makeStreamHandlers(),
      );
      expect.unreachable("expected sendDesktopChatStream to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StreamingUnavailableError);
      expect((error as StreamingUnavailableError).correlationId).toBe(
        "server-echoed-stream-000123",
      );
    }
  });

  it("falls back to the client-generated correlation id when the pre-stream response carries none", async () => {
    // #3241 review — a well-formed-ID match also passes if the thrown error carries a SECOND,
    // unrelated generated id instead of the id the request actually sent. Read the id off the
    // mocked fetch call and assert the thrown error's id is exactly that one.
    const fetchMock = vi.fn().mockResolvedValue(new Response("stack", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await sendDesktopChatStream(
        { chatId: "c7", projectPath: "/repo", content: "hello" },
        new AbortController().signal,
        makeStreamHandlers(),
      );
      expect.unreachable("expected sendDesktopChatStream to throw");
    } catch (error) {
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const sentCorrelationId = new Headers(init.headers).get(CORRELATION_HEADER);
      expect(sentCorrelationId).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
      expect(error).toBeInstanceOf(StreamingUnavailableError);
      expect((error as StreamingUnavailableError).correlationId).toBe(sentCorrelationId);
    }
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
        headers: expect.objectContaining({
          Accept: "application/pdf",
        }),
      }),
    );
    // GEN-RES-FETCH-001 — the caller signal is COMBINED with the default read deadline
    // (AbortSignal.any), so the forwarded signal is a derived one that still follows
    // the caller's abort.
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it("builds an encoded preview PDF document URL for PDF.js range loading", () => {
    expect(pdfCitationPreviewDocumentUrl("preview/session#1")).toBe(
      "/api/local-knowledge/citation-preview/sessions/preview%2Fsession%231/document",
    );
  });
});

// GEN-RES-FETCH-001 — BFF reads carry a default abort deadline so a stalled BFF cannot
// hang the UI behind the browser's minutes-long network timeout; mutations keep no
// default deadline (long-running git/index operations are legitimate), and a caller
// signal is combined with the deadline rather than replaced by it.
describe("GEN-RES-FETCH-001 — default read deadline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearProjectRequestForTests();
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("attaches a deadline signal to plain GET reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ projects: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchProjects();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("leaves state-changing requests without a default deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await deleteProject("/repo");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeNull();
  });

  it("combines a caller signal with the deadline instead of replacing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();
    await fetchPdfCitationPreviewDocument("session-1", caller.signal);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    // The combined signal must follow the CALLER abort (deadline alone is not enough).
    caller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  // The fallback path, which no test environment reaches on its own: Node and every modern browser
  // expose `AbortSignal.any`, so the manual combinator only ever runs on the OLDER browsers Keiko
  // declares support for (Chrome 111-115, Firefox 111-123, Safari 16.4-17.3). That is precisely the
  // code most likely to be wrong and least likely to be exercised, so these tests remove
  // `AbortSignal.any` to force it.
  describe("without AbortSignal.any (Chrome 111-115 / Firefox 111-123 / Safari 16.4-17.3)", () => {
    let nativeAny: typeof AbortSignal.any | undefined;

    beforeEach(() => {
      nativeAny = AbortSignal.any;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- simulating an older engine
      delete (AbortSignal as { any?: unknown }).any;
    });

    afterEach(() => {
      if (nativeAny !== undefined) (AbortSignal as { any?: unknown }).any = nativeAny;
    });

    async function forwardedSignal(caller: AbortSignal): Promise<AbortSignal> {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await fetchPdfCitationPreviewDocument("session-1", caller);
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const signal = init.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      return signal as AbortSignal;
    }

    it("still follows a caller abort that arrives after the request", async () => {
      const caller = new AbortController();
      const signal = await forwardedSignal(caller.signal);
      expect(signal.aborted).toBe(false);
      caller.abort();
      expect(signal.aborted).toBe(true);
    });

    it("propagates the caller's abort reason rather than a generic one", async () => {
      const caller = new AbortController();
      const signal = await forwardedSignal(caller.signal);
      const reason = new Error("caller went away");
      caller.abort(reason);
      expect(signal.reason).toBe(reason);
    });

    // The early-exit branch: a signal that is ALREADY aborted when the request is made never fires
    // an "abort" event, so a listener-only combinator would hand fetch a live signal and the request
    // would proceed — the caller's cancellation silently lost.
    it("starts aborted when the caller signal was already aborted", async () => {
      const caller = new AbortController();
      caller.abort();
      const signal = await forwardedSignal(caller.signal);
      expect(signal.aborted).toBe(true);
    });

    // The gap the three cases above leave open: they only ever abort the CALLER. A combinator that
    // returned the caller's signal verbatim — ignoring the deadline entirely — would satisfy all of
    // them, while silently removing the 15s read deadline for exactly the older browsers this
    // fallback exists to serve. A stalled BFF would then hang the UI behind the browser's own
    // minutes-long network timeout, the defect GEN-RES-FETCH-001 was written to prevent.
    //
    // Driven by STUBBING `AbortSignal.timeout` rather than by advancing timers: measured in this
    // jsdom lane, `AbortSignal.timeout` does NOT observe vitest's fake clock (a 100ms signal is
    // still unaborted after 200ms of fake time), so a timer-based version of this test would pass
    // for the wrong reason. Handing back a controller we own makes the deadline leg deterministic.
    it("aborts on the DEADLINE leg even when the caller never cancels", async () => {
      const deadline = new AbortController();
      const nativeTimeout = AbortSignal.timeout;
      AbortSignal.timeout = (): AbortSignal => deadline.signal;
      try {
        const caller = new AbortController();
        const signal = await forwardedSignal(caller.signal);
        expect(signal.aborted).toBe(false);
        const reason = new Error("read deadline elapsed");
        deadline.abort(reason);
        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBe(reason);
      } finally {
        AbortSignal.timeout = nativeTimeout;
      }
    });
  });
});

describe("M11 local-history and profile API wrappers", () => {
  function jsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("addresses every local-history endpoint with an encoded ref and root query", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonOk({ session: "active", entries: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await fetchEditorLocalHistory("/repo a", "src/app.ts");
    await fetchEditorLocalHistoryEntry("/repo a", "hist/one");
    await setEditorLocalHistoryPinned("/repo a", "hist/one", true);
    await deleteEditorLocalHistory("/repo a", "hist/one");

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toBe("/api/editor/local-history?root=%2Frepo+a&path=src%2Fapp.ts");
    expect(urls[1]).toBe("/api/editor/local-history/hist%2Fone?root=%2Frepo+a");
    expect(urls[2]).toBe(urls[1]);
    expect(urls[3]).toBe(urls[1]);
    const methods = fetchMock.mock.calls.map(
      (call) => (call[1] as RequestInit | undefined)?.method,
    );
    expect(methods).toEqual([undefined, undefined, "PATCH", "DELETE"]);
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      pinned: true,
    });
  });

  it("carries If-Match and Idempotency-Key on every profile mutation surface", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonOk({ kind: "ok" })));
    vi.stubGlobal("fetch", fetchMock);

    await mutateEditorProfile(
      { schemaVersion: "1", action: "switch", expectedRevision: 1 } as never,
      '"edp-1"',
      "switch-key",
    );
    await exportEditorProfile("profile-focus");
    await previewEditorProfileImport("{}", '"edp-1"');
    await applyEditorProfileImport({} as never, '"edp-1"', "apply-key");

    const headerSets = fetchMock.mock.calls.map(
      (call) => ((call[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>,
    );
    expect(headerSets[0]).toMatchObject({ "If-Match": '"edp-1"', "Idempotency-Key": "switch-key" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "/api/editor/settings/profiles/export?profileRef=profile-focus",
    );
    expect(headerSets[2]).toMatchObject({ "If-Match": '"edp-1"' });
    expect(headerSets[3]).toMatchObject({ "If-Match": '"edp-1"', "Idempotency-Key": "apply-key" });
  });

  it("propagates caller signals through the local-history readers", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonOk({ session: "active", entries: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await fetchEditorLocalHistory("/repo", "src/app.ts", controller.signal);
    await fetchEditorLocalHistoryEntry("/repo", "hist_1", controller.signal);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});

// #3385 — the Coding Workbench issue intake and the per-checkout GitHub issue reader grant. The
// preview response is server-resolved and content-bounded; the client re-validates its shape so a
// malformed or oversized body fails closed instead of reaching the untrusted-content renderer.
describe("Coding Workbench issue intake API (#3385)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonOk(body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  function previewResponse(
    overrides: Partial<GitHubIssuePreviewResponseWire["preview"]> = {},
    bindingOverrides: Partial<GitHubIssuePreviewResponseWire["binding"]> = {},
  ): GitHubIssuePreviewResponseWire {
    return {
      preview: {
        untrusted: true,
        bodyExcerptTruncated: false,
        title: "Start a Code task from a GitHub issue",
        bodyExcerpt: "From the existing Coding Workbench, resolve a GitHub issue URL…",
        commentCount: 3,
        state: "open",
        provenance: {
          ownerAndRepo: "oscharko-dev/Keiko",
          issueNumber: 3385,
          url: "https://github.com/oscharko-dev/Keiko/issues/3385",
        },
        ...overrides,
      },
      binding: {
        repositoryId: "a".repeat(64),
        remoteDigest: "b".repeat(64),
        issueNumber: 3385,
        issueIdDigest: "c".repeat(64),
        defaultBaseRef: "dev",
        bindingDigest: "e".repeat(64),
        ...bindingOverrides,
      },
    };
  }

  it("posts the repository path and issue reference as exact keys and returns the validated preview", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(previewResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const result = await previewCodingWorkbenchIssue(
      { repositoryPath: "/repos/keiko", issueRef: "#3385" },
      controller.signal,
    );

    expect(result).toEqual(previewResponse());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/coding-workbench/issue/preview");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      repositoryPath: "/repos/keiko",
      issueRef: "#3385",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)["X-Keiko-CSRF"]).toBe("1");
  });

  it.each([
    ["a missing preview", { preview: undefined }],
    [
      "a preview without an untrusted marker",
      { preview: { ...previewResponse().preview, untrusted: undefined } },
    ],
    [
      "a preview without its truncation marker",
      { preview: { ...previewResponse().preview, bodyExcerptTruncated: undefined } },
    ],
    ["an unknown issue state", { preview: { ...previewResponse().preview, state: "unknown" } }],
    [
      "server-only binding schema",
      { binding: { ...previewResponse().binding, schemaVersion: "1" } },
    ],
    [
      "server-only content revision",
      { binding: { ...previewResponse().binding, contentRevisionDigest: "d".repeat(64) } },
    ],
    ["an oversized title", { preview: { ...previewResponse().preview, title: "x".repeat(513) } }],
    [
      "an oversized excerpt",
      { preview: { ...previewResponse().preview, bodyExcerpt: "x".repeat(8193) } },
    ],
    ["a negative comment count", { preview: { ...previewResponse().preview, commentCount: -1 } }],
    [
      "too many comment excerpts",
      {
        preview: {
          ...previewResponse().preview,
          comments: Array.from({ length: 9 }, () => "comment"),
        },
      },
    ],
    [
      "an oversized comment excerpt",
      { preview: { ...previewResponse().preview, comments: ["x".repeat(1025)] } },
    ],
    [
      "a control character in a comment",
      { preview: { ...previewResponse().preview, comments: ["bad\u0007comment"] } },
    ],
    [
      "a nonboolean truncation marker",
      { preview: { ...previewResponse().preview, commentsTruncated: "false" } },
    ],
    [
      "a control character in the title",
      { preview: { ...previewResponse().preview, title: "bad\u0007title" } },
    ],
    [
      "a provenance without owner/repo shape",
      {
        preview: {
          ...previewResponse().preview,
          provenance: { ...previewResponse().preview.provenance, ownerAndRepo: "not a repo" },
        },
      },
    ],
    [
      "a provenance url that is not https",
      {
        preview: {
          ...previewResponse().preview,
          provenance: {
            ...previewResponse().preview.provenance,
            url: "javascript:alert(1)",
          },
        },
      },
    ],
    [
      "a binding with an unsafe base ref",
      { binding: { ...previewResponse().binding, defaultBaseRef: "../x" } },
    ],
    [
      "a binding with a non-digest field",
      { binding: { ...previewResponse().binding, bindingDigest: "nope" } },
    ],
    ["a binding with an extra key", { binding: { ...previewResponse().binding, title: "leak" } }],
    [
      "a binding whose issue number disagrees with the provenance",
      { binding: { ...previewResponse().binding, issueNumber: 12 } },
    ],
    // Cursor review threads PRRT_kwDOSqilAM6fbGbS / PRRT_kwDOSqilAM6ff6k0: the client used to
    // restate its own, wider bounds (issue number up to 2_147_483_647, title up to 512 chars)
    // instead of importing the contract's CODING_WORKBENCH_ISSUE_NUMBER_MAX (1_000_000_000) and
    // CODING_WORKBENCH_ISSUE_PREVIEW_TITLE_MAX_CHARS (256) — an input the server always rejects
    // used to pass client-side validation. Both binding and provenance carry the same number so
    // the failure below is the bound, not the preview/binding coherence check.
    [
      "an issue number beyond the contract's bound",
      {
        preview: {
          ...previewResponse().preview,
          provenance: { ...previewResponse().preview.provenance, issueNumber: 1_000_000_001 },
        },
        binding: { ...previewResponse().binding, issueNumber: 1_000_000_001 },
      },
    ],
    [
      "a title beyond the contract's bound",
      { preview: { ...previewResponse().preview, title: "x".repeat(300) } },
    ],
  ] as const)("fails closed on %s", async (_label, patch) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({ ...previewResponse(), ...patch })));

    await expect(
      previewCodingWorkbenchIssue({ repositoryPath: "/repos/keiko", issueRef: "#3385" }),
    ).rejects.toMatchObject({ code: "CONTRACT_VALIDATION_FAILED", status: 502 });
  });

  it("retains the originating correlation id when a successful response fails validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonOk(
          { preview: {} },
          {
            [CORRELATION_HEADER]: "corr-invalid-preview-3385",
          },
        ),
      ),
    );
    await expect(
      previewCodingWorkbenchIssue({ repositoryPath: "/repos/keiko", issueRef: "#3385" }),
    ).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      correlationId: "corr-invalid-preview-3385",
    });
  });

  it("surfaces the server's closed failure code and correlation id on a refused preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "auth-required",
              message: "GitHub issue access is not enabled.",
              correlationId: "corr-3385",
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      previewCodingWorkbenchIssue({ repositoryPath: "/repos/keiko", issueRef: "#3385" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "auth-required",
      status: 403,
      correlationId: "corr-3385",
    });
  });

  it("prefers the response correlation header over the envelope id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "issue-unavailable", message: "x" } }), {
          status: 404,
          headers: { "Content-Type": "application/json", [CORRELATION_HEADER]: "hdr-1" },
        }),
      ),
    );

    await expect(
      previewCodingWorkbenchIssue({ repositoryPath: "/repos/keiko", issueRef: "#1" }),
    ).rejects.toMatchObject({ code: "issue-unavailable", correlationId: "hdr-1" });
  });

  it("reads the grant for the named repository through the query string and validates the projection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonOk({ repositoryId: "f".repeat(64), authorized: true, revision: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    const grant = await fetchGitHubIssueReaderAuthorization("/repos/keiko a");

    expect(grant).toEqual({ repositoryId: "f".repeat(64), authorized: true, revision: 2 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/coding-workbench/github-authorization?repositoryPath=%2Frepos%2Fkeiko+a",
    );
  });

  it("rejects a grant projection whose fields are malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonOk({ repositoryId: "", authorized: "yes", revision: -1 })),
    );

    await expect(fetchGitHubIssueReaderAuthorization("/repos/keiko")).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
    });
  });

  it("puts the exact-key grant update with the echoed revision", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonOk({ repositoryId: "f".repeat(64), authorized: false, revision: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const grant = await updateGitHubIssueReaderAuthorization(
      { repositoryPath: "/repos/keiko", authorized: false, expectedRevision: 2 },
      controller.signal,
    );

    expect(grant.revision).toBe(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/coding-workbench/github-authorization");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      repositoryPath: "/repos/keiko",
      authorized: false,
      expectedRevision: 2,
    });
    expect(init.signal).toBe(controller.signal);
  });

  it("surfaces the 409 revision conflict with its code so the caller can re-read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "CONFLICT",
              message: "GitHub issue access changed. Reload and retry.",
              correlationId: "corr-409",
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      updateGitHubIssueReaderAuthorization({
        repositoryPath: "/repos/keiko",
        authorized: true,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409, correlationId: "corr-409" });
  });
});

// #3389 — the read-only journey observation/refresh client, admitted by the per-checkout
// GitHub-reader grant rather than a run-bound mutation gate. The client validates the observed
// outcome through the shared contract guard and never restates its vocabulary.
describe("Coding Workbench journey observation API (#3389)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("posts the exact-key refresh request and returns the validated observed outcome", async () => {
    const { outcome } = journeyFixture();
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ status: "observed", outcome }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const result = await fetchCodingWorkbenchJourneyRefresh(
      { runId: outcome.binding.runId },
      controller.signal,
    );

    expect(result).toEqual({ status: "observed", outcome });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/git-delivery/journey/refresh");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      schemaVersion: "1",
      runId: outcome.binding.runId,
    });
    expect(init.signal).toBe(controller.signal);
  });

  it("returns the closed unavailable reason without treating it as an observed outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonOk({ status: "unavailable", reason: "draft-unavailable" })),
    );

    const result = await fetchCodingWorkbenchJourneyRefresh({ runId: "run-1" });

    expect(result).toEqual({ status: "unavailable", reason: "draft-unavailable" });
  });

  it("rejects a response claiming an invalid JourneyOutcome rather than rendering it", async () => {
    const { outcome } = journeyFixture();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonOk({ status: "observed", outcome: { ...outcome, state: "fabricated-current" } }),
        ),
    );

    await expect(fetchCodingWorkbenchJourneyRefresh({ runId: "run-1" })).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
    });
  });

  it("rejects a runId that is not a bounded, non-empty string before any request is sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchJourneyRefresh({ runId: "" })).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Issue #3400 (epic #3384) — connect/refresh clients. The browser sends only a chat id and a
// ref/mode selection; the server resolves the trusted repository and returns only server-issued
// facts. These tests pin the request shape and the response-validation fail-closed behavior.
describe("Git-to-Chat connect/refresh API (#3400)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function gitChangeScopeFixture(): Record<string, unknown> {
    return {
      kind: "git-change",
      relationshipId: "rel-1",
      remoteDigest: "d".repeat(64),
      comparisonLabel: "main...feature/x",
      baseRef: "main",
      headRef: "feature/x",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      mergeBaseSha: "c".repeat(40),
      snapshotDigest: "e".repeat(64),
      fileCount: 1,
      totalFiles: 1,
      omittedFiles: 0,
      truncatedFiles: 0,
      descriptionStatus: "current",
      connectedAtMs: 10,
    };
  }

  it("posts the exact comparison request and returns the validated connected scope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonOk({ status: "connected", scope: gitChangeScopeFixture() }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await connectGitChangeToChat({
      chatId: "chat-1",
      mode: "comparison",
      headRef: "feature/x",
      baseRef: "main",
    });

    expect(result).toEqual({ status: "connected", scope: gitChangeScopeFixture() });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/git-change/connect");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: "1",
      chatId: "chat-1",
      mode: "comparison",
      headRef: "feature/x",
      baseRef: "main",
    });
  });

  it("returns a blocked result for a known closed reason without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonOk({ status: "blocked", reason: "detached-head" })),
    );

    const result = await connectGitChangeToChat({
      chatId: "chat-1",
      mode: "comparison",
      headRef: "feature/x",
      baseRef: "main",
    });

    expect(result).toEqual({ status: "blocked", reason: "detached-head" });
  });

  it("rejects a response claiming an unknown blocked reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonOk({ status: "blocked", reason: "not-a-real-reason" })),
    );

    await expect(
      connectGitChangeToChat({
        chatId: "chat-1",
        mode: "pull-request",
        headRef: "feature/x",
      }),
    ).rejects.toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });
  });

  it("rejects a connected response whose scope is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonOk({
          status: "connected",
          scope: { ...gitChangeScopeFixture(), remoteDigest: "not-a-digest" },
        }),
      ),
    );

    await expect(
      connectGitChangeToChat({ chatId: "chat-1", mode: "pull-request", headRef: "feature/x" }),
    ).rejects.toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });
  });

  // Owner audit b1-12 — descriptionStatus was only bounded-text checked (<=16 chars), so any
  // short string the server (or an intermediary) claimed for that field passed validation and
  // would have reached the pill's closed STATUS_BADGE_CLASS/STATUS_LABEL_KEY lookups, which throw
  // on an unmapped key. Failing-before: this rejected with `CONTRACT_VALIDATION_FAILED` only after
  // the fix; before it, "not-a-real-status" (13 chars) passed bounded-text and the promise
  // resolved instead of rejecting.
  it("rejects a connected response whose scope has an unrecognised descriptionStatus", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonOk({
          status: "connected",
          scope: { ...gitChangeScopeFixture(), descriptionStatus: "unknown" },
        }),
      ),
    );

    await expect(
      connectGitChangeToChat({ chatId: "chat-1", mode: "pull-request", headRef: "feature/x" }),
    ).rejects.toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });
  });

  it("posts the refresh request with only chatId and relationshipId", async () => {
    const staleScope = { ...gitChangeScopeFixture(), descriptionStatus: "stale" };
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ status: "stale", scope: staleScope }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshGitChangeScope("chat-1", "rel-1");

    expect(result).toEqual({ status: "stale", scope: staleScope });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/git-change/refresh");
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: "1",
      chatId: "chat-1",
      relationshipId: "rel-1",
    });
  });
});

// Failing-before: before this client existed, a card wanting to mint the approval
// commit/push/pr-create/pr-update now require unconditionally (#3386 commit, #3387 push and pull
// request; epic #3384 correction 5) had no BFF client to call, so `fetchGitDeliveryCommitApprove`
// (and its push/pr siblings below) were undefined and every test in this block failed with
// "fetchGitDeliveryCommitApprove is not a function" before the corresponding export was added.
describe("Governed commit/push/pull-request approval mint (#3386/#3387)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function approvalFixture(): Record<string, unknown> {
    return {
      schemaVersion: "1",
      approval: { schemaVersion: "1", approvalId: "gda_1", approvalToken: "t".repeat(64) },
      expiresAt: "2026-01-01T00:00:30.000Z",
    };
  }

  it("mints a commit approval from only message/allowEmpty, never attaching an approval field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(approvalFixture()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGitDeliveryCommitApprove({
      projectId: "/repo",
      message: "feat: x",
      allowEmpty: true,
    });

    expect(result.approval.approvalId).toBe("gda_1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/git-delivery/commit/approve");
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: "1",
      projectId: "/repo",
      message: "feat: x",
      allowEmpty: true,
    });
  });

  it("mints a push approval bound to the exact publish target", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(approvalFixture()));
    vi.stubGlobal("fetch", fetchMock);

    await fetchGitDeliveryPushApprove({
      projectId: "/repo",
      remoteAlias: "origin",
      remoteBranchName: "feature/x",
      sourceBranchName: "feature/x",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/git-delivery/push/approve");
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: "1",
      projectId: "/repo",
      remoteAlias: "origin",
      remoteBranchName: "feature/x",
      sourceBranchName: "feature/x",
    });
  });

  it("mints a pull-request approval bound to the exact create/update command", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(approvalFixture()));
    vi.stubGlobal("fetch", fetchMock);

    await fetchGitDeliveryPrApprove({
      projectId: "/repo",
      kind: "pr-create",
      ownerAndRepo: "oscharko-dev/Keiko",
      headBranchName: "feature/x",
      baseBranchName: "dev",
      title: "feat: x",
      body: "body",
      isDraft: false,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/git-delivery/pr/approve");
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: "1",
      projectId: "/repo",
      kind: "pr-create",
      ownerAndRepo: "oscharko-dev/Keiko",
      headBranchName: "feature/x",
      baseBranchName: "dev",
      title: "feat: x",
      body: "body",
      isDraft: false,
    });
  });
});

// F3 (epic #3384 final audit): commit/push through the standalone Git Client Window could never
// satisfy the epic's own unconditional approval requirement (correction 5) — `commitChanges`/
// `runPushSync` (GitClientWindow.tsx) called `commitExecute`/`pushExecute` directly, with no mint
// step at all, so an accepted run's commit/push silently dead-ended every time. Failing-before:
// before `proposeCommit`/`proposePush` existed, this whole block failed with
// "proposeCommit is not a function" / "proposePush is not a function".
describe("Governed commit/push mint-then-execute (#3386/#3387, F3 epic #3384 final audit)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // The EXACT shape `deniedAuthorityGate` (requestPreparation.ts) issues for every admission-layer
  // refusal — the only mint failure `proposeCommit`/`proposePush` may fall back on.
  function jsonDenied(): Response {
    return new Response(
      JSON.stringify({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED", message: "denied" } }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // A genuine mint failure that is NOT a policy denial — a server error, a malformed request, or a
  // transport failure. Review finding (F3 major, epic #3384 final audit): a blanket `catch {}`
  // relabelled this as the same static "approval-required" outcome as a real denial, discarding the
  // actual error and its diagnostic value (AGENTS.md §7 no-silent-failures).
  function jsonServerError(): Response {
    return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  function approvalFixture(id: string): Record<string, unknown> {
    return {
      schemaVersion: "1",
      approval: { schemaVersion: "1", approvalId: id, approvalToken: "t".repeat(64) },
      expiresAt: "2026-01-01T00:00:30.000Z",
    };
  }

  it("proposeCommit mints then redeems, in order, before reporting success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(approvalFixture("gda_commit_1")))
      .mockResolvedValueOnce(
        jsonOk({ schemaVersion: "1", status: "succeeded", actionKind: "commit" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await proposeCommit({ projectId: "/repo", message: "feat: x" });

    expect(result.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [approveUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [executeUrl, executeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(approveUrl).toBe("/api/git-delivery/commit/approve");
    expect(executeUrl).toBe("/api/git-delivery/commit/execute");
    const executeBody = JSON.parse(executeInit.body as string) as Record<string, unknown>;
    expect(executeBody.approval).toEqual(approvalFixture("gda_commit_1").approval);
  });

  it("proposeCommit resolves to the static approval-required outcome when the mint itself is denied", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonDenied());
    vi.stubGlobal("fetch", fetchMock);

    const result = await proposeCommit({ projectId: "/repo", message: "feat: x" });

    expect(result).toEqual({
      schemaVersion: "1",
      status: "approval-required",
      actionKind: "commit",
    });
    // The denied mint never reaches execute — only the approve endpoint was called.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [approveUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(approveUrl).toBe("/api/git-delivery/commit/approve");
  });

  it("proposePush mints then redeems, in order, before reporting success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(approvalFixture("gda_push_1")))
      .mockResolvedValueOnce(
        jsonOk({ schemaVersion: "1", status: "succeeded", actionKind: "push" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await proposePush({
      projectId: "/repo",
      remoteAlias: "origin",
      remoteBranchName: "feature/x",
      sourceBranchName: "feature/x",
    });

    expect(result.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [approveUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [executeUrl, executeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(approveUrl).toBe("/api/git-delivery/push/approve");
    expect(executeUrl).toBe("/api/git-delivery/push/execute");
    const executeBody = JSON.parse(executeInit.body as string) as Record<string, unknown>;
    expect(executeBody.approval).toEqual(approvalFixture("gda_push_1").approval);
  });

  it("proposePush resolves to the static approval-required outcome when the mint itself is denied", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonDenied());
    vi.stubGlobal("fetch", fetchMock);

    const result = await proposePush({
      projectId: "/repo",
      remoteAlias: "origin",
      remoteBranchName: "feature/x",
      sourceBranchName: "feature/x",
    });

    expect(result).toEqual({ schemaVersion: "1", status: "approval-required", actionKind: "push" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [approveUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(approveUrl).toBe("/api/git-delivery/push/approve");
  });

  it("proposeCommit still rejects when execute itself fails after a successful mint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(approvalFixture("gda_commit_2")))
      .mockResolvedValueOnce(jsonDenied());
    vi.stubGlobal("fetch", fetchMock);

    await expect(proposeCommit({ projectId: "/repo", message: "feat: x" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("proposeCommit rethrows when the mint fails for a reason other than authority denial (F3 major repair)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonServerError());
    vi.stubGlobal("fetch", fetchMock);

    await expect(proposeCommit({ projectId: "/repo", message: "feat: x" })).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });
    // The genuine failure never reaches execute, and is never relabelled as approval-required.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("proposePush rethrows when the mint fails for a reason other than authority denial (F3 major repair)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonServerError());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      proposePush({
        projectId: "/repo",
        remoteAlias: "origin",
        remoteBranchName: "feature/x",
        sourceBranchName: "feature/x",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// #3389 repair: a BLOCKING review finding on the pr-mark-ready intent found that the production
// "Propose ready" UI action was broken end-to-end — `proposePrMarkReady` never sent the `baseRef`
// field the server's mint route (`buildMarkReadyCommand`, prMarkReadyExecution.ts) unconditionally
// requires via `isBaseBranchName`, so every real click would have failed with a clean 400. Nothing
// in the suite caught it because every other test mocked across this exact HTTP boundary. Failing-
// before: with the pre-repair `GitDeliveryPrMarkReadyInput` (no `baseRef` field) and
// `gitDeliveryPrMarkReadyBody` (which never serialized it), every `toEqual` assertion below that
// names `baseRef` failed — the posted body simply had no such key.
describe("Governed PR mark-ready intent client (#3389 repair)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function markReadyInput(): {
    projectId: string;
    ownerAndRepo: string;
    prExternalId: string;
    headSha: string;
    baseSha: string;
    baseRef: string;
    readinessDigest: string;
  } {
    return {
      projectId: "/repos/keiko-checkout",
      ownerAndRepo: "oscharko-dev/Keiko",
      prExternalId: "1499",
      headSha: "3".repeat(40),
      baseSha: "1".repeat(40),
      baseRef: "dev",
      readinessDigest: "c".repeat(64),
    };
  }

  it("mints a mark-ready approval carrying the exact base branch name the server requires", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        schemaVersion: "1",
        approval: { schemaVersion: "1", approvalId: "gda_mr1", approvalToken: "t".repeat(64) },
        expiresAt: "2026-09-05T00:05:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchGitDeliveryPrMarkReadyApprove(markReadyInput());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/git-delivery/pr/mark-ready/approve");
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: "1",
      ...markReadyInput(),
    });
  });

  it("redeems a mark-ready execute carrying the exact base branch name the server requires", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonOk({ schemaVersion: "1", actionKind: "pr-mark-ready", status: "succeeded" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const approval = {
      schemaVersion: "1" as const,
      approvalId: "gda_mr1",
      approvalToken: "t".repeat(64),
    };

    await fetchGitDeliveryPrMarkReadyExecute({ ...markReadyInput(), approval });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/git-delivery/pr/mark-ready/execute");
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: "1",
      ...markReadyInput(),
      approval,
    });
  });

  it("proposePrMarkReady sends baseRef on both the mint and the execute call, unchanged", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonOk({
          schemaVersion: "1",
          approval: { schemaVersion: "1", approvalId: "gda_mr2", approvalToken: "u".repeat(64) },
          expiresAt: "2026-09-05T00:05:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonOk({ schemaVersion: "1", actionKind: "pr-mark-ready", status: "succeeded" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await proposePrMarkReady(markReadyInput());

    expect(result.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [approveUrl, approveInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [executeUrl, executeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(approveUrl).toBe("/api/git-delivery/pr/mark-ready/approve");
    expect(executeUrl).toBe("/api/git-delivery/pr/mark-ready/execute");
    const approveBody = JSON.parse(approveInit.body as string) as Record<string, unknown>;
    const executeBody = JSON.parse(executeInit.body as string) as Record<string, unknown>;
    expect(approveBody.baseRef).toBe("dev");
    expect(executeBody.baseRef).toBe("dev");
  });

  // Server-agnostic parity check (#3389 repair item 3): rather than trusting the fixture's own
  // literal values, prove the exact object the client posts would pass the same field-shape
  // predicates the server's mint route composes its validator from — `isGitObjectId` is the very
  // function `buildMarkReadyCommand` (prMarkReadyExecution.ts) imports from keiko-contracts for
  // `headSha`/`baseSha`, and `isSafeGitRefName` plus "not refs/-prefixed" is the exact composition
  // `isBaseBranchName` (server) and `GitPullRequestIdentity`'s own `baseRef` field (contracts'
  // `validBranch`, git-pull-request-identity.ts) both apply to a base branch name. A future drift —
  // either side starts sending/requiring a differently-shaped value — fails this assertion without
  // either package restating the other's parser.
  it("posts a body whose sha/ref fields satisfy the same shared keiko-contracts predicates the server's mint parser is built from", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        schemaVersion: "1",
        approval: { schemaVersion: "1", approvalId: "gda_mr3", approvalToken: "v".repeat(64) },
        expiresAt: "2026-09-05T00:05:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchGitDeliveryPrMarkReadyApprove(markReadyInput());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(isGitObjectId(body.headSha)).toBe(true);
    expect(isGitObjectId(body.baseSha)).toBe(true);
    expect(typeof body.baseRef).toBe("string");
    expect(isSafeGitRefName(body.baseRef as string)).toBe(true);
    expect((body.baseRef as string).startsWith("refs/")).toBe(false);
  });
});

// #3399: preview/approve/apply/status for the governed PR-description application. The
// preview/apply/status responses carry the real shared PrDescriptionApplicationStatus contract, so
// (unlike the thin approve wrappers above) these are validated client-side — a malformed body the
// server contract refuses must never reach a component. Failing-before: before
// `validatePrDescriptionApplicationResultWire` existed, ANY object shape (including one with an
// unknown "outcome" or a state/reason mismatch) would have resolved successfully.
describe("Governed PR-description application API (#3399)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function statusFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: "1",
      state: "current",
      reason: "applied",
      binding: {
        repositoryId: "repo-1",
        remoteDigest: "a".repeat(64),
        repository: "oscharko-dev/Keiko",
        prNumber: 1499,
        prExternalId: "1499",
        baseRef: "dev",
        baseSha: "b".repeat(40),
        headRepository: "oscharko-dev/Keiko",
        headRef: "feature/x",
        headSha: "c".repeat(40),
        isDraft: false,
        snapshotDigest: "d".repeat(64),
        draftDigest: "e".repeat(64),
        renderingVersion: "1",
        expectedBodyDigest: "f".repeat(64),
        outsideRegionDigest: "0".repeat(64),
        finalBodyDigest: "1".repeat(64),
        providerUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
      observedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:30.000Z",
      completeness: "complete",
      effect: "confirmed",
      concurrency: "read-check-write-verify",
      ...overrides,
    };
  }

  const TARGET = { projectId: "/repo", ownerAndRepo: "oscharko-dev/Keiko", prNumber: 1499 };

  it("posts the preview request with the target and language, omitting refinement when absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        outcome: "preview",
        preview: {
          proposalId: "prop-1",
          expiresAt: "2026-01-01T00:00:30.000Z",
          status: statusFixture(),
          finalBody: "<!-- keiko:managed:v1:start -->generated<!-- keiko:managed:v1:end -->",
          managedRegion: "generated",
          concurrencyLimitation: "GitHub cannot lock the PR body during this update.",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGitDeliveryPrDescriptionPreview({ ...TARGET, language: "en" });

    expect(result.outcome).toBe("preview");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/git-delivery/pr-description/preview");
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: "1",
      projectId: "/repo",
      ownerAndRepo: "oscharko-dev/Keiko",
      prNumber: 1499,
      language: "en",
    });
  });

  it("posts the approve request with only the target and proposalId — never a bearer claim", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonOk({ schemaVersion: "1", proposalId: "prop-1", expiresAt: "2026-01-01T00:00:30.000Z" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGitDeliveryPrDescriptionApprove({ ...TARGET, proposalId: "prop-1" });

    expect(result.proposalId).toBe("prop-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/git-delivery/pr-description/approve");
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: "1",
      projectId: "/repo",
      ownerAndRepo: "oscharko-dev/Keiko",
      prNumber: 1499,
      proposalId: "prop-1",
    });
  });

  it("returns the observed status on a successful apply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonOk({ outcome: "observed", status: statusFixture() })),
    );

    const result = await fetchGitDeliveryPrDescriptionApply({ ...TARGET, proposalId: "prop-1" });

    expect(result).toEqual({ outcome: "observed", status: statusFixture() });
  });

  it("returns a blocked outcome with a reason in the closed vocabulary on status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonOk({ outcome: "blocked", reason: "stale-pr" })),
    );

    const result = await fetchGitDeliveryPrDescriptionStatus(TARGET);

    expect(result).toEqual({ outcome: "blocked", reason: "stale-pr" });
  });

  it("rejects a blocked outcome whose reason is outside the closed vocabulary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonOk({ outcome: "blocked", reason: "not-a-real-reason" })),
    );

    await expect(fetchGitDeliveryPrDescriptionStatus(TARGET)).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  it("rejects a preview envelope missing the server-rendered final body", async () => {
    const preview: Record<string, unknown> = {
      proposalId: "prop-1",
      expiresAt: "2026-01-01T00:00:30.000Z",
      status: statusFixture(),
      managedRegion: "x",
      concurrencyLimitation: "x",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({ outcome: "preview", preview })));

    await expect(
      fetchGitDeliveryPrDescriptionPreview({ ...TARGET, language: "en" }),
    ).rejects.toMatchObject({ code: "CONTRACT_VALIDATION_FAILED", status: 502 });
  });

  it("rejects an observed status whose declared state disagrees with its reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonOk({ outcome: "observed", status: statusFixture({ state: "failed" }) }),
        ),
    );

    await expect(fetchGitDeliveryPrDescriptionStatus(TARGET)).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
    });
  });

  it("rejects an unknown outcome discriminant", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({ outcome: "unknown" })));

    await expect(fetchGitDeliveryPrDescriptionStatus(TARGET)).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
    });
  });
});

// #3400 final-audit F5: Chat's apply action for a connected git-change scope. Before the
// `/api/git-change/apply-description` route was mounted, `applyGitChangeChatDescription` was
// undefined and every test below failed with "applyGitChangeChatDescription is not a function".
// The request carries only chat/relationship/proposal ids -- never `ownerAndRepo` -- proving the
// browser never re-authors the repository identity the server already re-derived at connect time.
describe("Chat's git-change apply-description action (#3400 final-audit F5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function statusFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: "1",
      state: "current",
      reason: "applied",
      binding: {
        repositoryId: "repo-1",
        remoteDigest: "a".repeat(64),
        repository: "oscharko-dev/Keiko",
        prNumber: 1499,
        prExternalId: "1499",
        baseRef: "dev",
        baseSha: "b".repeat(40),
        headRepository: "oscharko-dev/Keiko",
        headRef: "feature/x",
        headSha: "c".repeat(40),
        isDraft: false,
        snapshotDigest: "d".repeat(64),
        draftDigest: "e".repeat(64),
        renderingVersion: "1",
        expectedBodyDigest: "f".repeat(64),
        outsideRegionDigest: "0".repeat(64),
        finalBodyDigest: "1".repeat(64),
        providerUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
      observedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:30.000Z",
      completeness: "complete",
      effect: "confirmed",
      concurrency: "read-check-write-verify",
      ...overrides,
    };
  }

  const INPUT = { chatId: "chat-1", relationshipId: "rel-1", proposalId: "prop-1" };

  it("posts exactly chatId, relationshipId and proposalId — never ownerAndRepo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonOk({ outcome: "observed", status: statusFixture() }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await applyGitChangeChatDescription(INPUT);

    expect(result).toEqual({ outcome: "observed", status: statusFixture() });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/git-change/apply-description");
    expect(JSON.parse(init.body as string)).toEqual({ schemaVersion: "1", ...INPUT });
  });

  it("returns a blocked outcome with a reason in the closed vocabulary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonOk({ outcome: "blocked", reason: "stale-pr" })),
    );

    const result = await applyGitChangeChatDescription(INPUT);

    expect(result).toEqual({ outcome: "blocked", reason: "stale-pr" });
  });

  it("rejects a blocked outcome whose reason is outside the closed vocabulary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonOk({ outcome: "blocked", reason: "not-a-real-reason" })),
    );

    await expect(applyGitChangeChatDescription(INPUT)).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  it("rejects an observed status whose declared state disagrees with its reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonOk({ outcome: "observed", status: statusFixture({ state: "failed" }) }),
        ),
    );

    await expect(applyGitChangeChatDescription(INPUT)).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
    });
  });

  // This action never produces a preview envelope (it only ever consumes an already-approved
  // proposal) -- a "preview" outcome from this specific route is itself a contract violation.
  it("rejects a preview outcome as invalid for this action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonOk({
          outcome: "preview",
          preview: {
            proposalId: "prop-1",
            expiresAt: "2026-01-01T00:00:30.000Z",
            status: statusFixture(),
            finalBody: "x",
            managedRegion: "x",
            concurrencyLimitation: "x",
          },
        }),
      ),
    );

    await expect(applyGitChangeChatDescription(INPUT)).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
    });
  });

  it("rejects an unknown outcome discriminant", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({ outcome: "unknown" })));

    await expect(applyGitChangeChatDescription(INPUT)).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
    });
  });
});
