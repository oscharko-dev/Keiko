import type {
  CodingWorkbenchRuntimeSnapshot,
  ModelCapability,
} from "@oscharko-dev/keiko-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  prepareBoundIssueForRun,
  prepareTrustedIssueWorkspace,
  qualifyLiveModel,
  readSnapshotWhileAwaitingDraft,
  reconcileLiveWorkbenchAfterModelChange,
  registerTrustedRepositoryProject,
} from "./coding-issue-journey-live.js";

function runtimeSnapshot(
  state: CodingWorkbenchRuntimeSnapshot["state"],
  override: Partial<CodingWorkbenchRuntimeSnapshot> = {},
): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state,
    revision: 1,
    updatedAt: "2026-09-06T16:51:00.000Z",
    runId: "run-terminal",
    ...override,
  };
}

describe("live journey draft wait", () => {
  it.each(["taken-over", "failed", "cancelled", "recovery-required", "succeeded"] as const)(
    "stops after one read when the live run reaches %s without a draft",
    async (state) => {
      const read = vi.fn(() => Promise.resolve(runtimeSnapshot(state)));

      await expect(readSnapshotWhileAwaitingDraft(read)).rejects.toThrow(
        `coding run run-terminal reached ${state} before creating a draft pull request`,
      );
      expect(read).toHaveBeenCalledOnce();
    },
  );

  it("retains a created draft when the runtime becomes terminal later", async () => {
    const snapshot = runtimeSnapshot("failed", {
      failureCode: "runtime-failed",
      draftDelivery: {
        schemaVersion: "1",
        revision: 1,
        phase: "draft-created",
        reason: "completed",
        proposalId: "pull-request-1",
        proposalDigest: "b".repeat(64),
        recordedAt: "2026-09-06T16:51:00.000Z",
        binding: {
          runId: "run-terminal",
          workspaceDigest: "c".repeat(64),
          runtimeAuthorityDigest: "d".repeat(64),
          envelopeDigest: "e".repeat(64),
          remoteDigest: "f".repeat(64),
          issueBindingDigest: "1".repeat(64),
          issueIdDigest: "2".repeat(64),
          issueNumber: 1,
          repository: "owner/repository",
          remoteAlias: "origin",
          baseRef: "master",
          baseSha: "3".repeat(40),
          headRef: "keiko/task",
          headSha: "4".repeat(40),
          verifiedCommitProposalId: "commit-1",
          recoveryId: "delivery-1",
        },
        pullRequest: {
          number: 1,
          externalId: "PR_1",
          url: "https://example.test/pull/1",
          repository: "owner/repository",
          headRepository: "owner/repository",
          headRef: "keiko/task",
          headSha: "4".repeat(40),
          baseRef: "master",
          baseSha: "3".repeat(40),
          state: "open",
          isDraft: true,
        },
      },
    });

    await expect(readSnapshotWhileAwaitingDraft(() => Promise.resolve(snapshot))).resolves.toBe(
      snapshot,
    );
  });
});

function chatModel(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "qualified-chat",
    kind: "chat",
    contextWindow: 1_050_000,
    maxOutputTokens: 8_192,
    toolCalling: false,
    toolCallingVerification: {
      status: "verified",
      checkedAt: new Date().toISOString(),
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: "qualification-profile",
    },
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "high",
    latencyClass: "slow",
    throughputHint: "qualification",
    preferredUseCases: ["coding"],
    knownLimitations: [],
    ...overrides,
  };
}

