// Behavioural unit tests for the GitClientWindow shell (Issue #1574, Epic #1571).
// Uses a makeClient(overrides) factory returning a GitClientSeam with vi.fn() stubs so
// no module-level vi.mock() is needed (the client prop is the DI seam).
//
// Coverage targets (EV2/EV4):
//   - Repository selector lists multiple repos; selecting calls updateCfg/onSelect
//   - Add-repository dialog: clone → cloneRepository; open-local → registerRepository
//   - Toolbar: Open in Editor / Open Files call callbacks with current root; Sync renders
//   - Changes/History tabs: role=tab, aria-selected toggles, keyboard Left/Right/Home/End
//   - Empty state (no repo), loading state, error state all render finished states
//   - Changed-files list renders from status with glyphs; selecting a change triggers diff
//   - Visible words: Git, Repository, Changes, History, Branch, Commit, Sync, Pull Request, Merge
//   - Absent words: Governance, Governed Git, Delivery path

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitChangedFile,
  GitHistoryEntry,
  GitHistoryResponse,
  GitRepositorySummary,
  GitSyncPreview,
  ProjectWithAvailability,
} from "@/lib/types";
import type {
  GitBranchListResponse,
  GitDeliveryMergePreviewResponse,
  GitDeliveryCommitPreviewResponse,
  GitDeliveryPrPreviewResponse,
  GitDeliveryPushPreviewResponse,
} from "@/lib/api";
import type { GitRepositoryStatusResponse } from "@/lib/types";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import type { GitClientSeam } from "./git-client-seam";
import { GitClientWindow } from "./GitClientWindow";
import { parseUnifiedDiff } from "../shared/diffParser";
import { notifyWorkspaceFileMutated } from "../workspace-file-events";

// Issue #3400 — the "Connect to Chat" dialog calls fetchChats/connectGitChangeToChat directly
// (it owns no GitClientSeam methods). Only these two are replaced; every other @/lib/api export
// stays real so the rest of this file's `client` seam-only tests are unaffected.
const gitChangeChatMocks = vi.hoisted(() => ({
  fetchChats: vi.fn(),
  connectGitChangeToChat: vi.fn(),
}));
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchChats: gitChangeChatMocks.fetchChats,
    connectGitChangeToChat: gitChangeChatMocks.connectGitChangeToChat,
  };
});

const nativeFileDialogMock = vi.hoisted(() => ({
  pickWithNativeDialog: vi.fn(),
}));

vi.mock("@/lib/native-file-dialog", () => nativeFileDialogMock);
vi.mock("../../../hooks/useNativeFileDialogCapability", () => ({
  useNativeFileDialogCapability: (): boolean => true,
}));

// ─── ResizeObserver stub (no global shim in vitest.setup.ts) ──────────────────

if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
}

// ─── Fixture helpers ───────────────────────────────────────────────────────────

function makeRepo(
  path: string,
  name: string,
  extra?: Partial<ProjectWithAvailability>,
): ProjectWithAvailability {
  return {
    path,
    name,
    favorite: false,
    createdAt: 0,
    lastOpenedAt: 0,
    available: true,
    workspaceAvailable: true,
    ...extra,
  };
}

const REPO_A = makeRepo("/repos/alpha", "alpha");
const REPO_B = makeRepo("/repos/beta", "beta");

function makeBranchList(overrides: Partial<GitBranchListResponse> = {}): GitBranchListResponse {
  return {
    schemaVersion: "1",
    root: "/repos/alpha",
    available: true,
    state: "available",
    branches: [
      { name: "main", headRefHash: "aaa", current: true },
      { name: "feat/x", headRefHash: "bbb", current: false },
    ],
    truncated: false,
    ...overrides,
  };
}

function makeStatus(
  overrides: Partial<GitRepositoryStatusResponse> = {},
): GitRepositoryStatusResponse {
  return {
    schemaVersion: "1",
    root: "/repos/alpha",
    state: "available",
    available: true,
    detached: false,
    clean: true,
    branch: "main",
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    changes: [],
    truncated: false,
    maxChanges: 50,
    ...overrides,
  };
}

function change(path: string, flags: Partial<GitChangedFile> = {}): GitChangedFile {
  return {
    path,
    indexStatus: " ",
    worktreeStatus: " ",
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
    ...flags,
  };
}

// A repository whose working tree exercises every changed-file state #1575 must represent.
function makeStatusRich(): GitRepositoryStatusResponse {
  return makeStatus({
    clean: false,
    stagedCount: 2,
    unstagedCount: 2,
    untrackedCount: 1,
    conflictedCount: 1,
    changes: [
      change("src/index.ts", { indexStatus: "M", staged: true }),
      change("README.md", { worktreeStatus: "M", unstaged: true }),
      change("notes.txt", { indexStatus: "?", worktreeStatus: "?", untracked: true }),
      change("merge.ts", { indexStatus: "U", worktreeStatus: "U", conflicted: true }),
      change("partial.ts", { indexStatus: "M", worktreeStatus: "M", staged: true, unstaged: true }),
    ],
  });
}

function makeStatusWithChanges(): GitRepositoryStatusResponse {
  return makeStatus({
    clean: false,
    stagedCount: 1,
    unstagedCount: 1,
    changes: [
      {
        path: "src/index.ts",
        indexStatus: "M",
        worktreeStatus: " ",
        staged: true,
        unstaged: false,
        untracked: false,
        conflicted: false,
      },
      {
        path: "README.md",
        indexStatus: " ",
        worktreeStatus: "M",
        staged: false,
        unstaged: true,
        untracked: false,
        conflicted: false,
      },
    ],
  });
}

function makeSummary(overrides: Partial<GitRepositorySummary> = {}): GitRepositorySummary {
  return {
    schemaVersion: "1",
    root: "/repos/alpha",
    state: "available",
    available: true,
    branch: "main",
    detached: false,
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    clean: true,
    remotes: [{ name: "origin" }],
    truncated: false,
    ...overrides,
  };
}

function makeHistory(overrides: Partial<GitHistoryResponse> = {}): GitHistoryResponse {
  return {
    schemaVersion: "1",
    root: "/repos/alpha",
    state: "available",
    available: true,
    entries: [
      {
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        shortSha: "aaaaaaa",
        subject: "feat: add history",
        author: "Ada",
        date: "2026-06-27T10:00:00Z",
        refs: ["HEAD -> main", "origin/main"],
        parentCount: 1,
        changedFileCount: 3,
      },
      {
        sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        shortSha: "bbbbbbb",
        subject: "fix: repair sync",
        author: "Grace",
        date: "2026-06-27T11:00:00Z",
        refs: [],
        parentCount: 2,
        changedFileCount: 1,
      },
    ],
    limit: 50,
    skip: 0,
    truncated: false,
    ...overrides,
  };
}

function makeHistoryEntry(index: number): GitHistoryEntry {
  const sha = index.toString(16).padStart(40, "0");
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: `commit ${index.toString()}`,
    author: "Ada",
    date: "2026-06-27T10:00:00Z",
    refs: [],
    parentCount: 1,
    changedFileCount: 1,
  };
}

function makeHistoryPage(
  start: number,
  count: number,
  overrides: Partial<GitHistoryResponse> = {},
): GitHistoryResponse {
  return makeHistory({
    entries: Array.from({ length: count }, (_entry, offset) => makeHistoryEntry(start + offset)),
    skip: start,
    truncated: true,
    ...overrides,
  });
}

function makeProjectResponse(repo: ProjectWithAvailability) {
  return { project: repo };
}

function makeDiffResponse(diff: string, overrides: { readonly truncated?: boolean } = {}) {
  return {
    schemaVersion: "1" as const,
    root: "/repos/alpha",
    state: "available" as const,
    available: true,
    scope: "all" as const,
    diff,
    truncated: overrides.truncated ?? false,
    maxBytes: 131072,
  };
}

function makeCommitPreview(
  overrides: Partial<GitDeliveryCommitPreviewResponse> = {},
): GitDeliveryCommitPreviewResponse {
  return {
    schemaVersion: "1",
    summary: { stagedFileCount: 1, areaCount: 1, areas: ["src"], touchesTests: false },
    intent: { warnings: [], mixedScope: false, isWip: false },
    messageValidation: { ok: true },
    preflightFindingCodes: [],
    signatureRequirement: "not-required",
    policyOutcome: "allowed",
    ...overrides,
  };
}

function makeSyncPreview(
  operation: "fetch" | "pull",
  overrides: Partial<GitSyncPreview> = {},
): GitSyncPreview {
  return {
    schemaVersion: "1",
    operation,
    available: true,
    state: "available",
    branch: "main",
    detached: false,
    upstream: { ref: "origin/main", remote: "origin", branch: "main" },
    remote: "origin",
    ahead: 0,
    behind: 0,
    hasRemote: true,
    hasUpstream: true,
    dirty: false,
    executable: true,
    ...overrides,
  };
}

function makePushPreview(
  overrides: Partial<GitDeliveryPushPreviewResponse> = {},
): GitDeliveryPushPreviewResponse {
  return {
    schemaVersion: "1",
    remoteAlias: "origin",
    remoteBranchName: "main",
    sourceBranchName: "main",
    riskClass: "normal",
    wouldCreateRemoteBranch: false,
    wouldTriggerChecks: true,
    forceBlocked: false,
    signatureRequirement: "not-required",
    preflightBlockingCodes: [],
    preflightAdvisoryCodes: [],
    policyOutcome: "allowed",
    ...overrides,
  };
}

function makePrPreview(
  overrides: Partial<GitDeliveryPrPreviewResponse> = {},
): GitDeliveryPrPreviewResponse {
  return {
    schemaVersion: "1",
    actionKind: "pr-create",
    headBranchName: "main",
    baseBranchName: "main",
    riskClass: "protected-or-merge",
    riskSeverity: 3,
    isDraft: false,
    policyOutcome: "allowed",
    composedTitle: "feat: test pull request",
    composedBody: "Updates the Git window.",
    riskNarrative: "Repository UI integration.",
    recommendation: "create-ready",
    readiness: { objectExists: false, reviewReady: true, blockerCodes: [] },
    suggestedLabels: [],
    suggestedIssueRefs: ["#1577"],
    titleByteLength: 23,
    bodyByteLength: 23,
    ...overrides,
  };
}

function makeMergePreview(
  overrides: Partial<GitDeliveryMergePreviewResponse> = {},
): GitDeliveryMergePreviewResponse {
  return {
    schemaVersion: "1",
    actionKind: "merge",
    baseBranchName: "main",
    headBranchName: "main",
    prExternalId: "1577",
    riskClass: "protected-or-merge",
    riskSeverity: 4,
    requestedStrategy: "squash",
    requestedStrategyEligible: true,
    eligibleStrategies: ["squash", "provider-default"],
    selectedDefaultStrategy: "squash",
    recommendation: "merge-ready",
    policyOutcome: "approval-gated",
    requiresApproval: true,
    readiness: { mergeable: true, blockers: [] },
    ...overrides,
  };
}

// ─── makeClient factory ────────────────────────────────────────────────────────

