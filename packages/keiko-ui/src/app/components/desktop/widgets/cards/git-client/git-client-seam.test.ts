// Unit tests for the git-client-seam (Issue #1574, Epic #1571).
// Verifies that DEFAULT_GIT_CLIENT wires each method to the correct lib/api function,
// that the label maps are complete and correct, that formatGitError handles all branches,
// and that useGitActions (seqRef stale-guard) behaves correctly under concurrent calls.
//
// These tests carry forward the assertions that were previously in GovernedGitFlowCard.test.tsx
// covering DI client wiring, hook stale-guard, and label helpers.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  cloneRepository as fetchCloneRepository,
  createProject,
  fetchGitBranches,
  fetchGitDeliverySyncExecute,
  fetchGitDeliverySyncPreview,
  fetchGitDeliveryCommitExecute,
  fetchGitDeliveryCommitPreview,
  fetchGitDeliveryLocalBranchCreate,
  fetchGitDeliveryLocalBranchSwitch,
  fetchGitDeliveryPushExecute,
  fetchGitDeliveryPushPreview,
  fetchGitDeliveryStage,
  fetchGitDeliveryUnstage,
  fetchGitDiff,
  fetchGitHistory,
  fetchGitRemotes,
  fetchGitSummary,
  fetchGitStatus,
  fetchProjects,
} from "@/lib/api";
import type { GitDeliveryCommitPreviewResponse } from "@/lib/api";
import {
  DEFAULT_GIT_CLIENT,
  STATUS_LABEL,
  formatGitError,
  useGitActions,
  violationLabel,
  warningLabel,
} from "./git-client-seam";
import type { GitClientSeam } from "./git-client-seam";

// ─── DEFAULT_GIT_CLIENT wiring ────────────────────────────────────────────────

describe("DEFAULT_GIT_CLIENT — wires correct api functions", () => {
  it("listRepositories is fetchProjects", () => {
    expect(DEFAULT_GIT_CLIENT.listRepositories).toBe(fetchProjects);
  });

  it("registerRepository is createProject", () => {
    expect(DEFAULT_GIT_CLIENT.registerRepository).toBe(createProject);
  });

  it("cloneRepository is cloneRepository (fetchCloneRepository)", () => {
    expect(DEFAULT_GIT_CLIENT.cloneRepository).toBe(fetchCloneRepository);
  });

  it("listBranches is fetchGitBranches", () => {
    expect(DEFAULT_GIT_CLIENT.listBranches).toBe(fetchGitBranches);
  });

  it("getStatus is fetchGitStatus", () => {
    expect(DEFAULT_GIT_CLIENT.getStatus).toBe(fetchGitStatus);
  });

  it("getSummary is fetchGitSummary", () => {
    expect(DEFAULT_GIT_CLIENT.getSummary).toBe(fetchGitSummary);
  });

  it("getHistory is fetchGitHistory", () => {
    expect(DEFAULT_GIT_CLIENT.getHistory).toBe(fetchGitHistory);
  });

  it("getRemotes is fetchGitRemotes", () => {
    expect(DEFAULT_GIT_CLIENT.getRemotes).toBe(fetchGitRemotes);
  });

  it("getDiff is fetchGitDiff", () => {
    expect(DEFAULT_GIT_CLIENT.getDiff).toBe(fetchGitDiff);
  });

  it("branchCreate is fetchGitDeliveryLocalBranchCreate", () => {
    expect(DEFAULT_GIT_CLIENT.branchCreate).toBe(fetchGitDeliveryLocalBranchCreate);
  });

  it("branchSwitch is fetchGitDeliveryLocalBranchSwitch", () => {
    expect(DEFAULT_GIT_CLIENT.branchSwitch).toBe(fetchGitDeliveryLocalBranchSwitch);
  });

  it("stage is fetchGitDeliveryStage", () => {
    expect(DEFAULT_GIT_CLIENT.stage).toBe(fetchGitDeliveryStage);
  });

  it("unstage is fetchGitDeliveryUnstage", () => {
    expect(DEFAULT_GIT_CLIENT.unstage).toBe(fetchGitDeliveryUnstage);
  });

  it("commitPreview is fetchGitDeliveryCommitPreview", () => {
    expect(DEFAULT_GIT_CLIENT.commitPreview).toBe(fetchGitDeliveryCommitPreview);
  });

  it("commitExecute is fetchGitDeliveryCommitExecute", () => {
    expect(DEFAULT_GIT_CLIENT.commitExecute).toBe(fetchGitDeliveryCommitExecute);
  });

  it("syncPreview is fetchGitDeliverySyncPreview", () => {
    expect(DEFAULT_GIT_CLIENT.syncPreview).toBe(fetchGitDeliverySyncPreview);
  });

  it("syncExecute is fetchGitDeliverySyncExecute", () => {
    expect(DEFAULT_GIT_CLIENT.syncExecute).toBe(fetchGitDeliverySyncExecute);
  });

  it("pushPreview is fetchGitDeliveryPushPreview", () => {
    expect(DEFAULT_GIT_CLIENT.pushPreview).toBe(fetchGitDeliveryPushPreview);
  });

  it("pushExecute is fetchGitDeliveryPushExecute", () => {
    expect(DEFAULT_GIT_CLIENT.pushExecute).toBe(fetchGitDeliveryPushExecute);
  });
});

