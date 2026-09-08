import { describe, expect, it, vi } from "vitest";
import {
  type LiveModelQualificationClient,
  prepareBoundIssueForRun,
  prepareTrustedIssueWorkspace,
  qualifyLiveModel,
  readObservedRunWhileAwaitingDraft,
  readObservedRunWhileAwaitingSuccess,
  reconcileLiveWorkbenchAfterModelChange,
  registerTrustedRepositoryProject,
} from "./coding-issue-journey-live.js";
import type { ObservedRun } from "./coding-issue-journey-live-observed.js";

const DIAGNOSIS = "Running. Revision 1.";
const diagnose = (): Promise<string> => Promise.resolve(DIAGNOSIS);

/** One reading of the Code task, as the observation layer reports it. */
function observedRun(state: string, override: Partial<ObservedRun> = {}): ObservedRun {
  return {
    state,
    delivery: undefined,
    description: undefined,
    ciReadiness: undefined,
    commitReceipt: undefined,
    ...override,
  };
}

function deliveredDraft(phase = "draft-created", number = 1): ObservedRun["delivery"] {
  return {
    phase,
    reason: "completed",
    repository: "owner/repository",
    issueNumber: 1,
    headRef: "keiko/task",
    headSha: "4".repeat(40),
    baseRef: "master",
    baseSha: "3".repeat(40),
    proposalId: "pull-request-1",
    pullRequest: {
      number,
      url: `https://example.test/pull/${String(number)}`,
      headSha: "4".repeat(40),
      baseSha: "3".repeat(40),
    },
  };
}

describe("live journey draft wait", () => {
  it.each(["taken-over", "failed", "cancelled", "recovery-required", "succeeded"] as const)(
    "stops after one read when the live run reaches %s without a draft",
    async (state) => {
      const read = vi.fn(() => Promise.resolve(observedRun(state)));

      await expect(readObservedRunWhileAwaitingDraft(read, diagnose)).rejects.toThrow(
        `the coding run reached ${state} before creating a draft pull request -- ${DIAGNOSIS}`,
      );
      expect(read).toHaveBeenCalledOnce();
    },
  );

  it("retains a created draft when the runtime becomes terminal later", async () => {
    const observed = observedRun("failed", { delivery: deliveredDraft() });

    await expect(
      readObservedRunWhileAwaitingDraft(() => Promise.resolve(observed), diagnose),
    ).resolves.toBe(observed);
  });
});

describe("live journey terminal-success wait", () => {
  it.each(["running", "paused", "succeeded"] as const)(
    "keeps the exact run available while it is %s",
    async (state) => {
      const observed = observedRun(state, { delivery: deliveredDraft() });
      await expect(
        readObservedRunWhileAwaitingSuccess(() => Promise.resolve(observed), 1, diagnose),
      ).resolves.toBe(observed);
    },
  );

  it.each(["taken-over", "failed", "cancelled", "recovery-required"] as const)(
    "fails promptly when the exact run reaches %s",
    async (state) => {
      const read = vi.fn(() => Promise.resolve(observedRun(state, { delivery: deliveredDraft() })));
      await expect(readObservedRunWhileAwaitingSuccess(read, 1, diagnose)).rejects.toThrow(
        `the coding run reached ${state} -- ${DIAGNOSIS}`,
      );
      expect(read).toHaveBeenCalledOnce();
    },
  );

  // #3390: this pin used to compare a run id no window displays ("rejects a different run instead
  // of accepting its success"). Its invariant -- never accept another attempt's success as this
  // one's -- is unchanged, held against the fact the interface DOES show: the delivery card must
  // still name the pull request this flow delivered.
  it("rejects a success the Code task no longer shows this pull request for", async () => {
    await expect(
      readObservedRunWhileAwaitingSuccess(
        () =>
          Promise.resolve(
            observedRun("succeeded", { delivery: deliveredDraft("draft-created", 2) }),
          ),
        1,
        diagnose,
      ),
    ).rejects.toThrow("stopped showing pull request #1");
  });

  it("rejects a success the Code task shows no delivery for at all", async () => {
    await expect(
      readObservedRunWhileAwaitingSuccess(
        () => Promise.resolve(observedRun("succeeded")),
        1,
        diagnose,
      ),
    ).rejects.toThrow("stopped showing pull request #1");
  });
});

// #3390: the qualification no longer reads `/api/models` and re-derives `isCodingWorkbenchModel`
// from its fields. It asks the Code task whether the configured model can power a run -- the
// verdict the Start control itself gates on, and the only one covering the parts of that rule the
// Models tab never displays -- and applies the two remedies an operator has, in an operator's
// order. Every invariant the route-reading version pinned is pinned here on that shape.
function client(
  overrides: Partial<LiveModelQualificationClient> = {},
): LiveModelQualificationClient {
  return {
    usableModelSource: vi.fn(() => Promise.resolve(false)),
    displayedChatModelIds: vi.fn(() => Promise.resolve(["qualified-chat"])),
    refreshToolCalling: vi.fn<(modelId: string) => Promise<void>>(),
    enableWorkflow: vi.fn<(modelId: string) => Promise<void>>(),
    ...overrides,
  };
}