function makeClient(overrides: Partial<GitClientSeam> = {}): GitClientSeam {
  return {
    listRepositories: vi.fn(async () => ({ projects: [REPO_A, REPO_B] })),
    registerRepository: vi.fn(async ({ path }) =>
      makeProjectResponse(path === REPO_B.path ? REPO_B : REPO_A),
    ),
    reconnectRepository: vi.fn(async (path) =>
      makeProjectResponse(path === REPO_B.path ? REPO_B : REPO_A),
    ),
    cloneRepository: vi.fn(async () => makeProjectResponse(REPO_A)),
    listBranches: vi.fn(async () => makeBranchList()),
    getSummary: vi.fn(async () => makeSummary()),
    getHistory: vi.fn(async () => makeHistory({ entries: [] })),
    getRemotes: vi.fn(async () => ({
      schemaVersion: "1" as const,
      root: "/repos/alpha",
      state: "available" as const,
      available: true,
      remotes: [{ name: "origin" }],
      truncated: false,
    })),
    getStatus: vi.fn(async () => makeStatus()),
    getDiff: vi.fn(async () => makeDiffResponse("")),
    getStructuredDiff: vi.fn(async () => ({
      schemaVersion: "1" as const,
      scope: "unstaged" as const,
      files: [],
      truncated: false,
      totalFiles: 0,
      totalBytes: 0,
      maxBytes: 524288 as const,
      maxFiles: 400 as const,
    })),
    // Carry-forward mutation refs — not called by the shell; typed against the real seam
    // method signatures so the stubs satisfy TS without `any`.
    branchCreate: vi.fn<GitClientSeam["branchCreate"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "branch-create",
    })),
    branchSwitch: vi.fn<GitClientSeam["branchSwitch"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "branch-switch",
    })),
    stage: vi.fn<GitClientSeam["stage"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "stage",
    })),
    unstage: vi.fn<GitClientSeam["unstage"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "unstage",
    })),
    commitPreview: vi.fn<GitClientSeam["commitPreview"]>(async () => makeCommitPreview()),
    commitExecute: vi.fn<GitClientSeam["commitExecute"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "commit",
    })),
    commitPropose: vi.fn<GitClientSeam["commitPropose"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "commit",
    })),
    syncPreview: vi.fn<GitClientSeam["syncPreview"]>(async (input) =>
      makeSyncPreview(input.operation),
    ),
    syncExecute: vi.fn<GitClientSeam["syncExecute"]>(async (input) => ({
      schemaVersion: "1",
      operation: input.operation,
      status: "succeeded",
      available: true,
      branch: "main",
      upstream: { ref: "origin/main", remote: "origin", branch: "main" },
      remote: input.remote,
      ahead: 0,
      behind: 0,
      truncated: false,
    })),
    pushPreview: vi.fn<GitClientSeam["pushPreview"]>(async () => makePushPreview()),
    pushExecute: vi.fn<GitClientSeam["pushExecute"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "push",
    })),
    pushPropose: vi.fn<GitClientSeam["pushPropose"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "push",
    })),
    prPreview: vi.fn<GitClientSeam["prPreview"]>(async () => makePrPreview()),
    prApprove: vi.fn<GitClientSeam["prApprove"]>(async () => ({
      schemaVersion: "1",
      approval: { schemaVersion: "1", approvalId: "gda_gcw_pr", approvalToken: "token-gcw-pr" },
      expiresAt: "2026-01-01T00:00:00.000Z",
    })),
    prExecute: vi.fn<GitClientSeam["prExecute"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "pr-create",
      createdPrExternalId: "1577",
    })),
    prDescriptionPreview: vi.fn<GitClientSeam["prDescriptionPreview"]>(async () => ({
      outcome: "blocked",
      reason: "approval-required",
    })),
    prDescriptionApprove: vi.fn<GitClientSeam["prDescriptionApprove"]>(async () => ({
      schemaVersion: "1",
      proposalId: "prop-gcw",
      expiresAt: "2026-01-01T00:00:00.000Z",
    })),
    prDescriptionApply: vi.fn<GitClientSeam["prDescriptionApply"]>(async () => ({
      outcome: "blocked",
      reason: "approval-required",
    })),
    prDescriptionStatus: vi.fn<GitClientSeam["prDescriptionStatus"]>(async () => ({
      outcome: "blocked",
      reason: "approval-required",
    })),
    mergePreview: vi.fn<GitClientSeam["mergePreview"]>(async () => makeMergePreview()),
    mergeApprove: vi.fn<GitClientSeam["mergeApprove"]>(async () => ({
      schemaVersion: "1",
      approval: { schemaVersion: "1", approvalId: "gda_gcw", approvalToken: "token-gcw" },
      expiresAt: "2026-01-01T00:00:00.000Z",
    })),
    mergeExecute: vi.fn<GitClientSeam["mergeExecute"]>(async () => ({
      schemaVersion: "1",
      status: "succeeded",
      actionKind: "merge",
      merged: true,
    })),
    ...overrides,
  };
}

function makeStructuredDiffResponse(diff = "", scope: "staged" | "unstaged" = "unstaged") {
  const parsed = parseUnifiedDiff(diff);
  return {
    schemaVersion: "1" as const,
    scope,
    files: parsed.files.map((file) => ({
      ...file,
      layer: scope === "staged" ? ("staged" as const) : ("worktree" as const),
    })),
    truncated: parsed.truncated,
    totalFiles: parsed.files.length,
    totalBytes: parsed.totalBytes,
    maxBytes: 524288 as const,
    maxFiles: 400 as const,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  resetClientDiagnosticWriter();
  vi.clearAllMocks();
});

// Issue #3400 — a sane default so any toolbar action that happens to mount ConnectToChatDialog
// (even in a test that isn't exercising it) resolves instead of leaving an unhandled rejection.
beforeEach(() => {
  gitChangeChatMocks.fetchChats.mockResolvedValue({ chats: [] });
});