describe("live journey model qualification", () => {
  it("refreshes an expired tool-calling proof before rejecting the configured model", async () => {
    const loadModels = vi
      .fn<() => Promise<readonly ModelCapability[]>>()
      .mockResolvedValueOnce([chatModel()])
      .mockResolvedValueOnce([chatModel({ toolCalling: true })]);
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).resolves.toBe(true);

    expect(refreshToolCalling).toHaveBeenCalledExactlyOnceWith("qualified-chat");
    expect(loadModels).toHaveBeenCalledTimes(2);
    expect(enableWorkflow).not.toHaveBeenCalled();
  });

  it("does not probe a current workflow-eligible tool-calling model", async () => {
    const loadModels = vi.fn(() => Promise.resolve([chatModel({ toolCalling: true })]));
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).resolves.toBe(false);

    expect(refreshToolCalling).not.toHaveBeenCalled();
    expect(enableWorkflow).not.toHaveBeenCalled();
  });

  it("uses supported setup when an otherwise eligible chat model lacks the coding use case", async () => {
    const loadModels = vi
      .fn<() => Promise<readonly ModelCapability[]>>()
      .mockResolvedValueOnce([chatModel({ toolCalling: true, preferredUseCases: ["Chat"] })])
      .mockResolvedValueOnce([
        chatModel({ toolCalling: true, preferredUseCases: ["Chat", "Coding"] }),
      ]);
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).resolves.toBe(true);

    expect(refreshToolCalling).not.toHaveBeenCalled();
    expect(enableWorkflow).toHaveBeenCalledExactlyOnceWith("qualified-chat");
    expect(loadModels).toHaveBeenCalledTimes(2);
  });

  it("fails closed when setup does not publish a coding-workbench model", async () => {
    const loadModels = vi.fn(() =>
      Promise.resolve([chatModel({ toolCalling: true, preferredUseCases: ["Chat"] })]),
    );
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).rejects.toThrow("publish the selected model as coding-workbench capable");

    expect(refreshToolCalling).not.toHaveBeenCalled();
    expect(enableWorkflow).toHaveBeenCalledExactlyOnceWith("qualified-chat");
    expect(loadModels).toHaveBeenCalledTimes(2);
  });

  it("fails before a paid probe when the configured chat model is ambiguous", async () => {
    const loadModels = vi.fn(() => Promise.resolve([chatModel(), chatModel({ id: "other-chat" })]));
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).rejects.toThrow("one unambiguous chat model");

    expect(refreshToolCalling).not.toHaveBeenCalled();
    expect(enableWorkflow).not.toHaveBeenCalled();
  });

  it("does not enable workflow eligibility after a failed readiness refresh", async () => {
    const failure = new Error("readiness failed");
    const loadModels = vi.fn(() => Promise.resolve([chatModel()]));
    const refreshToolCalling = vi.fn(() => Promise.reject(failure));
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow })).rejects.toBe(
      failure,
    );

    expect(loadModels).toHaveBeenCalledExactlyOnceWith();
    expect(enableWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a different model identity published after readiness", async () => {
    const loadModels = vi
      .fn<() => Promise<readonly ModelCapability[]>>()
      .mockResolvedValueOnce([chatModel()])
      .mockResolvedValueOnce([chatModel({ id: "replacement", toolCalling: true })]);
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).rejects.toThrow("refresh the selected model");

    expect(enableWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a readiness response that does not publish tool-calling support", async () => {
    const loadModels = vi
      .fn<() => Promise<readonly ModelCapability[]>>()
      .mockResolvedValue([chatModel()]);
    const refreshToolCalling = vi.fn<(modelId: string) => Promise<void>>();
    const enableWorkflow = vi.fn<(modelId: string) => Promise<void>>();

    await expect(
      qualifyLiveModel({ loadModels, refreshToolCalling, enableWorkflow }),
    ).rejects.toThrow("publish the refreshed tool-calling proof");

    expect(enableWorkflow).not.toHaveBeenCalled();
  });
});