// ─── Label maps ───────────────────────────────────────────────────────────────

describe("warningLabel", () => {
  it("maps mixed-scope", () => {
    expect(warningLabel("mixed-scope")).toContain("Mixed scope");
  });

  it("maps wip-marker", () => {
    expect(warningLabel("wip-marker")).toContain("Work-in-progress");
  });

  it("maps large-change", () => {
    expect(warningLabel("large-change")).toContain("Large change");
  });

  it("maps empty-body", () => {
    expect(warningLabel("empty-body")).toBeTruthy();
  });

  it("maps non-conventional-subject", () => {
    expect(warningLabel("non-conventional-subject")).toBeTruthy();
  });
});

describe("violationLabel", () => {
  it("maps empty-subject", () => {
    expect(violationLabel("empty-subject")).toContain("empty");
  });

  it("maps missing-conventional-prefix", () => {
    expect(violationLabel("missing-conventional-prefix")).toContain("conventional");
  });

  it("maps disallowed-type", () => {
    expect(violationLabel("disallowed-type")).toBeTruthy();
  });

  it("maps subject-too-long", () => {
    expect(violationLabel("subject-too-long")).toContain("too long");
  });

  it("maps missing-issue-key", () => {
    expect(violationLabel("missing-issue-key")).toBeTruthy();
  });

  it("maps missing-signoff", () => {
    expect(violationLabel("missing-signoff")).toContain("Signed-off-by");
  });
});

describe("STATUS_LABEL", () => {
  it("covers all five mutation statuses", () => {
    expect(STATUS_LABEL["succeeded"]).toBeTruthy();
    expect(STATUS_LABEL["blocked"]).toBeTruthy();
    expect(STATUS_LABEL["approval-required"]).toBeTruthy();
    expect(STATUS_LABEL["failed"]).toBeTruthy();
    expect(STATUS_LABEL["recovery-required"]).toBeTruthy();
  });

  it("succeeded maps to a readable word", () => {
    expect(STATUS_LABEL["succeeded"]).toBe("Succeeded");
  });

  it("blocked maps to a readable word", () => {
    expect(STATUS_LABEL["blocked"]).toBe("Blocked");
  });
});

// ─── formatGitError ───────────────────────────────────────────────────────────

describe("formatGitError", () => {
  it("extracts message and code from ApiError", () => {
    const err = new ApiError("UNAUTHORIZED", "Not authorised", 401);
    expect(formatGitError(err)).toBe("Not authorised (UNAUTHORIZED)");
  });

  it("extracts message from a plain Error", () => {
    expect(formatGitError(new Error("timeout"))).toBe("timeout");
  });

  it("falls back for unknown thrown value (string)", () => {
    expect(formatGitError("something strange")).toBe("An unexpected error occurred.");
  });

  it("falls back for null", () => {
    expect(formatGitError(null)).toBe("An unexpected error occurred.");
  });

  it("falls back for undefined", () => {
    expect(formatGitError(undefined)).toBe("An unexpected error occurred.");
  });

  it("falls back for a plain object (not an Error)", () => {
    expect(formatGitError({ code: 500 })).toBe("An unexpected error occurred.");
  });
});

