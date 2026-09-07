import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type { GitCiFactsResult } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import {
  createDraftRun,
  readySnapshot,
  AT,
  DIGEST,
} from "../gitDelivery/ciObservationTest/_support.js";
import { CHECK, failureFacts } from "../gitDelivery/ciObservationTest/_providerFacts.js";
import { codingWorkbenchRemoteDigest } from "../coding-context/githubIssueResolution.js";
import type { DraftDeliveryDependencies } from "../gitDelivery/draftDeliveryTypes.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import { createCodingRuntimeCiReadinessStore } from "./codingRuntimeCiReadinessStore.js";
import { createCodingRuntimeCiRepairBudgetStore } from "./codingRuntimeCiRepairBudgetStore.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";
import type {
  VerifiedCommitRuntimeBinding,
  VerifiedCommitRuntimeDependencies,
} from "./productionVerifiedCommitRuntime.js";
import {
  createProductionCiObservationService,
  publishCiObservation,
} from "./productionCiObservationRuntime.js";

describe("production CI readiness events", () => {
  it.each(["technical-ready", "pending", "failed", "blocked", "unknown"] as const)(
    "publishes the %s observation through the normal evidence validator",
    (state) => {
      const events: CodingWorkbenchRuntimeEvent[] = [];
      const snapshot = { ...readySnapshot(), state };
      publishCiObservation(snapshot, (event): void => {
        events.push(event);
      });
      expect(events).toHaveLength(1);
      expect(validateCodingWorkbenchRuntimeEvent(events[0]).ok).toBe(true);
      expect(events[0]).toMatchObject({
        runId: snapshot.runId,
        occurredAt: snapshot.observedAt,
        kind: "artifact-produced",
        artifactKind: "ci-readiness",
        artifactLabel: `ci-readiness-${state}`,
      });
      expect(JSON.stringify(events)).not.toContain(snapshot.repository);
    },
  );
});