describe("live journey model-change reload", () => {
  it("re-accepts the exact issue after a qualification reload before the run can start", async () => {
    const order: string[] = [];
    await prepareBoundIssueForRun({
      previewAndBind: (): Promise<void> => {
        order.push("bound");
        return Promise.resolve();
      },
      qualifyModel: (): Promise<boolean> => {
        order.push("qualified-and-reloaded");
        return Promise.resolve(true);
      },
      previewAndAccept: (): Promise<void> => {
        order.push("issue-reaccepted");
        return Promise.resolve();
      },
    });
    expect(order).toEqual(["bound", "qualified-and-reloaded", "issue-reaccepted"]);
  });

  it("keeps the accepted issue when qualification does not reload the page", async () => {
    const previewAndAccept = vi.fn<() => Promise<void>>();
    await prepareBoundIssueForRun({
      previewAndBind: (): Promise<void> => Promise.resolve(),
      qualifyModel: (): Promise<boolean> => Promise.resolve(false),
      previewAndAccept,
    });
    expect(previewAndAccept).not.toHaveBeenCalled();
  });

  it("waits for the pre-reload task workspace identity after the workbench renders", async () => {
    const identity = {
      workspaceId: "ws-1",
      taskId: "issue-1",
      taskBranch: "keiko/issue-1",
      repositoryControlName: "Manage repository ws-1",
      branchControlName: "Manage branch keiko/issue-1",
    };
    let stage: "initial" | "reloaded" | "rendered" | "restored" = "initial";
    const reload = vi.fn(() => {
      expect(stage).toBe("initial");
      stage = "reloaded";
      return Promise.resolve();
    });
    const waitForWorkbench = vi.fn(() => {
      expect(stage).toBe("reloaded");
      stage = "rendered";
      return Promise.resolve();
    });
    const waitForWorkspaceIdentity = vi.fn((received) => {
      expect(stage).toBe("rendered");
      expect(received).toEqual(identity);
      stage = "restored";
      return Promise.resolve();
    });

    await reconcileLiveWorkbenchAfterModelChange(true, identity, {
      reload,
      waitForWorkbench,
      waitForWorkspaceIdentity,
    });

    expect(stage).toBe("restored");
    expect(reload).toHaveBeenCalledExactlyOnceWith();
    expect(waitForWorkbench).toHaveBeenCalledExactlyOnceWith();
    expect(waitForWorkspaceIdentity).toHaveBeenCalledExactlyOnceWith(identity);
  });

  it("does not reload when the model profile was already qualified", async () => {
    const identity = {
      workspaceId: null,
      taskId: null,
      taskBranch: null,
      repositoryControlName: "Manage repository fixture",
      branchControlName: "Manage branch master",
    };
    const reload = vi.fn<() => Promise<void>>();
    const waitForWorkbench = vi.fn<() => Promise<void>>();
    const waitForWorkspaceIdentity = vi.fn<() => Promise<void>>();

    await reconcileLiveWorkbenchAfterModelChange(false, identity, {
      reload,
      waitForWorkbench,
      waitForWorkspaceIdentity,
    });

    expect(reload).not.toHaveBeenCalled();
    expect(waitForWorkbench).not.toHaveBeenCalled();
    expect(waitForWorkspaceIdentity).not.toHaveBeenCalled();
  });
});

describe("live journey repository trust", () => {
  it("registers trust before the issue provisions its managed worktree", async () => {
    const order: string[] = [];

    await prepareTrustedIssueWorkspace({
      open: (): Promise<void> => {
        order.push("opened");
        return Promise.resolve();
      },
      grantGithub: (): Promise<void> => {
        order.push("github-authorized");
        return Promise.resolve();
      },
      registerProject: (): Promise<void> => {
        order.push("project-registered");
        return Promise.resolve();
      },
      bindIssue: (): Promise<void> => {
        order.push("issue-bound");
        return Promise.resolve();
      },
    });

    expect(order).toEqual(["opened", "github-authorized", "project-registered", "issue-bound"]);
  });

  it("registers the accepted repository as a trusted project before provisioning", async () => {
    const register = vi.fn(() => Promise.resolve({ status: 201 }));

    await registerTrustedRepositoryProject({ register }, "/controlled/repository");

    expect(register).toHaveBeenCalledExactlyOnceWith("/controlled/repository");
  });

  it("fails closed when project registration keeps repository scripts restricted", async () => {
    const register = vi.fn(() => Promise.resolve({ status: 201, warning: "restricted" }));

    await expect(
      registerTrustedRepositoryProject({ register }, "/controlled/repository"),
    ).rejects.toThrow("must inherit package-script trust");
  });

  it("reports only the rejected HTTP status when registration fails", async () => {
    const register = vi.fn(() => Promise.resolve({ status: 409 }));

    await expect(
      registerTrustedRepositoryProject({ register }, "/controlled/repository"),
    ).rejects.toThrow("failed with HTTP 409");
  });
});