describe("GitClientWindow — repository list", () => {
  it("lists multiple repos in the connect panel after load", async () => {
    render(<GitClientWindow client={makeClient()} />);
    expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /beta/ })).toBeInTheDocument();
  });

  it("revalidates a repo without registering it again before persisting the path", async () => {
    const updateCfg = vi.fn();
    const client = makeClient();
    render(<GitClientWindow client={client} updateCfg={updateCfg} />);
    expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));

    await waitFor(() => expect(client.reconnectRepository).toHaveBeenCalledWith(REPO_A.path));
    expect(client.registerRepository).not.toHaveBeenCalled();
    expect(updateCfg).toHaveBeenCalledWith({ projectPath: REPO_A.path });
  });

  it("keeps the latest repository when overlapping reconnects resolve out of order", async (): Promise<void> => {
    let resolveAlpha!: (value: ReturnType<typeof makeProjectResponse>) => void;
    let resolveBeta!: (value: ReturnType<typeof makeProjectResponse>) => void;
    const alpha = new Promise<ReturnType<typeof makeProjectResponse>>((resolve): void => {
      resolveAlpha = resolve;
    });
    const beta = new Promise<ReturnType<typeof makeProjectResponse>>((resolve): void => {
      resolveBeta = resolve;
    });
    const updateCfg = vi.fn();
    const client = makeClient({
      reconnectRepository: vi.fn((path): Promise<ReturnType<typeof makeProjectResponse>> =>
        path === REPO_A.path ? alpha : beta,
      ),
    });
    render(<GitClientWindow client={client} updateCfg={updateCfg} />);

    fireEvent.click(await screen.findByRole("button", { name: /alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: /beta/ }));
    act((): void => resolveBeta(makeProjectResponse(REPO_B)));
    await waitFor((): void => {
      expect(updateCfg).toHaveBeenCalledWith({ projectPath: REPO_B.path });
    });

    act((): void => resolveAlpha(makeProjectResponse(REPO_A)));
    await waitFor((): void => {
      expect(client.reconnectRepository).toHaveBeenCalledTimes(2);
    });
    expect(updateCfg).not.toHaveBeenCalledWith({ projectPath: REPO_A.path });
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("beta");
  });

  it("ignores a stale reconnect failure after a newer selection succeeds", async (): Promise<void> => {
    let rejectAlpha!: (reason: unknown) => void;
    let resolveBeta!: (value: ReturnType<typeof makeProjectResponse>) => void;
    const alpha = new Promise<ReturnType<typeof makeProjectResponse>>((_resolve, reject): void => {
      rejectAlpha = reject;
    });
    const beta = new Promise<ReturnType<typeof makeProjectResponse>>((resolve): void => {
      resolveBeta = resolve;
    });
    const client = makeClient({
      reconnectRepository: vi.fn((path): Promise<ReturnType<typeof makeProjectResponse>> =>
        path === REPO_A.path ? alpha : beta,
      ),
    });
    render(<GitClientWindow client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: /alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: /beta/ }));
    act((): void => resolveBeta(makeProjectResponse(REPO_B)));
    await waitFor((): void => {
      expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("beta");
    });

    act((): void => rejectAlpha(new Error("stale reconnect failed")));
    await waitFor((): void => {
      expect(client.reconnectRepository).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText("stale reconnect failed")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("beta");
  });

  it.each([
    ["false", { ...REPO_A, workspaceAvailable: false }],
    [
      "absent",
      {
        path: REPO_A.path,
        name: REPO_A.name,
        favorite: false,
        createdAt: 0,
        lastOpenedAt: 0,
        available: true,
      },
    ],
  ] satisfies readonly (readonly [string, ProjectWithAvailability])[])(
    "rejects a reconnect whose workspace membership is %s",
    async (_label, project) => {
      const updateCfg = vi.fn();
      const client = makeClient({
        reconnectRepository: vi.fn(async () => makeProjectResponse(project)),
      });
      render(<GitClientWindow client={client} updateCfg={updateCfg} />);
      fireEvent.click(await screen.findByRole("button", { name: /alpha/ }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This repository is not currently connected to a workspace.",
      );
      expect(updateCfg).not.toHaveBeenCalledWith({ projectPath: REPO_A.path });
      expect(client.listBranches).not.toHaveBeenCalled();
      expect(client.getStatus).not.toHaveBeenCalled();
    },
  );

  it("rejects an unavailable reconnect", async () => {
    const updateCfg = vi.fn();
    const client = makeClient({
      reconnectRepository: vi.fn(async () => makeProjectResponse({ ...REPO_A, available: false })),
    });
    render(<GitClientWindow client={client} updateCfg={updateCfg} />);
    fireEvent.click(await screen.findByRole("button", { name: /alpha/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This local repository is unavailable. Choose another repository.",
    );
    expect(updateCfg).not.toHaveBeenCalledWith({ projectPath: REPO_A.path });
    expect(client.getStatus).not.toHaveBeenCalled();
  });

  it("selecting a repo triggers a branch and status load for the chosen path", async () => {
    const client = makeClient();
    render(<GitClientWindow client={client} />);
    expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));

    await waitFor(() => expect(client.listBranches).toHaveBeenCalledWith(REPO_A.path));
    expect(client.getStatus).toHaveBeenCalledWith(REPO_A.path);
  });

  it("clears a repository-scoped commit draft when the selected repository changes", async () => {
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    const client = makeClient({
      getStatus: vi.fn(async (path: string) => ({
        ...makeStatusRich(),
        root: path,
        repositoryRoot: path,
      })),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    const summary = await screen.findByLabelText("Summary");
    await user.type(summary, "fix: repository alpha only");

    await user.click(screen.getByRole("combobox", { name: "Repository" }));
    await user.click(await screen.findByRole("option", { name: /beta/ }));

    await waitFor(() => expect(screen.getByLabelText("Summary")).toHaveValue(""));
    expect(diagnostics).toContain(
      "git-client: commit draft cleared (repository-selection-changed)",
    );
  });

  it("refreshes Git state after requested, canonical, and aliased editor saves", async (): Promise<void> => {
    const getStatus = vi.fn(async (): Promise<GitRepositoryStatusResponse> =>
      makeStatus({ repositoryRoot: "/repos" }),
    );
    const client = makeClient({ getStatus });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await screen.findByRole("button", { name: "Branch: main" });
    const initialReads = getStatus.mock.calls.length;

    act((): void => notifyWorkspaceFileMutated(REPO_B.path));
    expect(getStatus).toHaveBeenCalledTimes(initialReads);

    act((): void => notifyWorkspaceFileMutated(REPO_A.path));
    await waitFor((): void => expect(getStatus).toHaveBeenCalledTimes(initialReads + 1));

    act((): void => notifyWorkspaceFileMutated("/repos"));
    await waitFor((): void => expect(getStatus).toHaveBeenCalledTimes(initialReads + 2));

    act((): void => notifyWorkspaceFileMutated("/editor/alias", { repositoryRoot: "/repos" }));
    await waitFor((): void => expect(getStatus).toHaveBeenCalledTimes(initialReads + 3));
  });

  it("ignores the previous canonical root while a newly selected repository is loading", async (): Promise<void> => {
    let resolveBetaStatus!: (value: GitRepositoryStatusResponse) => void;
    const betaStatus = new Promise<GitRepositoryStatusResponse>((resolve): void => {
      resolveBetaStatus = resolve;
    });
    const getStatus = vi.fn((path: string): Promise<GitRepositoryStatusResponse> =>
      path === REPO_A.path
        ? Promise.resolve(makeStatus({ repositoryRoot: "/canonical/alpha" }))
        : betaStatus,
    );
    const client = makeClient({ getStatus });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("No changes")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Repository" }));
    await user.click(await screen.findByRole("option", { name: /beta/ }));
    await waitFor((): void => expect(getStatus).toHaveBeenCalledWith(REPO_B.path));
    expect(screen.getByText("Loading changes…")).toBeInTheDocument();
    const readsAfterSwitch = getStatus.mock.calls.length;

    act((): void => notifyWorkspaceFileMutated("/canonical/alpha"));
    expect(getStatus).toHaveBeenCalledTimes(readsAfterSwitch);

    await act(async (): Promise<void> => {
      resolveBetaStatus(makeStatus({ root: REPO_B.path }));
      await betaStatus;
    });
  });

  it("hides stale changed-file rows while a newly selected repository is loading", async () => {
    let resolveBetaStatus!: (value: GitRepositoryStatusResponse) => void;
    const betaStatus = new Promise<GitRepositoryStatusResponse>((res) => {
      resolveBetaStatus = res;
    });
    const client = makeClient({
      getStatus: vi.fn((path: string) =>
        path === REPO_A.path ? Promise.resolve(makeStatusRich()) : betaStatus,
      ),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("README.md")).toBeInTheDocument();

    // Switch to repo B via the toolbar repository selector.
    await user.click(screen.getByRole("combobox", { name: "Repository" }));
    await user.click(await screen.findByRole("option", { name: /beta/ }));

    await waitFor(() => expect(client.getStatus).toHaveBeenCalledWith(REPO_B.path));
    expect(screen.queryByLabelText("Stage README.md")).not.toBeInTheDocument();
    expect(screen.getByText("Loading changes…")).toBeInTheDocument();

    act(() => resolveBetaStatus(makeStatus()));
  });

  it("hides stale branch names while a newly selected repository is loading", async () => {
    let resolveBetaBranches!: (value: GitBranchListResponse) => void;
    let resolveBetaStatus!: (value: GitRepositoryStatusResponse) => void;
    const betaBranches = new Promise<GitBranchListResponse>((res) => {
      resolveBetaBranches = res;
    });
    const betaStatus = new Promise<GitRepositoryStatusResponse>((res) => {
      resolveBetaStatus = res;
    });
    const client = makeClient({
      listBranches: vi.fn((path: string) =>
        path === REPO_A.path ? Promise.resolve(makeBranchList()) : betaBranches,
      ),
      getStatus: vi.fn((path: string) =>
        path === REPO_A.path ? Promise.resolve(makeStatus()) : betaStatus,
      ),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await screen.findByRole("button", { name: "Branch: main" });

    await user.click(screen.getByRole("combobox", { name: "Repository" }));
    await user.click(await screen.findByRole("option", { name: /beta/ }));

    await waitFor(() => expect(client.listBranches).toHaveBeenCalledWith(REPO_B.path));
    expect(screen.queryByRole("button", { name: "Branch: main" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Branch: Loading branches" })).toBeDisabled();

    act(() => {
      resolveBetaBranches(
        makeBranchList({
          root: REPO_B.path,
          branches: [{ name: "release", headRefHash: "ccc", current: true }],
        }),
      );
      resolveBetaStatus(makeStatus({ root: REPO_B.path, branch: "release" }));
    });
    await screen.findByRole("button", { name: "Branch: release" });
  });

  it("renders a loading state while repos are being fetched", async () => {
    let resolve!: (v: { projects: readonly ProjectWithAvailability[] }) => void;
    const pending = new Promise<{ projects: readonly ProjectWithAvailability[] }>((res) => {
      resolve = res;
    });
    const client = makeClient({ listRepositories: vi.fn(() => pending) });
    render(<GitClientWindow client={client} />);

    expect(screen.getByText("Loading repositories…")).toBeInTheDocument();

    // Resolve to avoid async leak in test runner
    act(() => resolve({ projects: [] }));
  });

  it("shows the error message when listRepositories rejects", async () => {
    const client = makeClient({
      listRepositories: vi.fn(async () => {
        throw new Error("Network failure");
      }),
    });
    render(<GitClientWindow client={client} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Network failure");
  });

  it("does not dispatch Git reads for a configured project without workspace membership", async () => {
    const project = makeRepo("/repos/legacy", "legacy", { workspaceAvailable: false });
    const updateCfg = vi.fn();
    const client = makeClient({
      listRepositories: vi.fn(async () => ({ projects: [project] })),
    });
    render(<GitClientWindow projectId={project.path} client={client} updateCfg={updateCfg} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This repository is not currently connected to a workspace.",
    );
    expect(updateCfg).toHaveBeenCalledWith({ projectPath: "" });
    expect(client.listBranches).not.toHaveBeenCalled();
    expect(client.getSummary).not.toHaveBeenCalled();
    expect(client.getRemotes).not.toHaveBeenCalled();
    expect(client.getStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", []],
    ["unavailable", [makeRepo("/repos/legacy", "legacy", { available: false })]],
  ])("reports a configured %s repository as unavailable", async (_case, projects) => {
    const updateCfg = vi.fn();
    const client = makeClient({
      listRepositories: vi.fn(async () => ({ projects })),
    });
    render(<GitClientWindow projectId="/repos/legacy" client={client} updateCfg={updateCfg} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This local repository is unavailable.",
    );
    expect(updateCfg).toHaveBeenCalledWith({ projectPath: "" });
    expect(client.getStatus).not.toHaveBeenCalled();
  });

  it("offers Connect repository and Clone from URL actions in the connect panel", async () => {
    render(<GitClientWindow client={makeClient()} />);
    expect(screen.getByRole("button", { name: "Connect repository" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clone from URL" })).toBeInTheDocument();
  });

  it("renders recent repositories as focusable buttons", async () => {
    render(<GitClientWindow client={makeClient()} />);
    const alpha = await screen.findByRole("button", { name: /alpha/ });
    alpha.focus();
    expect(alpha).toHaveFocus();
    expect(screen.getByRole("button", { name: /beta/ })).toBeInTheDocument();
  });
});

describe("GitClientWindow — repository selector combobox (toolbar)", () => {
  it("renders the Repository combobox trigger in the toolbar", async () => {
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
    expect(await screen.findByRole("combobox", { name: "Repository" })).toBeInTheDocument();
  });
});

describe("GitClientWindow — add-repository dialog", () => {
  it("consumes a Coding Workbench clone handoff and returns only the reconnected project", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const updateCfg = vi.fn();
    const connected = vi.fn();
    render(
      <GitClientWindow
        client={client}
        initialRepositoryDialog="clone"
        onRepositoryConnected={connected}
        updateCfg={updateCfg}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Add repository" });
    expect(updateCfg).toHaveBeenCalledWith({ repositoryDialog: "" });
    expect(connected).not.toHaveBeenCalled();
    await user.type(
      within(dialog).getByLabelText("Repository URL"),
      "https://github.com/org/repo.git",
    );
    await user.type(within(dialog).getByLabelText("Clone to folder"), "/tmp/repo");
    await user.click(within(dialog).getAllByRole("button", { name: "Clone repository" }).at(-1)!);
    await waitFor(() => expect(connected).toHaveBeenCalledWith(REPO_A.path));
    expect(client.reconnectRepository).toHaveBeenCalledWith(REPO_A.path);
  });

  it("cancelling a handed-off clone never returns a project or calls the clone route", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const connected = vi.fn();
    render(
      <GitClientWindow
        client={client}
        initialRepositoryDialog="clone"
        onRepositoryConnected={connected}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Add repository" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.cloneRepository).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
  });

  it("opens the dialog when the connect-repository button is clicked", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow client={makeClient()} />);
    expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clone from URL" }));

    const dialog = screen.getByRole("dialog", { name: "Add repository" });
    expect(dialog).toBeInTheDocument();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("Clone mode calls cloneRepository with {repositoryUrl, destinationPath}", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<GitClientWindow client={client} />);
    expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clone from URL" }));
    const dialog = screen.getByRole("dialog");

    // Clone mode is default
    await user.type(
      within(dialog).getByLabelText("Repository URL"),
      "https://github.com/org/repo.git",
    );
    await user.type(within(dialog).getByLabelText("Clone to folder"), "/tmp/repo");
    // Two buttons are named "Clone repository": the mode-toggle and the submit.
    // Target the submit button (last in the dialog).
    const cloneBtns = within(dialog).getAllByRole("button", { name: "Clone repository" });
    await user.click(cloneBtns[cloneBtns.length - 1]!);

    await waitFor(() =>
      expect(client.cloneRepository).toHaveBeenCalledWith({
        repositoryUrl: "https://github.com/org/repo.git",
        destinationPath: "/tmp/repo",
      }),
    );
    await waitFor(() => expect(client.reconnectRepository).toHaveBeenCalledWith(REPO_A.path));
    expect(client.registerRepository).not.toHaveBeenCalled();
  });

  it("Open local mode picks a folder and calls registerRepository with {path}", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    nativeFileDialogMock.pickWithNativeDialog.mockResolvedValue({
      kind: "picked",
      paths: ["/home/me/existing-repo"],
    });
    render(<GitClientWindow client={client} />);
    expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect repository" }));
    const dialog = screen.getByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Open local repository" }));
    await user.click(within(dialog).getByRole("button", { name: "Choose local repository" }));
    await waitFor(() =>
      expect(nativeFileDialogMock.pickWithNativeDialog).toHaveBeenCalledWith({
        mode: "open-directory",
        title: "Choose local repository",
      }),
    );
    expect(within(dialog).getByLabelText("Local repository path")).toHaveValue(
      "/home/me/existing-repo",
    );
    await user.click(within(dialog).getByRole("button", { name: "Open repository" }));

    await waitFor(() =>
      expect(client.registerRepository).toHaveBeenCalledWith({ path: "/home/me/existing-repo" }),
    );
    await waitFor(() => expect(client.reconnectRepository).toHaveBeenCalledWith(REPO_A.path));
  });

  it.each([
    [{ kind: "busy" } as const, "Another folder chooser is already open."],
    [{ kind: "unsupported" } as const, "Folder selection is not available in this Keiko session."],
    [{ kind: "error", message: "Picker failed" } as const, "Picker failed"],
  ])("surfaces native picker outcome %#", async (outcome, expectedMessage) => {
    const user = userEvent.setup();
    nativeFileDialogMock.pickWithNativeDialog.mockResolvedValue(outcome);
    render(<GitClientWindow client={makeClient()} />);
    await user.click(await screen.findByRole("button", { name: "Connect repository" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Open local repository" }));

    await user.click(within(dialog).getByRole("button", { name: "Choose local repository" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(expectedMessage);
  });

  it("does not select a newly added repository without explicit workspace membership", async () => {
    const user = userEvent.setup();
    const updateCfg = vi.fn();
    const project = makeRepo("/home/me/stale-repo", "stale", { workspaceAvailable: false });
    const client = makeClient({
      registerRepository: vi.fn(async () => makeProjectResponse(project)),
      reconnectRepository: vi.fn(async () => makeProjectResponse(project)),
    });
    nativeFileDialogMock.pickWithNativeDialog.mockResolvedValue({
      kind: "picked",
      paths: [project.path],
    });
    render(<GitClientWindow client={client} updateCfg={updateCfg} />);
    await user.click(await screen.findByRole("button", { name: "Connect repository" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Open local repository" }));
    await user.click(within(dialog).getByRole("button", { name: "Choose local repository" }));
    await user.click(within(dialog).getByRole("button", { name: "Open repository" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This repository is not currently connected to a workspace.",
    );
    expect(updateCfg).not.toHaveBeenCalledWith({ projectPath: project.path });
    expect(client.getStatus).not.toHaveBeenCalled();
  });

  it("closes the dialog on Escape", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow client={makeClient()} />);
    expect(await screen.findByRole("button", { name: /alpha/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clone from URL" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("GitClientWindow — toolbar actions", () => {
  it("Open in Editor calls onOpenEditor with the selected repository path", async () => {
    const onOpenEditor = vi.fn();
    const client = makeClient();
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        client={client}
        onOpenEditor={onOpenEditor}
        onOpenFiles={vi.fn()}
      />,
    );
    await waitFor(() => expect(client.listBranches).toHaveBeenCalled());

    const openEditor = screen.getByRole("button", { name: /Open in Editor/ });
    // #2694 gives governed Coding Workbench a dedicated glyph; repository-editor navigation keeps
    // the generic source-code glyph so the two surfaces do not become visually conflated.
    expect(openEditor.querySelector('path[d*="M13.5 5.5"]')).toBeInTheDocument();
    expect(openEditor.querySelector('path[d*="M16.4 6.5"]')).not.toBeInTheDocument();
    fireEvent.click(openEditor);
    expect(onOpenEditor).toHaveBeenCalledWith(REPO_A.path);
  });

  it("Open Files calls onOpenFiles with the selected repository path", async () => {
    const onOpenFiles = vi.fn();
    const client = makeClient();
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        client={client}
        onOpenEditor={vi.fn()}
        onOpenFiles={onOpenFiles}
      />,
    );
    await waitFor(() => expect(client.listBranches).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Open Files/ }));
    expect(onOpenFiles).toHaveBeenCalledWith(REPO_A.path);
  });

  it("Open in Editor and Open Files are absent when callbacks are not provided", () => {
    render(<GitClientWindow client={makeClient()} />);
    expect(screen.queryByRole("button", { name: /Open in Editor/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open Files/ })).not.toBeInTheDocument();
  });

  // Issue #3400 — the Git window's own "Connect to Chat" affordance: before RepositoryToolbar and
  // GitClientWindow were wired to ConnectToChatDialog, no button existed anywhere in this window to
  // start connecting a comparison to a Chat, making the entire server-side git-change feature
  // unreachable from the product.
  it("Connect to Chat opens the connect-to-chat dialog for the active repository", async () => {
    const client = makeClient();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.listBranches).toHaveBeenCalled());

    expect(screen.queryByRole("dialog", { name: /Connect Git change to chat/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Connect to Chat/i }));
    expect(
      await screen.findByRole("dialog", { name: /Connect Git change to chat/i }),
    ).toBeInTheDocument();
    // The dialog is scoped to THIS window's own facts: the active repository (for its chat
    // picker) and the active branch (as the fixed comparison head) — never browser-authored.
    await waitFor(() => expect(gitChangeChatMocks.fetchChats).toHaveBeenCalledWith(REPO_A.path));
    expect(screen.getByLabelText("Head branch")).toHaveValue("main");
  });

  it("Connect to Chat is absent when no repository is selected", () => {
    render(<GitClientWindow client={makeClient()} />);
    expect(screen.queryByRole("button", { name: /Connect to Chat/i })).not.toBeInTheDocument();
  });

  it("Sync status renders with a text label", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatus({ clean: true })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());

    const pill = await screen.findByRole("status", { name: /^Sync/ });
    expect(pill).toBeInTheDocument();
  });

  it("Create Pull Request opens an embedded PR panel with selected repository context", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () =>
        makeSummary({
          branch: "feat/issue-1577",
        }),
      ),
      getRemotes: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: REPO_A.path,
        state: "available" as const,
        available: true,
        remotes: [{ name: "origin", fetchUrl: "git@github.com:oscharko-dev/Keiko.git" }],
        truncated: false,
      })),
      getStatus: vi.fn(async () => makeStatus({ branch: "feat/issue-1577" })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    await waitFor(() => expect(client.getRemotes).toHaveBeenCalledWith(REPO_A.path));

    await user.click(screen.getByRole("button", { name: /Create pull request/ }));

    // The PR flow opens an embedded panel in the right pane — never a standalone window.
    const panel = await screen.findByRole("region", { name: "Pull Request" });
    expect(panel).toBeInTheDocument();
    expect(within(panel).getByLabelText("Head branch")).toHaveValue("feat/issue-1577");
    expect(within(panel).getByLabelText("Base branch")).toHaveValue("main");
    // Not getByDisplayValue: the Description panel below (#3399) now also renders once the
    // seam is fully wired, and its own repository field independently prefills to the same
    // inferred owner/repo — so two distinct fields legitimately share this value.
    expect(within(panel).getByLabelText("Repository (owner/repo)")).toHaveValue(
      "oscharko-dev/Keiko",
    );
    expect(client.getHistory).not.toHaveBeenCalled();

    await user.click(within(panel).getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(client.prPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: REPO_A.path,
          ownerAndRepo: "oscharko-dev/Keiko",
          headBranchName: "feat/issue-1577",
          baseBranchName: "main",
        }),
      ),
    );
  });

  // Repair for a review residual on #3399/#3400: before git-client-seam.ts carried prApprove and
  // the four prDescription* clients, GitClientSeam only had `mergeApprove` for the sibling merge
  // card, so the embedded PR pane's GovernedPullRequestCard always saw those fields as `undefined`
  // and (a) the Description panel never rendered (`requiredPrDescriptionClient` returns undefined
  // unless all three prDescription* methods are present) and (b) `runExecute` fell back to the
  // legacy unapproved pr-execute call, which the real BFF route rejects as approval-required
  // forever. Failing-before: with the pre-fix seam (no prApprove/prDescription* fields at all),
  // `screen.findByTestId("gpr-description")` never resolves and `client.prExecute` is called
  // without an `approval` field — both assertions below fail against that code.
  it("shows the Description panel and mints a PR approval through the seam before create (#3399/#3400)", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ branch: "feat/issue-1577" })),
      getRemotes: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: REPO_A.path,
        state: "available" as const,
        available: true,
        remotes: [{ name: "origin", fetchUrl: "git@github.com:oscharko-dev/Keiko.git" }],
        truncated: false,
      })),
      getStatus: vi.fn(async () => makeStatus({ branch: "feat/issue-1577" })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    await waitFor(() => expect(client.getRemotes).toHaveBeenCalledWith(REPO_A.path));

    await user.click(screen.getByRole("button", { name: /Create pull request/ }));
    const panel = await screen.findByRole("region", { name: "Pull Request" });

    // (a) the Description panel is now reachable through the generic Git window's own client.
    expect(await within(panel).findByTestId("gpr-description")).toBeInTheDocument();

    // (b) create still mints and attaches a server-issued approval before execute.
    const titleInput = within(panel).getByLabelText("Pull Request title");
    fireEvent.change(titleInput, { target: { value: "feat: seam wiring" } });
    const submit = within(panel).getByRole("button", { name: "Create Pull Request" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    await waitFor(() => expect(client.prApprove).toHaveBeenCalledTimes(1));
    expect(client.prExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        approval: { schemaVersion: "1", approvalId: "gda_gcw_pr", approvalToken: "token-gcw-pr" },
      }),
    );
  });

  // #3389 (epic #3384 correction 1): the approval-less draft->ready transition through this generic
  // embedded panel is closed — "Mark ready" ("to-ready") is no longer a Draft state option, so this
  // pin is relocated to "Convert to draft" (still a plain pr-update) to keep proving the embedded
  // panel forwards repository context and the draft-transition flag correctly.
  it("updates a Pull Request from the embedded panel with selected repository context", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () =>
        makeSummary({
          branch: "feat/issue-1577",
        }),
      ),
      getRemotes: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: REPO_A.path,
        state: "available" as const,
        available: true,
        remotes: [{ name: "origin", fetchUrl: "git@github.com:oscharko-dev/Keiko.git" }],
        truncated: false,
      })),
      getStatus: vi.fn(async () => makeStatus({ branch: "feat/issue-1577" })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    await waitFor(() => expect(client.getRemotes).toHaveBeenCalledWith(REPO_A.path));

    await user.click(screen.getByRole("button", { name: /Create pull request/ }));
    const panel = await screen.findByRole("region", { name: "Pull Request" });
    await user.click(within(panel).getByLabelText("Update"));
    await user.type(within(panel).getByLabelText("Pull Request number"), "1640");
    await user.type(within(panel).getByLabelText("Pull Request title"), "fix: harden pr path");
    await user.selectOptions(within(panel).getByLabelText("Draft state"), "to-draft");
    await user.click(within(panel).getByRole("button", { name: "Update Pull Request" }));

    await waitFor(() =>
      expect(client.prExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: REPO_A.path,
          kind: "pr-update",
          ownerAndRepo: "oscharko-dev/Keiko",
          headBranchName: "feat/issue-1577",
          baseBranchName: "main",
          prExternalId: "1640",
          convertToDraft: true,
          convertFromDraft: false,
        }),
      ),
    );
  });

  // #3389 (epic #3384 correction 1): failing-before-fix — before this change, selecting "to-ready"
  // reached the generic pr-update execute call with convertFromDraft: true. The option no longer
  // exists in the DOM at all.
  it("does not offer Mark ready in the embedded panel's Draft state select", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ branch: "feat/issue-1577" })),
      getRemotes: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: REPO_A.path,
        state: "available" as const,
        available: true,
        remotes: [{ name: "origin", fetchUrl: "git@github.com:oscharko-dev/Keiko.git" }],
        truncated: false,
      })),
      getStatus: vi.fn(async () => makeStatus({ branch: "feat/issue-1577" })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /Create pull request/ }));
    const panel = await screen.findByRole("region", { name: "Pull Request" });
    await user.click(within(panel).getByLabelText("Update"));
    const select = within(panel).getByLabelText("Draft state");
    const optionValues = [...select.querySelectorAll("option")].map((option) => option.value);
    expect(optionValues).toEqual(["none", "to-draft"]);
  });

  it("surfaces embedded Pull Request provider-auth failures without sensitive text", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () =>
        makeSummary({
          branch: "feat/issue-1577",
        }),
      ),
      getRemotes: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: REPO_A.path,
        state: "available" as const,
        available: true,
        remotes: [{ name: "origin", fetchUrl: "https://github.com/oscharko-dev/Keiko.git" }],
        truncated: false,
      })),
      getStatus: vi.fn(async () => makeStatus({ branch: "feat/issue-1577" })),
      prExecute: vi.fn<GitClientSeam["prExecute"]>(async () => ({
        schemaVersion: "1",
        status: "failed",
        actionKind: "pr-create",
        executionErrorCode: "provider-rejected",
        prRejectionReason: "provider-auth",
        recoveryDisposition: "user-fixable",
        recoveryActionHint: "Reconnect provider access.",
      })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    await waitFor(() => expect(client.getRemotes).toHaveBeenCalledWith(REPO_A.path));

    await user.click(screen.getByRole("button", { name: /Create pull request/ }));
    const panel = await screen.findByRole("region", { name: "Pull Request" });
    const titleInput = within(panel).getByLabelText("Pull Request title");
    fireEvent.change(titleInput, { target: { value: "fix: auth path" } });
    await waitFor(() => expect(titleInput).toHaveValue("fix: auth path"));
    const submit = within(panel).getByRole("button", { name: "Create Pull Request" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    expect(await within(panel).findByTestId("gpr-outcome")).toBeInTheDocument();
    expect(within(panel).getByTestId("gpr-outcome")).toHaveTextContent("rejected: provider-auth");
    expect(within(panel).getByTestId("gpr-outcome")).not.toHaveTextContent(
      /token|secret|authorization/i,
    );
  });

  it("Merge opens an embedded merge panel with selected repository context", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () =>
        makeSummary({
          branch: "feat/issue-1577",
        }),
      ),
      getRemotes: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: REPO_A.path,
        state: "available" as const,
        available: true,
        remotes: [{ name: "origin", fetchUrl: "https://github.com/oscharko-dev/Keiko.git" }],
        truncated: false,
      })),
      getStatus: vi.fn(async () => makeStatus({ branch: "feat/issue-1577" })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    await waitFor(() => expect(client.getRemotes).toHaveBeenCalledWith(REPO_A.path));

    await user.click(screen.getByRole("button", { name: /Merge/ }));

    // The merge flow opens an embedded panel in the right pane — never a standalone window.
    const panel = await screen.findByRole("region", { name: "Merge" });
    expect(panel).toBeInTheDocument();
    expect(within(panel).getByLabelText("Head branch")).toHaveValue("feat/issue-1577");
    expect(within(panel).getByLabelText("Base branch")).toHaveValue("main");
    expect(within(panel).getByDisplayValue("oscharko-dev/Keiko")).toBeInTheDocument();

    fireEvent.change(within(panel).getByLabelText("Pull Request number"), {
      target: { value: "1577" },
    });
    expect(within(panel).getByLabelText("Pull Request number")).toHaveValue("1577");
    await user.click(within(panel).getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(client.mergePreview).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: REPO_A.path,
          ownerAndRepo: "oscharko-dev/Keiko",
          headBranchName: "feat/issue-1577",
          baseBranchName: "main",
          prExternalId: "1577",
        }),
      ),
    );
  });

  it("returns from embedded PR and Merge panels to the diff pane", async () => {
    const user = userEvent.setup();
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    await user.click(screen.getByText("README.md"));
    expect(await screen.findByRole("region", { name: "Diff" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Create pull request/ }));
    expect(await screen.findByRole("region", { name: "Pull Request" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to changes" }));
    const diff = screen.getByRole("region", { name: "Diff" });
    expect(diff).toBeInTheDocument();
    await waitFor(() => expect(diff).toHaveFocus());
    expect(screen.getByText("Changes view opened.")).toBeInTheDocument();
  });

  it("returns from the PR panel to the commit workspace when no diff is selected", async () => {
    const user = userEvent.setup();
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByRole("region", { name: "Commit draft" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Create pull request/ }));
    expect(await screen.findByRole("region", { name: "Pull Request" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to changes" }));

    const commitWorkspace = await screen.findByRole("region", { name: "Commit draft" });
    await waitFor(() => expect(commitWorkspace).toHaveFocus());
  });
});

describe("GitClientWindow — branch, history, and sync workflows (Issue #1576)", () => {
  it("requires explicit confirmation for a branch switch and cancellation is a no-op", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await user.click(await screen.findByRole("button", { name: "Branch: main" }));
    await user.click(screen.getByRole("menuitemradio", { name: /feat\/x/ }));

    const dialog = screen.getByRole("alertdialog", { name: "Confirm branch switch" });
    expect(client.branchSwitch).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(client.branchSwitch).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("alertdialog", { name: "Confirm branch switch" }),
    ).not.toBeInTheDocument();
  });

  it("reconciles editor buffers exactly once after a successful branch switch", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const reconcileEditorBuffers = vi.fn(async () => undefined);
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        client={client}
        reconcileEditorBuffers={reconcileEditorBuffers}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Branch: main" }));
    await user.click(screen.getByRole("menuitemradio", { name: /feat\/x/ }));
    await user.click(screen.getByRole("button", { name: "Switch branch" }));

    await waitFor(() => expect(reconcileEditorBuffers).toHaveBeenCalledTimes(1));
    expect(reconcileEditorBuffers).toHaveBeenCalledWith(REPO_A.path);
  });

  it("keeps a Git refusal separate and does not reconcile editor buffers", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      branchSwitch: vi.fn<GitClientSeam["branchSwitch"]>(async () => ({
        schemaVersion: "1",
        status: "blocked",
        actionKind: "branch-switch",
        preflightFindingCodes: ["dirty-worktree"],
      })),
    });
    const reconcileEditorBuffers = vi.fn(async () => undefined);
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        client={client}
        reconcileEditorBuffers={reconcileEditorBuffers}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Branch: main" }));
    await user.click(screen.getByRole("menuitemradio", { name: /feat\/x/ }));
    await user.click(screen.getByRole("button", { name: "Switch branch" }));

    const outcome = await screen.findByTestId("git-branch-outcome");
    expect(outcome).toHaveTextContent("Blocked");
    expect(outcome).toHaveTextContent("dirty-worktree");
    expect(reconcileEditorBuffers).not.toHaveBeenCalled();
  });

  it("surfaces recovery-required when Git succeeded but editor reconciliation failed", async () => {
    const user = userEvent.setup();
    const reconcileEditorBuffers = vi.fn(async () => Promise.reject(new Error("raw path")));
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        client={makeClient()}
        reconcileEditorBuffers={reconcileEditorBuffers}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Branch: main" }));
    await user.click(screen.getByRole("menuitemradio", { name: /feat\/x/ }));
    await user.click(screen.getByRole("button", { name: "Switch branch" }));

    const outcome = await screen.findByTestId("git-branch-outcome");
    expect(outcome).toHaveTextContent("Recovery required");
    expect(outcome).toHaveTextContent("editor-buffer-reconciliation-failed");
    expect(outcome).not.toHaveTextContent("raw path");
  });

  it("filters real branches and switches only to a selected branch option", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.listBranches).toHaveBeenCalledWith(REPO_A.path));

    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    const search = screen.getByRole("searchbox", { name: "Search branches" });
    await user.type(search, "feat");

    expect(screen.getByRole("menuitemradio", { name: /feat\/x/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: /main/ })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("bbb");

    await user.click(screen.getByRole("menuitemradio", { name: /feat\/x/ }));
    await user.click(screen.getByRole("button", { name: "Switch branch" }));

    await waitFor(() =>
      expect(client.branchSwitch).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        branchName: "feat/x",
      }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Branch: main" })).toHaveFocus());
  });

  it("keeps the current branch option focusable for keyboard users", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);

    await user.click(await screen.findByRole("button", { name: "Branch: main" }));
    const search = screen.getByRole("searchbox", { name: "Search branches" });
    await user.keyboard("{ArrowDown}");

    expect(search).not.toHaveFocus();
    expect(screen.getByRole("menuitemradio", { name: /main/ })).toHaveFocus();
  });

  it("restores focus to the branch trigger when the popup is dismissed", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);

    const trigger = await screen.findByRole("button", { name: "Branch: main" });
    await user.click(trigger);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("creates a new branch from a real base branch while keeping hashes out of the UI", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.listBranches).toHaveBeenCalledWith(REPO_A.path));

    await user.click(screen.getByRole("button", { name: "New branch" }));
    const dialog = screen.getByRole("dialog", { name: "New branch" });
    expect(dialog).not.toHaveTextContent("aaa");
    expect(dialog).not.toHaveTextContent("bbb");

    await user.type(within(dialog).getByLabelText("Branch name"), "feature/new");
    await user.click(within(dialog).getByRole("button", { name: "Create branch" }));

    await waitFor(() =>
      expect(client.branchCreate).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        branchName: "feature/new",
        baseBranchName: "main",
        startPointRefHash: "aaa",
      }),
    );
    expect(client.branchSwitch).toHaveBeenCalledWith({
      projectId: REPO_A.path,
      branchName: "feature/new",
    });
    expect(document.body).not.toHaveTextContent("aaa");
    expect(document.body).not.toHaveTextContent("bbb");
    await waitFor(() => expect(screen.getByRole("button", { name: "New branch" })).toHaveFocus());
  });

  it("keeps the new-branch dialog open and shows the reason when the create-then-switch is blocked", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      branchCreate: vi.fn<GitClientSeam["branchCreate"]>(async () => ({
        schemaVersion: "1",
        status: "blocked",
        actionKind: "branch-create",
        preflightFindingCodes: ["branch-already-exists"],
      })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.listBranches).toHaveBeenCalledWith(REPO_A.path));

    await user.click(screen.getByRole("button", { name: "New branch" }));
    const dialog = screen.getByRole("dialog", { name: "New branch" });
    await user.type(within(dialog).getByLabelText("Branch name"), "feat/x");
    await user.click(within(dialog).getByRole("button", { name: "Create branch" }));

    await waitFor(() => expect(client.branchCreate).toHaveBeenCalled());
    // A rejected create must never proceed to switch, and the dialog must stay open with the
    // rejection reason visible instead of silently sitting there with no explanation.
    expect(client.branchSwitch).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "New branch" })).toBeInTheDocument();
    const outcome = within(dialog).getByTestId("git-branch-outcome");
    expect(outcome).toHaveTextContent("Blocked");
    expect(outcome).toHaveTextContent("branch-already-exists");
  });

  // Sibling-handoff gap: sync-outcome classification was fixed for fetch/pull/push, but a
  // rejected branch switch was never wired to any visible outcome — the busy spinner just turns
  // off and the branch silently stays put with no reason shown (#2841 follow-up).
  it("surfaces a blocked branch-switch outcome instead of silently swallowing it", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      branchSwitch: vi.fn<GitClientSeam["branchSwitch"]>(async () => ({
        schemaVersion: "1",
        status: "blocked",
        actionKind: "branch-switch",
        preflightFindingCodes: ["switch-target-missing"],
      })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.listBranches).toHaveBeenCalledWith(REPO_A.path));

    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    await user.click(screen.getByRole("menuitemradio", { name: /feat\/x/ }));
    await user.click(screen.getByRole("button", { name: "Switch branch" }));

    await waitFor(() =>
      expect(client.branchSwitch).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        branchName: "feat/x",
      }),
    );

    const outcome = await screen.findByTestId("git-branch-outcome");
    expect(outcome).toHaveTextContent("Blocked");
    expect(outcome).toHaveTextContent("switch-target-missing");
  });

  it("surfaces a failed branch-switch outcome with its execution error code", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      branchSwitch: vi.fn<GitClientSeam["branchSwitch"]>(async () => ({
        schemaVersion: "1",
        status: "failed",
        actionKind: "branch-switch",
        executionErrorCode: "conflict",
      })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.listBranches).toHaveBeenCalledWith(REPO_A.path));

    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    await user.click(screen.getByRole("menuitemradio", { name: /feat\/x/ }));
    await user.click(screen.getByRole("button", { name: "Switch branch" }));

    await waitFor(() => expect(client.branchSwitch).toHaveBeenCalled());

    const outcome = await screen.findByTestId("git-branch-outcome");
    expect(outcome).toHaveTextContent("Failed");
    expect(outcome).toHaveTextContent("conflict");
  });

  it("does not surface a stale branch-switch outcome after switching repositories", async () => {
    let resolveSwitch!: (v: {
      readonly schemaVersion: "1";
      readonly status: "blocked";
      readonly actionKind: string;
      readonly preflightFindingCodes: readonly string[];
    }) => void;
    const switchPending = new Promise<{
      readonly schemaVersion: "1";
      readonly status: "blocked";
      readonly actionKind: string;
      readonly preflightFindingCodes: readonly string[];
    }>((res) => {
      resolveSwitch = res;
    });
    const client = makeClient({
      branchSwitch: vi.fn<GitClientSeam["branchSwitch"]>(() => switchPending),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.listBranches).toHaveBeenCalledWith(REPO_A.path));

    fireEvent.click(screen.getByRole("button", { name: "Branch: main" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /feat\/x/ }));
    fireEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    await waitFor(() => expect(client.branchSwitch).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("combobox", { name: "Repository" }));
    fireEvent.click(await screen.findByRole("option", { name: /beta/ }));
    await waitFor(() => expect(client.getStatus).toHaveBeenCalledWith(REPO_B.path));

    await act(async () => {
      resolveSwitch({
        schemaVersion: "1",
        status: "blocked",
        actionKind: "branch-switch",
        preflightFindingCodes: ["switch-target-missing"],
      });
    });

    expect(screen.queryByTestId("git-branch-outcome")).not.toBeInTheDocument();
  });

  it("renders commit history and selected commit diff metadata", async () => {
    const user = userEvent.setup();
    const client = makeClient({ getHistory: vi.fn(async () => makeHistory()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    expect(client.getHistory).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: "History" }));
    await waitFor(() =>
      expect(client.getHistory).toHaveBeenCalledWith({ root: REPO_A.path, limit: 50, skip: 0 }),
    );

    expect(screen.getByRole("list", { name: "Commit history" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /feat: add history/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("region", { name: "Commit details" })).toHaveTextContent(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    await user.click(screen.getByRole("button", { name: /fix: repair sync/ }));

    expect(screen.getByRole("region", { name: "Commit details" })).toHaveTextContent(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(screen.getByRole("region", { name: "Commit details" })).toHaveTextContent(
      "Changed files",
    );
  });

  it("pulls a behind branch through sync preview before execute", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ behind: 2 })),
      syncPreview: vi.fn<GitClientSeam["syncPreview"]>(async (input) =>
        makeSyncPreview(input.operation, { behind: 2 }),
      ),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    const button = await screen.findByRole("button", { name: "Run sync: Pull" });
    await user.click(button);
    await user.click(screen.getByRole("button", { name: "Pull changes" }));

    await waitFor(() =>
      expect(client.syncPreview).toHaveBeenCalledWith({
        operation: "pull",
        projectId: REPO_A.path,
        remote: "origin",
      }),
    );
    expect(client.syncExecute).toHaveBeenCalledWith({
      operation: "pull",
      projectId: REPO_A.path,
      remote: "origin",
    });
  });

  it("confirms pull and reconciles editor buffers once after successful execution", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ behind: 1 })),
      syncPreview: vi.fn<GitClientSeam["syncPreview"]>(async (input) =>
        makeSyncPreview(input.operation, { behind: 1 }),
      ),
    });
    const reconcileEditorBuffers = vi.fn(async () => undefined);
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        client={client}
        reconcileEditorBuffers={reconcileEditorBuffers}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Run sync: Pull" }));
    const dialog = screen.getByRole("alertdialog", { name: "Confirm pull" });
    expect(client.syncPreview).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Pull changes" }));

    await waitFor(() => expect(client.syncExecute).toHaveBeenCalledTimes(1));
    expect(reconcileEditorBuffers).toHaveBeenCalledTimes(1);
  });

  it("cancels a pull without previewing or mutating the working tree", async () => {
    const user = userEvent.setup();
    const client = makeClient({ getSummary: vi.fn(async () => makeSummary({ behind: 1 })) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await user.click(await screen.findByRole("button", { name: "Run sync: Pull" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(client.syncPreview).not.toHaveBeenCalled();
    expect(client.syncExecute).not.toHaveBeenCalled();
  });

  it("reports pull reconciliation recovery without claiming success", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ behind: 1 })),
      syncPreview: vi.fn<GitClientSeam["syncPreview"]>(async (input) =>
        makeSyncPreview(input.operation, { behind: 1 }),
      ),
    });
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        client={client}
        reconcileEditorBuffers={async () => Promise.reject(new Error("raw path"))}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Run sync: Pull" }));
    await user.click(screen.getByRole("button", { name: "Pull changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Pull completed, but editor buffers need recovery");
    expect(alert).not.toHaveTextContent("succeeded");
    expect(alert).not.toHaveTextContent("raw path");
  });

  // GEN-PERF-WIDGET-006 — the sync outcome must carry a duration and an ahead/behind
  // repository-state delta, not just a bare status string.
  it("surfaces sync duration and ahead/behind delta in the outcome", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ behind: 2 })),
      syncPreview: vi.fn<GitClientSeam["syncPreview"]>(async (input) =>
        makeSyncPreview(input.operation, { behind: 2 }),
      ),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("button", { name: "Run sync: Pull" }));
    await user.click(screen.getByRole("button", { name: "Pull changes" }));

    await waitFor(() => expect(client.syncExecute).toHaveBeenCalled());
    const pill = await screen.findByRole("status", { name: /Pull: succeeded/ });
    // GEN-UI-A11Y-017: the outcome now lives in the region's visible text content (announced via
    // aria-live) rather than a duplicating aria-label, so assert against textContent.
    const label = pill.textContent ?? "";
    // Duration segment "in <n>s" and the ahead/behind delta must both be present.
    expect(label).toMatch(/in \d+(\.\d+)?s/);
    expect(label).toMatch(/behind 2/);
  });

  it("does not execute network sync when preview blocks", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ behind: 1 })),
      syncPreview: vi.fn<GitClientSeam["syncPreview"]>(async (input) =>
        makeSyncPreview(input.operation, {
          executable: false,
          blockReason: "no-upstream",
          hasUpstream: false,
        }),
      ),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("button", { name: "Run sync: Pull" }));
    await user.click(screen.getByRole("button", { name: "Pull changes" }));

    await waitFor(() => expect(client.syncPreview).toHaveBeenCalled());
    expect(client.syncExecute).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: /Blocked: no-upstream/ })).toBeInTheDocument();
  });

  it("publishes a branch with upstream tracking through the governed push route", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () =>
        makeSummary({
          upstream: undefined,
          ahead: 1,
          branch: "feature/local",
        }),
      ),
      pushPreview: vi.fn<GitClientSeam["pushPreview"]>(async () =>
        makePushPreview({
          remoteBranchName: "feature/local",
          sourceBranchName: "feature/local",
          wouldCreateRemoteBranch: true,
        }),
      ),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("button", { name: "Run sync: Publish upstream" }));

    await waitFor(() =>
      expect(client.pushPreview).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        remoteAlias: "origin",
        remoteBranchName: "feature/local",
        sourceBranchName: "feature/local",
        forcePush: false,
        setUpstreamTracking: true,
      }),
    );
    expect(client.pushPropose).toHaveBeenCalledWith({
      projectId: REPO_A.path,
      remoteAlias: "origin",
      remoteBranchName: "feature/local",
      sourceBranchName: "feature/local",
      forcePush: false,
      setUpstreamTracking: true,
    });
  });

  // A settled-but-FAILED sync used to render in the neutral success pill (role=status,
  // --fg-muted) as the untranslated machine token, e.g. "Pull: auth-failed".
  it("renders a failed fetch/pull outcome as an alert in human language", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ behind: 2 })),
      syncPreview: vi.fn<GitClientSeam["syncPreview"]>(async (input) =>
        makeSyncPreview(input.operation, { behind: 2 }),
      ),
      syncExecute: vi.fn<GitClientSeam["syncExecute"]>(async (input) => ({
        schemaVersion: "1",
        operation: input.operation,
        status: "remote-unavailable",
        available: true,
        truncated: false,
      })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("button", { name: "Run sync: Pull" }));
    await user.click(screen.getByRole("button", { name: "Pull changes" }));
    await waitFor(() => expect(client.syncExecute).toHaveBeenCalled());

    const pill = await screen.findByRole("alert");
    expect(pill).toHaveTextContent(/remote/i);
    expect(pill).not.toHaveTextContent("remote-unavailable");
    expect(screen.queryByRole("status", { name: /Pull:/ })).not.toBeInTheDocument();
  });

  it("keeps a successful sync outcome in the neutral status pill", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ behind: 2 })),
      syncPreview: vi.fn<GitClientSeam["syncPreview"]>(async (input) =>
        makeSyncPreview(input.operation, { behind: 2 }),
      ),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("button", { name: "Run sync: Pull" }));
    await user.click(screen.getByRole("button", { name: "Pull changes" }));
    await waitFor(() => expect(client.syncExecute).toHaveBeenCalled());

    expect(await screen.findByRole("status", { name: /Pull: succeeded/ })).toBeInTheDocument();
  });

  // The server computes publishRejectionReason / recoveryActionHint for a rejected push; the Git
  // window's sync path never rendered either, so a rejected push read as a neutral "Push: failed".
  it("surfaces the push rejection reason and the recovery hint", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ ahead: 2 })),
      pushPropose: vi.fn<GitClientSeam["pushPropose"]>(async () => ({
        schemaVersion: "1",
        status: "failed",
        actionKind: "push",
        executionErrorCode: "precondition-failed",
        publishRejectionReason: "non-fast-forward",
        recoveryDisposition: "user-fixable",
        recoveryActionHint: "resolve-conflicts",
      })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("button", { name: "Run sync: Push" }));
    await waitFor(() => expect(client.pushPropose).toHaveBeenCalled());

    const pill = await screen.findByRole("alert");
    expect(pill).toHaveTextContent(/newer commits/i);
    expect(pill).toHaveTextContent(/resolve/i);
    expect(pill).not.toHaveTextContent("non-fast-forward");
    expect(pill).not.toHaveTextContent("resolve-conflicts");
  });

  // F3 (epic #3384 final audit): before proposePush existed, runPushSync called pushExecute
  // directly with no mint step at all — an accepted run's push could never satisfy the epic's
  // unconditional approval requirement. When the mint itself is denied, proposePush resolves to
  // the same static "approval-required" outcome the pack-driven approval-gated path already
  // renders, so the existing pushOutcomePresentation catalog surfaces it without a new code path.
  it("shows the approval-required label when the push mint is denied (F3)", async () => {
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ ahead: 2 })),
      pushPropose: vi.fn<GitClientSeam["pushPropose"]>(async () => ({
        schemaVersion: "1",
        status: "approval-required",
        actionKind: "push",
      })),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("button", { name: "Run sync: Push" }));
    await waitFor(() => expect(client.pushPropose).toHaveBeenCalled());

    const pill = await screen.findByRole("alert");
    expect(pill).toHaveTextContent(/approval/i);
  });

  it("shows diverged branches as an explicit safe fetch state with merge guidance", async () => {
    const client = makeClient({
      getSummary: vi.fn(async () => makeSummary({ ahead: 2, behind: 3 })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    expect(await screen.findByRole("button", { name: "Run sync: Fetch" })).toBeInTheDocument();
    expect(await screen.findByText(/Diverged: 2 ahead, 3 behind/)).toBeInTheDocument();
    expect(screen.getByText(/Use the Merge entry point/)).toBeInTheDocument();
  });

  it("blocks detached and conflicted sync states with visible safe next actions", async () => {
    const detachedClient = makeClient({
      getStatus: vi.fn(async () => makeStatus({ detached: true, branch: undefined })),
      getSummary: vi.fn(async () => makeSummary({ detached: true, branch: undefined })),
    });
    const { rerender } = render(
      <GitClientWindow projectId={REPO_A.path} client={detachedClient} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Detached HEAD");
    expect(await screen.findByRole("button", { name: "Run sync: Detached HEAD" })).toBeDisabled();

    const conflictedClient = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      getSummary: vi.fn(async () => makeSummary({ conflictedCount: 1, clean: false })),
    });
    rerender(<GitClientWindow projectId={REPO_A.path} client={conflictedClient} />);

    await waitFor(() => expect(conflictedClient.getSummary).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Resolve conflicted files"),
    );
    expect(screen.getByRole("button", { name: "Run sync: Resolve conflicts" })).toBeDisabled();
  });
});