// ─── useGitActions — seqRef stale-guard ───────────────────────────────────────

describe("useGitActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeSeamClient(overrides: Partial<GitClientSeam> = {}): GitClientSeam {
    return {
      listRepositories: vi.fn(async () => ({ projects: [] })),
      registerRepository: vi.fn(async () => ({
        project: {
          path: "/r",
          name: "r",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 0,
          available: true,
        },
      })),
      cloneRepository: vi.fn(async () => ({
        project: {
          path: "/r",
          name: "r",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 0,
          available: true,
        },
      })),
      listBranches: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: "/r",
        available: true,
        state: "available" as const,
        branches: [],
        truncated: false,
      })),
      getStatus: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: "/r",
        state: "available" as const,
        available: true,
        detached: false,
        clean: true,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        changes: [],
        truncated: false,
        maxChanges: 50,
      })),
      getSummary: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: "/r",
        state: "available" as const,
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
      })),
      getHistory: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: "/r",
        state: "available" as const,
        available: true,
        entries: [],
        limit: 50,
        skip: 0,
        truncated: false,
      })),
      getRemotes: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: "/r",
        state: "available" as const,
        available: true,
        remotes: [],
        truncated: false,
      })),
      getDiff: vi.fn(async () => ({
        schemaVersion: "1" as const,
        root: "/r",
        state: "available" as const,
        available: true,
        scope: "all" as const,
        diff: "",
        truncated: false,
        maxBytes: 131072,
      })),
      // Carry-forward mutation stubs — not exercised here; typed against the real seam
      // method signatures so the fixtures stay sound without `any`.
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
      // commitPreview/pushPreview are not driven by these tests (runPreview is never called);
      // a bare typed mock satisfies the seam type without fabricating a full preview envelope.
      commitPreview: vi.fn<GitClientSeam["commitPreview"]>(),
      commitExecute: vi.fn<GitClientSeam["commitExecute"]>(async () => ({
        schemaVersion: "1",
        status: "succeeded",
        actionKind: "commit",
      })),
      syncPreview: vi.fn<GitClientSeam["syncPreview"]>(),
      syncExecute: vi.fn<GitClientSeam["syncExecute"]>(),
      pushPreview: vi.fn<GitClientSeam["pushPreview"]>(),
      pushExecute: vi.fn<GitClientSeam["pushExecute"]>(async () => ({
        schemaVersion: "1",
        status: "succeeded",
        actionKind: "push",
      })),
      ...overrides,
    };
  }

  function makePreview(
    stagedFileCount: number,
    overrides: Partial<GitDeliveryCommitPreviewResponse> = {},
  ): GitDeliveryCommitPreviewResponse {
    return {
      schemaVersion: "1",
      summary: { stagedFileCount, areaCount: 1, areas: ["src"], touchesTests: false },
      intent: { warnings: [], mixedScope: false, isWip: false },
      messageValidation: { ok: true },
      preflightFindingCodes: [],
      policyOutcome: "allowed",
      ...overrides,
    };
  }

  it("initial flow state is not busy, no outcome, no error", () => {
    const client = makeSeamClient();
    const { result } = renderHook(() => useGitActions(client, "/repo"));
    expect(result.current.flow.busy).toBe(false);
    expect(result.current.flow.outcome).toBeNull();
    expect(result.current.flow.error).toBeNull();
  });

  it("runMutation sets busy=true then resolves outcome on success", async () => {
    const client = makeSeamClient();
    const { result } = renderHook(() => useGitActions(client, "/repo"));

    const successOutcome = {
      schemaVersion: "1" as const,
      status: "succeeded" as const,
      actionKind: "commit",
    };

    act(() => {
      result.current.runMutation(async () => successOutcome);
    });

    expect(result.current.flow.busy).toBe(true);

    await waitFor(() => expect(result.current.flow.busy).toBe(false));
    expect(result.current.flow.outcome).toStrictEqual(successOutcome);
    expect(result.current.flow.error).toBeNull();
  });

  it("runMutation sets busy=false and populates error when the op rejects", async () => {
    const client = makeSeamClient();
    const { result } = renderHook(() => useGitActions(client, "/repo"));

    act(() => {
      result.current.runMutation(async () => {
        throw new Error("commit failed");
      });
    });

    await waitFor(() => expect(result.current.flow.busy).toBe(false));
    expect(result.current.flow.error).toBe("commit failed");
    expect(result.current.flow.outcome).toBeNull();
  });

  it("stale-guard: superseded mutation result is discarded (only latest wins)", async () => {
    const client = makeSeamClient();
    const { result } = renderHook(() => useGitActions(client, "/repo"));

    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((res) => {
      resolveFirst = res;
    });

    const firstOutcome = {
      schemaVersion: "1" as const,
      status: "succeeded" as const,
      actionKind: "first",
    };
    const secondOutcome = {
      schemaVersion: "1" as const,
      status: "succeeded" as const,
      actionKind: "second",
    };

    // Start first mutation — it waits
    act(() => {
      result.current.runMutation(async () => {
        await firstDone;
        return firstOutcome;
      });
    });

    // Immediately start second mutation (increments seqRef; first is now stale)
    act(() => {
      result.current.runMutation(async () => secondOutcome);
    });

    await waitFor(() => expect(result.current.flow.busy).toBe(false));

    // Resolve the first (stale) mutation — its outcome must be ignored
    act(() => resolveFirst());

    // Allow microtasks to drain
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20));
    });

    // The second outcome must win; the first stale outcome must NOT replace it
    expect(result.current.flow.outcome?.actionKind).toBe("second");
  });

  it("stale-guard: superseded preview result is discarded (only latest draft wins)", async () => {
    let resolveFirst!: (value: GitDeliveryCommitPreviewResponse) => void;
    const firstPreview = new Promise<GitDeliveryCommitPreviewResponse>((res) => {
      resolveFirst = res;
    });
    const client = makeSeamClient({
      commitPreview: vi
        .fn<GitClientSeam["commitPreview"]>()
        .mockImplementationOnce(() => firstPreview)
        .mockResolvedValueOnce(makePreview(2)),
    });
    const { result } = renderHook(() => useGitActions(client, "/repo"));

    act(() => result.current.runPreview("feat: old"));
    act(() => result.current.runPreview("feat: new"));

    await waitFor(() => expect(result.current.previewDraft).toBe("feat: new"));
    expect(result.current.preview?.summary.stagedFileCount).toBe(2);

    await act(async () => {
      resolveFirst(makePreview(1));
      await new Promise((res) => setTimeout(res, 20));
    });

    expect(result.current.previewDraft).toBe("feat: new");
    expect(result.current.preview?.summary.stagedFileCount).toBe(2);
  });

  it("reset invalidates an in-flight preview", async () => {
    let resolvePreview!: (value: GitDeliveryCommitPreviewResponse) => void;
    const pendingPreview = new Promise<GitDeliveryCommitPreviewResponse>((res) => {
      resolvePreview = res;
    });
    const client = makeSeamClient({
      commitPreview: vi.fn<GitClientSeam["commitPreview"]>(() => pendingPreview),
    });
    const { result } = renderHook(() => useGitActions(client, "/repo"));

    act(() => result.current.runPreview("feat: old"));
    act(() => result.current.reset());

    await act(async () => {
      resolvePreview(makePreview(1));
      await new Promise((res) => setTimeout(res, 20));
    });

    expect(result.current.preview).toBeNull();
    expect(result.current.previewDraft).toBeNull();
  });

  it("formatGitError is used when the op rejects with an ApiError", async () => {
    const client = makeSeamClient();
    const { result } = renderHook(() => useGitActions(client, "/repo"));

    act(() => {
      result.current.runMutation(async () => {
        throw new ApiError("FORBIDDEN", "Access denied", 403);
      });
    });

    await waitFor(() => expect(result.current.flow.error).toBe("Access denied (FORBIDDEN)"));
  });
});