/** Answers `false` for the first `unusableReads` questions, then `true`. */
function sourceUsableAfter(unusableReads: number): () => Promise<boolean> {
  let asked = 0;
  return () => Promise.resolve(++asked > unusableReads);
}

describe("live journey model qualification", () => {
  it("proves tool calling first when the Code task reports no usable model source", async () => {
    const deps = client({ usableModelSource: sourceUsableAfter(1) });

    await expect(qualifyLiveModel(deps)).resolves.toBe(true);

    expect(deps.refreshToolCalling).toHaveBeenCalledExactlyOnceWith("qualified-chat");
    expect(deps.enableWorkflow).not.toHaveBeenCalled();
  });

  it("does not probe a model the Code task already accepts", async () => {
    const deps = client({ usableModelSource: vi.fn(() => Promise.resolve(true)) });

    await expect(qualifyLiveModel(deps)).resolves.toBe(false);

    expect(deps.refreshToolCalling).not.toHaveBeenCalled();
    expect(deps.enableWorkflow).not.toHaveBeenCalled();
    expect(deps.displayedChatModelIds).not.toHaveBeenCalled();
  });

  it("falls through to gateway setup when the proof alone does not make the source usable", async () => {
    const deps = client({ usableModelSource: sourceUsableAfter(2) });

    await expect(qualifyLiveModel(deps)).resolves.toBe(true);

    expect(deps.refreshToolCalling).toHaveBeenCalledExactlyOnceWith("qualified-chat");
    expect(deps.enableWorkflow).toHaveBeenCalledExactlyOnceWith("qualified-chat");
  });

  it("fails closed when neither remedy makes the source usable", async () => {
    const deps = client();

    await expect(qualifyLiveModel(deps)).rejects.toThrow(
      "publish the selected model as coding-workbench capable",
    );

    expect(deps.enableWorkflow).toHaveBeenCalledExactlyOnceWith("qualified-chat");
  });

  it("fails before a paid probe when the configured chat model is ambiguous", async () => {
    const deps = client({
      displayedChatModelIds: vi.fn(() => Promise.resolve(["qualified-chat", "other-chat"])),
    });

    await expect(qualifyLiveModel(deps)).rejects.toThrow("one unambiguous chat model");

    expect(deps.refreshToolCalling).not.toHaveBeenCalled();
    expect(deps.enableWorkflow).not.toHaveBeenCalled();
  });

  it("fails before a paid probe when no chat model is configured at all", async () => {
    const deps = client({ displayedChatModelIds: vi.fn(() => Promise.resolve([])) });

    await expect(qualifyLiveModel(deps)).rejects.toThrow("at least one chat model");

    expect(deps.refreshToolCalling).not.toHaveBeenCalled();
  });

  it("does not enable workflow eligibility after a failed readiness refresh", async () => {
    const failure = new Error("readiness failed");
    const deps = client({ refreshToolCalling: vi.fn(() => Promise.reject(failure)) });

    await expect(qualifyLiveModel(deps)).rejects.toBe(failure);

    expect(deps.enableWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a qualification that ends on a different model identity", async () => {
    const displayedChatModelIds = vi
      .fn<() => Promise<readonly string[]>>()
      .mockResolvedValueOnce(["qualified-chat"])
      .mockResolvedValue(["replacement"]);
    const deps = client({ usableModelSource: sourceUsableAfter(1), displayedChatModelIds });

    await expect(qualifyLiveModel(deps)).rejects.toThrow(
      "qualification must preserve the selected model identity",
    );
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
      taskControlName: "Task workspaces: issue-1",
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
      taskControlName: "Task workspaces: no active workspace",
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
  // #3394/#3390 -- the GitHub access grant is no longer a step of this sequence: it now happens
  // inside `bindIssue`, driven through the Workbench's own control on the access refusal
  // (CodingWorkbenchIssueIntake.tsx's `GitHubIssueAccessGrant`). The invariant the previous
  // four-step order pinned -- never ask the server to authorize a repository it has not registered
  // (githubAuthorizationRoutes.ts's `registeredRepositoryRoot`, which checks
  // `deps.store.listProjects()`) -- is STRENGTHENED by that move rather than dropped: the grant is
  // reachable only from a window already bound to the registered repository path, so no caller can
  // re-order the two any more. This pins the surviving order, and that the grant is inside the
  // issue binding rather than ahead of registration.
  it("registers trust before the issue binding that grants access and provisions the worktree", async () => {
    const order: string[] = [];

    await prepareTrustedIssueWorkspace({
      open: (): Promise<void> => {
        order.push("opened");
        return Promise.resolve();
      },
      registerProject: (): Promise<void> => {
        order.push("project-registered");
        return Promise.resolve();
      },
      bindIssue: (): Promise<void> => {
        order.push("issue-bound-with-access-granted");
        return Promise.resolve();
      },
    });

    expect(order).toEqual(["opened", "project-registered", "issue-bound-with-access-granted"]);
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