describe("GitClientWindow — Changes/History tabs", () => {
  it("renders a tablist with Changes and History tabs, Changes aria-selected initially", async () => {
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
    const tablist = await screen.findByRole("tablist");
    expect(tablist).toBeInTheDocument();

    const changesTab = within(tablist).getByRole("tab", { name: "Changes" });
    const historyTab = within(tablist).getByRole("tab", { name: "History" });

    expect(changesTab).toHaveAttribute("aria-selected", "true");
    expect(historyTab).toHaveAttribute("aria-selected", "false");
  });

  it("clicking History tab makes it aria-selected and deselects Changes", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
    const tablist = await screen.findByRole("tablist");

    await user.click(within(tablist).getByRole("tab", { name: "History" }));

    expect(within(tablist).getByRole("tab", { name: "History" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(tablist).getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  // The server already reports `truncated` for a capped history read (and the Changes and Diff panes
  // both label their own truncation); History dropped the label, so the list silently claimed to be
  // the whole history.
  it("labels a truncated commit history instead of presenting it as complete", async () => {
    const user = userEvent.setup();
    const client = makeClient({ getHistory: vi.fn(async () => makeHistory({ truncated: true })) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("tab", { name: "History" }));
    await waitFor(() => expect(client.getHistory).toHaveBeenCalled());

    expect(await screen.findByText(/truncated/i)).toBeInTheDocument();
  });

  it("does not label an untruncated commit history", async () => {
    const user = userEvent.setup();
    const client = makeClient({ getHistory: vi.fn(async () => makeHistory()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("tab", { name: "History" }));
    await waitFor(() => expect(client.getHistory).toHaveBeenCalled());

    expect(screen.queryByText(/truncated/i)).not.toBeInTheDocument();
  });

  it("loads the 51st commit with a deterministic 50-entry cursor and exposes the end state", async () => {
    const user = userEvent.setup();
    const getHistory = vi.fn<GitClientSeam["getHistory"]>(async ({ skip = 0 }) =>
      skip === 0 ? makeHistoryPage(0, 50) : makeHistoryPage(50, 1, { truncated: false }),
    );
    const client = makeClient({ getHistory });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("tab", { name: "History" }));
    await user.click(await screen.findByRole("button", { name: "Load more commits" }));

    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Commit history" })).getAllByRole("button"),
      ).toHaveLength(51),
    );
    expect(getHistory).toHaveBeenNthCalledWith(1, { root: REPO_A.path, limit: 50, skip: 0 });
    expect(getHistory).toHaveBeenNthCalledWith(2, { root: REPO_A.path, limit: 50, skip: 50 });
    expect(screen.getByRole("status", { name: "History pagination status" })).toHaveTextContent(
      "End of history. 51 commits loaded.",
    );
    expect(screen.queryByRole("button", { name: "Load more commits" })).not.toBeInTheDocument();
  });

  it("appends multiple pages in order, deduplicates overlap, and advances by the raw page size", async () => {
    const user = userEvent.setup();
    const getHistory = vi.fn<GitClientSeam["getHistory"]>(async ({ skip = 0 }) => {
      if (skip === 0) return makeHistoryPage(0, 50);
      if (skip === 50) {
        return makeHistory({
          entries: [makeHistoryEntry(49), makeHistoryEntry(50)],
          skip: 50,
          truncated: true,
        });
      }
      return makeHistoryPage(51, 1, { skip: 52, truncated: false });
    });
    const client = makeClient({ getHistory });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("tab", { name: "History" }));
    await user.click(await screen.findByRole("button", { name: "Load more commits" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Commit history" })).getAllByRole("button"),
      ).toHaveLength(51),
    );
    await user.click(screen.getByRole("button", { name: "Load more commits" }));

    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Commit history" })).getAllByRole("button"),
      ).toHaveLength(52),
    );
    expect(getHistory).toHaveBeenNthCalledWith(3, { root: REPO_A.path, limit: 50, skip: 52 });
    expect(
      within(screen.getByRole("list", { name: "Commit history" }))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(
      Array.from({ length: 52 }, (_entry, index) =>
        expect.stringContaining(`commit ${index.toString()}`),
      ),
    );
  });

  it("discards an in-flight page when the repository changes", async (): Promise<void> => {
    const user = userEvent.setup();
    let resolveStalePage!: (value: GitHistoryResponse) => void;
    const stalePage = new Promise<GitHistoryResponse>((resolve): void => {
      resolveStalePage = resolve;
    });
    const getHistory = vi.fn<GitClientSeam["getHistory"]>(({ root, skip = 0 }) => {
      if (root === REPO_A.path && skip === 0) return Promise.resolve(makeHistoryPage(0, 50));
      if (root === REPO_A.path) return stalePage;
      return Promise.resolve(
        makeHistoryPage(500, 1, { root: REPO_B.path, skip: 0, truncated: false }),
      );
    });
    const client = makeClient({ getHistory });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("tab", { name: "History" }));
    await user.click(await screen.findByRole("button", { name: "Load more commits" }));
    await user.click(screen.getByRole("combobox", { name: "Repository" }));
    await user.click(await screen.findByRole("option", { name: /beta/ }));
    expect(await screen.findByRole("button", { name: /commit 500/ })).toBeInTheDocument();

    act((): void => resolveStalePage(makeHistoryPage(100, 1, { skip: 50, truncated: false })));
    await waitFor(() =>
      expect(getHistory).toHaveBeenCalledWith({ root: REPO_B.path, limit: 50, skip: 0 }),
    );
    expect(screen.queryByText("commit 100")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Commit history" })).getAllByRole("button"),
    ).toHaveLength(1);
  });

  it("keeps loaded commits and retries the same cursor without exposing the failure body", async () => {
    const user = userEvent.setup();
    let loadMoreAttempts = 0;
    const getHistory = vi.fn<GitClientSeam["getHistory"]>(async ({ skip = 0 }) => {
      if (skip === 0) return makeHistoryPage(0, 50);
      loadMoreAttempts += 1;
      if (loadMoreAttempts === 1) throw new Error("private provider response body");
      return makeHistoryPage(50, 1, { truncated: false });
    });
    const client = makeClient({ getHistory });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("tab", { name: "History" }));
    await user.click(await screen.findByRole("button", { name: "Load more commits" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load more commits.");
    expect(screen.queryByText(/private provider response body/i)).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Commit history" })).getAllByRole("button"),
    ).toHaveLength(50);
    await user.click(screen.getByRole("button", { name: "Retry loading commits" }));

    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Commit history" })).getAllByRole("button"),
      ).toHaveLength(51),
    );
    expect(getHistory).toHaveBeenNthCalledWith(3, { root: REPO_A.path, limit: 50, skip: 50 });
    expect(screen.getByRole("status", { name: "History pagination status" })).toHaveTextContent(
      "End of history. 51 commits loaded.",
    );
  });

  it("ArrowRight on Changes tab moves focus and selection to History", async () => {
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
    const changesTab = await screen.findByRole("tab", { name: "Changes" });
    changesTab.focus();
    fireEvent.keyDown(changesTab, { key: "ArrowRight" });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("ArrowLeft on History tab wraps back to Changes", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);

    // Navigate to History first
    await user.click(await screen.findByRole("tab", { name: "History" }));
    const historyTab = screen.getByRole("tab", { name: "History" });
    historyTab.focus();
    fireEvent.keyDown(historyTab, { key: "ArrowLeft" });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("Home key on History tab moves to Changes", async () => {
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);

    await user.click(await screen.findByRole("tab", { name: "History" }));
    const historyTab = screen.getByRole("tab", { name: "History" });
    historyTab.focus();
    fireEvent.keyDown(historyTab, { key: "Home" });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("End key on Changes tab moves to History", async () => {
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
    const changesTab = await screen.findByRole("tab", { name: "Changes" });
    changesTab.focus();
    fireEvent.keyDown(changesTab, { key: "End" });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true"),
    );
  });
});

describe("GitClientWindow — empty / loading / error states", () => {
  it("shows the connect panel when no repo is selected (no status, no changes)", () => {
    render(<GitClientWindow client={makeClient()} />);
    // Before any selection the body shows the Connect panel rather than the two-column view.
    expect(screen.getByText("No repository connected")).toBeInTheDocument();
    expect(screen.getByText(/Connect a folder or repository/i)).toBeInTheDocument();
  });

  it("shows a loading state while status is pending after repo selection", async () => {
    let resolveStatus!: (v: GitRepositoryStatusResponse) => void;
    const pendingStatus = new Promise<GitRepositoryStatusResponse>((res) => {
      resolveStatus = res;
    });
    const client = makeClient({ getStatus: vi.fn(() => pendingStatus) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    // listBranches resolves quickly; status is still pending
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    expect(screen.getByText(/Loading changes/i)).toBeInTheDocument();

    act(() => resolveStatus(makeStatus()));
  });

  it("shows an error state when getStatus rejects", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => {
        throw new Error("Status fetch failed");
      }),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Status fetch failed");
  });

  it("shows no-changes empty state when status is clean", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatus({ clean: true })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    expect(await screen.findByText("No changes")).toBeInTheDocument();
  });

  // AC (Issue #1576): "Empty repository and no-repository states guide users to clone or
  // open a local repository." The no-repository state must surface guidance plus the
  // add-repository affordance rather than an empty void.
  it("shows the no-repository empty state guiding users to add a repository", async () => {
    const client = makeClient({
      listRepositories: vi.fn(async () => ({ projects: [] })),
    });
    render(<GitClientWindow client={client} />);

    await waitFor(() => expect(client.listRepositories).toHaveBeenCalled());
    expect(
      screen.getByText("No repositories yet. Connect or clone one to get started."),
    ).toBeInTheDocument();
    // The connect affordances stay reachable from the empty list.
    expect(screen.getByRole("button", { name: "Connect repository" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clone from URL" })).toBeInTheDocument();
  });

  // AC (Issue #1576): the empty repository state (initialized repo with zero commits) must
  // explain how to start history instead of rendering an empty commit listbox.
  it("shows the no-commits history empty state for an initialized repository", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getHistory: vi.fn(async () => makeHistory({ entries: [] })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());

    await user.click(screen.getByRole("tab", { name: "History" }));
    await waitFor(() => expect(client.getHistory).toHaveBeenCalled());

    expect(screen.getByText("No commits yet. Make a commit to start history.")).toBeInTheDocument();
    // An empty history must not render the commit list.
    expect(screen.queryByRole("list", { name: "Commit history" })).not.toBeInTheDocument();
  });
});

describe("GitClientWindow — changed-files list and diff selection", () => {
  it("renders changed files with single-char glyphs from status", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusWithChanges()),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    // "M" glyph for staged file, "M" for worktree-only file
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("selecting a changed file triggers the structured diff read with root and path", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusWithChanges()),
      getStructuredDiff: vi.fn(async () => makeStructuredDiffResponse("", "staged")),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByText("index.ts").closest("button")!);

    // src/index.ts is staged-only, so the pane defaults its scope to "staged".
    await waitFor(() =>
      expect(client.getStructuredDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "src/index.ts",
        scope: "staged",
      }),
    );
  });

  it("renders every file section of a multi-file diff (no silent truncation)", async () => {
    // A single diff payload can describe more than one file. The pane must render all of
    // them, not just the first — otherwise additional files are silently dropped.
    const multiFileDiff = [
      "diff --git a/src/first.ts b/src/first.ts",
      "--- a/src/first.ts",
      "+++ b/src/first.ts",
      "@@ -1,1 +1,1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "diff --git a/src/second.ts b/src/second.ts",
      "--- a/src/second.ts",
      "+++ b/src/second.ts",
      "@@ -1,1 +1,1 @@",
      "-const b = 1;",
      "+const b = 2;",
      "",
    ].join("\n");
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusWithChanges()),
      getStructuredDiff: vi.fn(async () => makeStructuredDiffResponse(multiFileDiff, "staged")),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByText("index.ts").closest("button")!);

    // Both file headings from the diff must be present — the second file is the regression guard.
    expect(await screen.findByText("src/first.ts")).toBeInTheDocument();
    expect(screen.getByText("src/second.ts")).toBeInTheDocument();
  });

  it("shows a clicked change in the diff", async () => {
    const structured = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -12,1 +12,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusWithChanges()),
      getStructuredDiff: vi.fn(async () => makeStructuredDiffResponse(structured, "staged")),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    fireEvent.click((await screen.findByText("index.ts")).closest("button")!);

    await waitFor(() =>
      expect(client.getStructuredDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "src/index.ts",
        scope: "staged",
      }),
    );
  });

  it("opens a clicked change in the editor at its first changed line", async () => {
    const onOpenEditorFile = vi.fn();
    const structured = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -12,1 +12,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusWithChanges()),
      getStructuredDiff: vi.fn(async () => makeStructuredDiffResponse(structured, "staged")),
    });
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        client={client}
        onOpenEditorFile={onOpenEditorFile}
      />,
    );

    fireEvent.click((await screen.findByText("index.ts")).closest("button")!);

    await waitFor(() =>
      expect(onOpenEditorFile).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "src/index.ts",
        lineStart: 12,
        lineEnd: 12,
      }),
    );
  });

  it("focuses an editor-originated path without bouncing back to the editor", async () => {
    const onOpenEditorFile = vi.fn();
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusWithChanges()),
    });
    render(
      <GitClientWindow
        projectId={REPO_A.path}
        initialPath="README.md"
        client={client}
        onOpenEditorFile={onOpenEditorFile}
      />,
    );

    await waitFor(() =>
      expect(client.getStructuredDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "README.md",
        scope: "unstaged",
      }),
    );
    expect(onOpenEditorFile).not.toHaveBeenCalled();
  });
});