// #3384 wave-3 W3-8 "needs": `createProductionCiObservationService` built its
// `CiObservationController` without ever forwarding a supplied `repairBudget`'s exhaustion into
// `repairBudgetExhausted` -- every production readiness snapshot read `?? false` unconditionally
// regardless of the run's real repair-ledger state.
describe("production CI observation service repair-budget wiring (#3384 wave-3 W3-8)", () => {
  const workspace: WorkspaceInfo = {
    root: "/managed/worktree",
    selectedRoot: "/managed/worktree",
    name: "fixture",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function binding(): VerifiedCommitRuntimeBinding {
    return {
      runId: "run-1",
      envelopeDigest: DIGEST,
      stillAuthorized: () => true,
      signal: new AbortController().signal,
      context: {
        runId: "run-1",
        operatorId: "operator-1",
        taskId: "task-1",
        projectId: "project-1",
        projectDigest: DIGEST,
        workspaceId: "workspace-1",
        workspaceRoot: workspace.root,
        branchRef: "feature/issue-1",
        branchHeadDigest: DIGEST,
        // Must match `resolveDraftRepository`'s cross-check: `context.repositoryDigest` and
        // `context.issueBinding.remoteDigest` both need to equal the real digest of the resolved
        // repository ("owner/repository", from `deps.resolveTarget` below), or the read fails
        // closed with "remote-drift" before the CI reader is ever consulted.
        repositoryIdentity: {
          kind: "local",
          digest: codingWorkbenchRemoteDigest("owner/repository"),
        },
        issueBinding: {
          schemaVersion: "1",
          repositoryId: "repository-1",
          remoteDigest: codingWorkbenchRemoteDigest("owner/repository"),
          issueNumber: 1,
          issueIdDigest: DIGEST,
          defaultBaseRef: "dev",
          contentRevisionDigest: DIGEST,
          bindingDigest: DIGEST,
        },
        branch: {
          baseRef: "dev",
          headRef: "feature/issue-1",
          allowDetachedHead: false,
          allowedPrefixes: ["feature/"],
        },
        deploymentCeiling: "autonomous-delivery",
        runtimeSource: "keiko-sidecar",
        actionClasses: ["workspace-read", "workspace-write", "verification"],
        connectorScopes: [],
        modelProfile: {
          profileId: "profile-1",
          source: "keiko-model-gateway",
          supportsStreaming: true,
          supportsToolCalling: true,
        },
        commandPolicy: {
          mode: "governed",
          allow: [],
          deny: [],
          maxCommandTimeoutMs: 60_000,
          requirePerCommandApproval: false,
        },
        networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
        gates: [],
        budget: {
          maxRuntimeMs: 60_000,
          maxToolCalls: 1,
          maxPromptTokens: 1000,
          maxPatchBytes: 1024,
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
  }

  function fixture(readFacts: () => Promise<GitCiFactsResult>): {
    readonly deps: DraftDeliveryDependencies;
    readonly verified: VerifiedCommitRuntimeDependencies;
    readonly events: CodingWorkbenchRuntimeEvent[];
  } {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const snapshots = createDraftRun(db);
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const logEvents: ServerLogEvent[] = [];
    const readinessSnapshots: CodingRuntimeSnapshotStore = {
      ...snapshots,
      ciReadiness: createCodingRuntimeCiReadinessStore(db, snapshots),
      ciRepairBudget: createCodingRuntimeCiRepairBudgetStore({
        db,
        snapshots,
        now: () => Date.parse(AT),
        activityLog: {
          write: (event): void => {
            logEvents.push(event);
          },
        },
      }),
    };
    const shared = {
      snapshots: readinessSnapshots,
      mutationDeps: {
        redactor: (value: unknown): unknown => value,
        evidenceStore: {
          put: (): string => "evidence",
          get: (): undefined => undefined,
          list: (): readonly string[] => [],
          delete: (): void => undefined,
        },
      },
      execution: { now: (): number => Date.parse(AT) },
    };
    return {
      deps: {
        ...shared,
        ciReader: () => ({ readFacts }),
        resolveTarget: () => Promise.resolve({ ok: true, repository: "owner/repository" }),
        inspectionAdapter: () => undefined,
        publishSeams: () => ({}),
        pullRequestSeams: () => ({}),
      },
      verified: {
        ...shared,
        resolveWorkspace: () => workspace,
        buffersClean: () => true,
        messageAllowed: () => Promise.resolve(true),
      },
      events,
    };
  }

  // Same identity as `_support.js`'s `createDraftRun` fixture draft (repository, PR number,
  // head/base SHAs) -- a mismatch would fail closed at the repository-binding check before the
  // reader is ever consulted.
  function failingFacts(): GitCiFactsResult {
    const source = failureFacts([{ ...CHECK, headSha: "3".repeat(40) }]);
    return {
      ...source,
      identity: {
        number: 17,
        externalId: "PR_17",
        url: "https://github.com/owner/repository/pull/17",
        repository: "owner/repository",
        headRepository: "owner/repository",
        headRef: "feature/issue-1",
        headSha: "3".repeat(40),
        baseRef: "dev",
        baseSha: "1".repeat(40),
        state: "open",
        isDraft: true,
      },
    };
  }

  it("surfaces the injected repair budget's real exhaustion as the readiness reason", async () => {
    const test = fixture(() => Promise.resolve(failingFacts()));
    const repairBudget: CiRepairExecutionBudget = {
      admitTool: () => undefined,
      canChargePrompt: () => true,
      chargePrompt: () => true,
      observed: () => undefined,
      repairBudgetExhausted: () => true,
    };
    const service = createProductionCiObservationService(
      test.deps,
      test.verified,
      binding(),
      (event): void => {
        test.events.push(event);
      },
      repairBudget,
    );
    expect(await service?.observe()).toMatchObject({
      status: "observed",
      snapshot: { reason: "repair-budget-exhausted", state: "blocked" },
    });
  });

  it("reads as never-exhausted (the closed default) when no repair budget is supplied", async () => {
    const test = fixture(() => Promise.resolve(failingFacts()));
    const service = createProductionCiObservationService(
      test.deps,
      test.verified,
      binding(),
      (event): void => {
        test.events.push(event);
      },
      // No `repairBudget` argument at all.
    );
    const result = await service?.observe();
    expect(result).toMatchObject({ status: "observed" });
    if (result?.status === "observed") {
      expect(result.snapshot.reason).not.toBe("repair-budget-exhausted");
    }
  });
});