describe("GitClientWindow — internal commit landing", () => {
  it("selects a validated blame commit in bounded history", async () => {
    const client = makeClient({ getHistory: vi.fn(async () => makeHistory()) });
    render(
      <GitClientWindow projectId={REPO_A.path} initialCommit={"b".repeat(40)} client={client} />,
    );

    expect(await screen.findByRole("heading", { name: "fix: repair sync" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  });

  it("fails closed when a validated commit is outside bounded history", async () => {
    const client = makeClient({ getHistory: vi.fn(async () => makeHistory()) });
    render(
      <GitClientWindow projectId={REPO_A.path} initialCommit={"c".repeat(40)} client={client} />,
    );

    expect(
      await screen.findByText("The requested commit is not available in bounded history."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "feat: add history" })).not.toBeInTheDocument();
  });
});

describe("GitClientWindow — required visible / absent words", () => {
  // The contract (§7 / EV2/EV4) requires each of these words to appear in visible rendered text
  // or accessible names. We assert them via the most reliable queries available for each word:
  // getByText (exact substring match in rendered node text) or getByRole/getByLabelText where
  // textContent concatenation makes word-boundary regexes unreliable.

  it("renders 'Git' as the card's accessible heading", () => {
    render(<GitClientWindow client={makeClient()} />);
    // The Git window labels itself "Git" (the visible "Git" title is workspace chrome).
    expect(screen.getByRole("heading", { name: "Git" })).toBeInTheDocument();
  });

  it("renders 'Repository' as the combobox label in the toolbar", async () => {
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
    // KeikoSelect renders with aria-label="Repository"
    expect(await screen.findByRole("combobox", { name: "Repository" })).toBeInTheDocument();
  });

  it("renders 'Changes' as a visible tab label", async () => {
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
    expect(await screen.findByRole("tab", { name: "Changes" })).toBeInTheDocument();
  });

  it("renders 'History' as a visible tab label", async () => {
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
    expect(await screen.findByRole("tab", { name: "History" })).toBeInTheDocument();
  });

  it("renders 'Branch' as the branch combobox label in the toolbar", async () => {
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
    expect(await screen.findByRole("button", { name: "Branch: main" })).toBeInTheDocument();
  });

  it("renders 'Sync' in the status pill", async () => {
    const client = makeClient();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.getStatus).toHaveBeenCalled());
    // Sync status pill text always starts with "Sync"
    expect(screen.getByLabelText(/^Sync/)).toBeInTheDocument();
  });

  it("renders 'Pull Request' as a visible button", async () => {
    render(
      <GitClientWindow projectId={REPO_A.path} client={makeClient()} onOpenEditor={vi.fn()} />,
    );
    expect(await screen.findByRole("button", { name: /Create pull request/i })).toBeInTheDocument();
  });

  it("renders 'Merge' as a visible button", async () => {
    render(
      <GitClientWindow projectId={REPO_A.path} client={makeClient()} onOpenEditor={vi.fn()} />,
    );
    expect(await screen.findByRole("button", { name: /Merge/ })).toBeInTheDocument();
  });

  it("renders 'Commit' as visible text in the composer", async () => {
    // "Commit" is required visible vocabulary per contract §7. The commit button reads
    // "Commit to <branch>" — asserting it directly keeps the requirement mutation-robust.
    render(<GitClientWindow projectId={REPO_A.path} client={makeClient()} />);
    expect(await screen.findByRole("button", { name: /^Commit/ })).toBeInTheDocument();
  });

  it("never renders forbidden governance / delivery vocabulary in visible text", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusWithChanges()),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} onOpenEditor={vi.fn()} />);
    await waitFor(() => expect(client.listRepositories).toHaveBeenCalled());

    const body = document.body.textContent ?? "";

    expect(body).not.toMatch(/\bGovernance\b/);
    expect(body).not.toMatch(/Governed Git/);
    expect(body).not.toMatch(/Delivery path/);
  });
});

describe("GitClientWindow — staging controls (Issue #1575)", () => {
  it("renders staged / unstaged / untracked / conflicted indicators with checkboxes", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    // A staged file's checkbox is checked and reads "Unstage <path>".
    expect(screen.getByLabelText("Unstage src/index.ts")).toBeChecked();
    // An unstaged file's checkbox is unchecked and reads "Stage <path>".
    expect(screen.getByLabelText("Stage README.md")).not.toBeChecked();
    // Each row's accessible name conveys its state as words (never colour alone).
    expect(screen.getByRole("button", { name: /notes\.txt, untracked/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /merge\.ts, conflicted/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /partial\.ts, staged modified; worktree modified/ }),
    ).toBeInTheDocument();
  });

  it("checking an unstaged file stages it through the stage route", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("README.md")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Stage README.md"));

    await waitFor(() =>
      expect(client.stage).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        pathspecs: ["README.md"],
        includeUntracked: false,
      }),
    );
  });

  it("staging an untracked file passes includeUntracked: true", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Stage notes.txt"));

    await waitFor(() =>
      expect(client.stage).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        pathspecs: ["notes.txt"],
        includeUntracked: true,
      }),
    );
  });

  it("unchecking a staged file unstages it through the unstage route", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Unstage src/index.ts"));

    await waitFor(() =>
      expect(client.unstage).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        pathspecs: ["src/index.ts"],
      }),
    );
  });

  it("Stage all stages every unstaged and untracked path with includeUntracked", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("README.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stage all" }));

    await waitFor(() => expect(client.stage).toHaveBeenCalled());
    expect(client.stage).toHaveBeenCalledWith({
      projectId: REPO_A.path,
      pathspecs: ["README.md", "notes.txt", "partial.ts"],
      includeUntracked: true,
    });
  });

  it("Unstage all unstages every staged path", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Unstage all" }));

    await waitFor(() => expect(client.unstage).toHaveBeenCalled());
    expect(client.unstage).toHaveBeenCalledWith({
      projectId: REPO_A.path,
      pathspecs: ["src/index.ts", "partial.ts"],
    });
  });

  it("disables bulk staging when the status response is truncated", async () => {
    const truncatedStatus = { ...makeStatusRich(), truncated: true, maxChanges: 2 };
    const client = makeClient({ getStatus: vi.fn(async () => truncatedStatus) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("README.md")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Stage all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unstage all" })).toBeDisabled();
  });

  it("refreshes the changed-file list after a successful stage", async () => {
    const getStatus = vi.fn(async () => makeStatusRich());
    const client = makeClient({ getStatus });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    const callsBefore = getStatus.mock.calls.length;

    fireEvent.click(screen.getByLabelText("Stage README.md"));

    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    // The live region is the banner's concise headline — an <output>, the element that owns
    // role=status (S6819) — rather than the whole banner, which wraps block-level structure
    // an <output> may not contain. The role is implicit, so assert the computed role and the
    // element rather than a literal role attribute.
    const outcome = await screen.findByTestId("git-staging-outcome-headline");
    expect(outcome).toHaveRole("status");
    expect(outcome.tagName).toBe("OUTPUT");
    expect(outcome).toHaveTextContent("Succeeded");
  });

  it("surfaces a blocked staging outcome without refreshing", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      stage: vi.fn<GitClientSeam["stage"]>(async () => ({
        schemaVersion: "1",
        status: "blocked",
        actionKind: "stage",
        blockReason: "policy-denied",
      })),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("README.md")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Stage README.md"));

    const outcome = await screen.findByTestId("git-staging-outcome");
    expect(outcome).toHaveTextContent("Blocked");
    expect(outcome).toHaveTextContent("policy-denied");
  });

  it("does not surface an in-flight staging outcome after switching repositories", async () => {
    // A staging response for repo A that lands after the user has switched to repo B must not
    // write repo A's outcome into the flow now displayed under repo B (stale-flow invalidation).
    let resolveStage!: (v: {
      readonly schemaVersion: "1";
      readonly status: "blocked";
      readonly actionKind: string;
      readonly blockReason: string;
    }) => void;
    const stagePending = new Promise<{
      readonly schemaVersion: "1";
      readonly status: "blocked";
      readonly actionKind: string;
      readonly blockReason: string;
    }>((res) => {
      resolveStage = res;
    });
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      stage: vi.fn<GitClientSeam["stage"]>(() => stagePending),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("README.md")).toBeInTheDocument();

    // Begin staging in repo A (in flight), then switch to repo B before it resolves.
    fireEvent.click(screen.getByLabelText("Stage README.md"));
    fireEvent.click(screen.getByRole("combobox", { name: "Repository" }));
    fireEvent.click(await screen.findByRole("option", { name: /beta/ }));
    await waitFor(() => expect(client.getStatus).toHaveBeenCalledWith(REPO_B.path));

    await act(async () => {
      resolveStage({
        schemaVersion: "1",
        status: "blocked",
        actionKind: "stage",
        blockReason: "policy-denied",
      });
    });

    // The repo-A outcome was invalidated on switch — no banner appears under repo B.
    expect(screen.queryByTestId("git-staging-outcome")).not.toBeInTheDocument();
  });
});

describe("GitClientWindow — commit composer (Issue #1575)", () => {
  it("removes stale commit evidence after all selected files are unstaged", async () => {
    const getStatus = vi
      .fn<GitClientSeam["getStatus"]>()
      .mockResolvedValueOnce(makeStatusRich())
      .mockResolvedValue(makeStatus());
    const client = makeClient({
      getStatus,
      commitPreview: vi.fn<GitClientSeam["commitPreview"]>(async () =>
        makeCommitPreview({ suggestedMessage: "chore: update staged changes\n\nBody." }),
      ),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);

    await user.click(await screen.findByRole("button", { name: "Use commit draft" }));
    expect(screen.getByLabelText("Summary")).toHaveValue("chore: update staged changes");
    expect(screen.getByLabelText("Description")).toHaveValue("Body.");
    await user.click(screen.getByRole("button", { name: "Unstage all" }));

    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Stage changes to prepare a commit draft.")).toBeInTheDocument();
    expect(screen.queryByTestId("git-commit-draft")).not.toBeInTheDocument();
    expect(screen.queryByText("Meets commit policy")).not.toBeInTheDocument();
  });

  it("commits the composed summary through the commit-execute route", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Summary"), "feat: wire commit composer");
    const button = screen.getByRole("button", { name: /^Commit/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() =>
      expect(client.commitPropose).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        message: "feat: wire commit composer",
      }),
    );
  });

  it("uses the empty diff area as the commit workspace until a file is selected", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    expect(screen.getByRole("region", { name: "Commit draft" })).toBeInTheDocument();
    expect(screen.queryByText("Select a change to view its diff.")).not.toBeInTheDocument();

    await user.click(screen.getByText("index.ts"));

    expect(screen.getByRole("region", { name: "Diff" })).toBeInTheDocument();
    await waitFor(() => expect(client.getStructuredDiff).toHaveBeenCalled());
  });

  it("prefers an available development branch as the pull-request base", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatus({ branch: "feat/audit" })),
      listBranches: vi.fn(async () =>
        makeBranchList({
          branches: [
            { name: "feat/audit", headRefHash: "aaa", current: true },
            { name: "dev", headRefHash: "bbb", current: false },
            { name: "main", headRefHash: "ccc", current: false },
          ],
        }),
      ),
      getSummary: vi.fn(async () =>
        makeSummary({
          branch: "feat/audit",
          upstream: { ref: "origin/feat/audit", remote: "origin", branch: "feat/audit" },
        }),
      ),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("No changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create pull request" }));

    expect(screen.getByLabelText("Base branch")).toHaveValue("dev");
  });

  it("uses another available integration branch instead of the current branch as PR base", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatus({ branch: "dev" })),
      listBranches: vi.fn(async () =>
        makeBranchList({
          branches: [
            { name: "dev", headRefHash: "aaa", current: true },
            { name: "main", headRefHash: "bbb", current: false },
          ],
        }),
      ),
      getSummary: vi.fn(async () =>
        makeSummary({
          branch: "dev",
          upstream: { ref: "origin/dev", remote: "origin", branch: "dev" },
        }),
      ),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("No changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create pull request" }));

    expect(screen.getByLabelText("Base branch")).toHaveValue("main");
    expect(screen.getByLabelText("Base branch")).not.toHaveValue("dev");
  });

  it("leaves the PR base empty when no distinct branch is known yet", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatus({ branch: "feat/audit" })),
      listBranches: vi.fn(async () => makeBranchList({ branches: [] })),
      getSummary: vi.fn(async () =>
        makeSummary({
          branch: "feat/audit",
          upstream: { ref: "origin/feat/audit", remote: "origin", branch: "feat/audit" },
        }),
      ),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("No changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create pull request" }));

    expect(screen.getByLabelText("Base branch")).toHaveValue("");
    expect(screen.getByLabelText("Head branch")).toHaveValue("feat/audit");
  });

  it("keeps the commit draft while moving between workspace and sidebar layouts", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      commitPreview: vi.fn<GitClientSeam["commitPreview"]>(async () =>
        makeCommitPreview({ suggestedMessage: "chore: update staged changes\n\nBody." }),
      ),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Use commit draft" }));
    expect(screen.getByLabelText("Description")).toHaveValue("Body.");
    await user.click(screen.getByText("README.md"));

    expect(screen.getByLabelText("Summary")).toHaveValue("chore: update staged changes");
    expect(screen.getByLabelText("Description")).toHaveValue("Body.");
  });

  it("lets the user resize the changes column from the keyboard", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    const separator = screen.getByRole("slider", { name: "Resize changes column" });

    expect(separator).toHaveValue("330");
    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(separator).toHaveValue("354");
  });

  it("supports the complete keyboard resize range", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    const separator = screen.getByRole("slider", { name: "Resize changes column" });

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveValue("306");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveValue("280");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveValue("620");
    fireEvent.keyDown(separator, { key: "Escape" });
    expect(separator).toHaveValue("620");
    fireEvent.change(separator, { target: { value: "410" } });
    expect(separator).toHaveValue("410");
  });

  it("resizes the changes column with pointer movement and stops after release", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    const { container } = render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    const separator = screen.getByRole("slider", { name: "Resize changes column" });
    const body = separator.parentElement;
    if (body === null) throw new Error("Git body was not rendered");
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue({
      bottom: 700,
      height: 600,
      left: 100,
      right: 1100,
      top: 100,
      width: 1000,
      x: 100,
      y: 100,
      toJSON: vi.fn(),
    });

    fireEvent.pointerDown(separator, { clientX: 430 });
    fireEvent.pointerMove(window, { clientX: 500 });
    expect(separator).toHaveValue("400");
    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, { clientX: 650 });

    expect(separator).toHaveValue("400");
    expect(container).toContainElement(separator);
  });

  it("joins summary and description into a conventional message body", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatusRich()) });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Summary"), "feat: subject");
    await user.type(screen.getByLabelText("Description"), "Body line.");
    const button = screen.getByRole("button", { name: /^Commit/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() =>
      expect(client.commitPropose).toHaveBeenCalledWith({
        projectId: REPO_A.path,
        message: "feat: subject\n\nBody line.",
      }),
    );
  });

  // F3 (epic #3384 final audit): before proposeCommit existed, commitChanges called
  // commitExecute directly with no mint step at all — an accepted run's commit could never
  // satisfy the epic's unconditional approval requirement and there was no code path that could
  // ever render "Approval required" for a mint denial (it would either succeed outright with no
  // approval, or throw a raw network error). Failing-before: this test could not even be written
  // against the pre-fix seam, since commitExecute carries no concept of a denied mint.
  it("shows the static Approval required label when the commit mint is denied (F3)", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      commitPropose: vi.fn<GitClientSeam["commitPropose"]>(async () => ({
        schemaVersion: "1",
        status: "approval-required",
        actionKind: "commit",
      })),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Summary"), "feat: needs approval");
    const button = screen.getByRole("button", { name: /^Commit/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    expect(await screen.findByTestId("git-commit-outcome-headline")).toHaveTextContent(
      "commit: Approval required",
    );
  });

  // F3: proves the existing single-flight guard (useGitActions' seqRef, via the disabled Commit
  // button while `commit.flow.busy`) is reused as-is rather than a second lock being introduced
  // for the mint-then-execute call — a second click while the first commitPropose call is still
  // in flight must not mint (or execute) a second time.
  it("does not call commitPropose a second time while the first mint/execute is in flight (F3)", async () => {
    let resolveCommit!: (v: {
      schemaVersion: "1";
      status: "succeeded";
      actionKind: string;
    }) => void;
    const pending = new Promise<{ schemaVersion: "1"; status: "succeeded"; actionKind: string }>(
      (res) => {
        resolveCommit = res;
      },
    );
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      commitPropose: vi.fn<GitClientSeam["commitPropose"]>(() => pending),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Summary"), "feat: single flight");
    const button = screen.getByRole("button", { name: /^Commit/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    // The button is disabled while busy, so a second click cannot dispatch a second call.
    fireEvent.click(button);
    expect(client.commitPropose).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCommit({ schemaVersion: "1", status: "succeeded", actionKind: "commit" });
    });
    expect(client.commitPropose).toHaveBeenCalledTimes(1);
  });

  it("refreshes status and clears the composer after a successful commit", async () => {
    const getStatus = vi.fn(async () => makeStatusRich());
    const client = makeClient({ getStatus });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    const callsBefore = getStatus.mock.calls.length;

    await user.type(screen.getByLabelText("Summary"), "feat: done");
    const button = screen.getByRole("button", { name: /^Commit/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => expect(screen.getByLabelText("Summary")).toHaveValue(""));
  });

  it("disables Commit when nothing is staged", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => makeStatus({ clean: true })) });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("No changes")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: /^Commit/ })).toBeDisabled();
  });

  it("does not execute a commit before a matching policy preview returns", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      commitPreview: vi.fn<GitClientSeam["commitPreview"]>(
        () => new Promise<GitDeliveryCommitPreviewResponse>(() => undefined),
      ),
    });
    const user = userEvent.setup();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Summary"), "feat: wait for preview");
    const button = screen.getByRole("button", { name: /^Commit/ });

    expect(button).toBeDisabled();
    await user.click(button);
    expect(client.commitPropose).not.toHaveBeenCalled();
  });

  it("opens the new branch dialog when the commit preview blocks the protected branch", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      getStatus: vi.fn(async () =>
        makeStatus({
          branch: "dev",
          clean: false,
          stagedCount: 1,
          changes: [change("src/index.ts", { indexStatus: "M", staged: true })],
        }),
      ),
      commitPreview: vi.fn<GitClientSeam["commitPreview"]>(async () =>
        makeCommitPreview({
          policyOutcome: "blocked",
          policyBlockReason: "protected-branch",
        }),
      ),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Summary"), "feat: x");
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent?.includes("Current branch is protected") === true,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create branch first" }));

    expect(screen.getByRole("dialog", { name: "New branch" })).toBeInTheDocument();
    expect(client.commitPropose).not.toHaveBeenCalled();
  });
});

describe("GitClientWindow — diff scope (Issue #1575)", () => {
  it("toggling to the Staged scope refetches the diff with scope: staged", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => makeStatusRich()),
      getStructuredDiff: vi.fn(async (input) => makeStructuredDiffResponse("", input.scope)),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("README.md")).toBeInTheDocument();

    // README.md is unstaged-only, so the pane opens in the Worktree scope.
    fireEvent.click(screen.getByText("README.md").closest("button")!);
    await waitFor(() =>
      expect(client.getStructuredDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "README.md",
        scope: "unstaged",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Staged" }));

    await waitFor(() =>
      expect(client.getStructuredDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "README.md",
        scope: "staged",
      }),
    );
  });

  it("normalizes the selected diff scope after staging changes the file state", async () => {
    const before = makeStatus({
      clean: false,
      stagedCount: 0,
      unstagedCount: 1,
      changes: [change("README.md", { worktreeStatus: "M", unstaged: true })],
    });
    const after = makeStatus({
      clean: false,
      stagedCount: 1,
      unstagedCount: 0,
      changes: [change("README.md", { indexStatus: "M", staged: true })],
    });
    const getStatus = vi
      .fn<GitClientSeam["getStatus"]>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const client = makeClient({
      getStatus,
      getStructuredDiff: vi.fn(async (input) => makeStructuredDiffResponse("", input.scope)),
    });
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    expect(await screen.findByText("README.md")).toBeInTheDocument();

    fireEvent.click(screen.getByText("README.md").closest("button")!);
    await waitFor(() =>
      expect(client.getStructuredDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "README.md",
        scope: "unstaged",
      }),
    );

    fireEvent.click(screen.getByLabelText("Stage README.md"));

    await waitFor(() =>
      expect(client.getStructuredDiff).toHaveBeenCalledWith({
        root: REPO_A.path,
        path: "README.md",
        scope: "staged",
      }),
    );
  });
});

// Issue #3400 (epic #3384) — the dialog itself is unit-tested in ConnectToChatDialog.test.tsx;
// this pins only that the toolbar's trigger regains focus once the dialog closes (WCAG 2.4.3),
// which needs the real GitClientWindow tree (ConnectToChatDialog.test.tsx renders the dialog
// standalone, with no trigger to return focus to).
describe("GitClientWindow — Connect to Chat", () => {
  it("closes on Escape and returns focus to the toolbar trigger", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<GitClientWindow projectId={REPO_A.path} client={client} />);
    await waitFor(() => expect(client.listBranches).toHaveBeenCalled());
    const trigger = screen.getByRole("button", { name: "Connect to Chat" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
