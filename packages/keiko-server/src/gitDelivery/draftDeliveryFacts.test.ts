// `resolveDraftRepository`'s internal `draftRepositoryDrift` distinguishes four closed
// repository/branch-identity conditions. Every one collapses to the single `remote-drift` reason
// the caller sees, but each writes its own `extra.condition` on the activity log first — the
// condition was not reconstructible from the log otherwise (Coding Workbench run 17, 2026-09-10).
// This drives every branch directly against the exported entry point, plus the no-drift path,
// which must neither log nor throw.

import { describe, expect, it } from "vitest";
import type { CodingWorkbenchIssueBinding } from "@oscharko-dev/keiko-contracts";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  codingWorkbenchIssueBindingDigest,
  codingWorkbenchRemoteDigest,
} from "../coding-context/githubIssueResolution.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import { resolveDraftRepository } from "./draftDeliveryFacts.js";
import {
  DraftDeliveryFailure,
  type DraftDeliveryDependencies,
  type DraftDeliveryRunContext,
  type DraftDeliveryTargetResolution,
} from "./draftDeliveryTypes.js";

const DIGEST = "a".repeat(64);
const MISMATCHED_DIGEST = "b".repeat(64);
const REPOSITORY = "owner/repository";
const CORRELATION_ID = "draft-delivery-facts-test";
const DRIFT_OP = "git.draft-delivery.repository-drift";

function makeIssueBinding(): CodingWorkbenchIssueBinding {
  const fields = {
    schemaVersion: "1",
    repositoryId: "repository-1",
    remoteDigest: codingWorkbenchRemoteDigest(REPOSITORY),
    issueNumber: 1,
    issueIdDigest: DIGEST,
    defaultBaseRef: "main",
    contentRevisionDigest: DIGEST,
  } as const;
  return { ...fields, bindingDigest: codingWorkbenchIssueBindingDigest(fields) };
}

function makeContext(issueBinding: CodingWorkbenchIssueBinding): DraftDeliveryRunContext {
  return {
    runId: "run-1",
    taskId: "task-1",
    workspaceId: "workspace-1",
    envelopeDigest: DIGEST,
    runtimeAuthorityDigest: DIGEST,
    workspaceDigest: DIGEST,
    repositoryDigest: issueBinding.remoteDigest,
    issueBinding,
    baseRef: issueBinding.defaultBaseRef,
    headRef: "feature/issue-1",
    correlationId: CORRELATION_ID,
    buffersClean: () => true,
    stillAuthorized: () => true,
    workspace: {
      root: "/workspace",
      selectedRoot: "/workspace",
      name: "test",
      version: undefined,
      testFramework: "vitest",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
  };
}

/** A dependency port `resolveDraftRepository` must never reach; calling it fails the test loudly. */
function neverCalled(name: string): () => never {
  return () => {
    throw new Error(`${name} must not be called by resolveDraftRepository`);
  };
}

function makeDependencies(events: ServerLogEvent[], repository: string): DraftDeliveryDependencies {
  return {
    snapshots: {
      get: neverCalled("snapshots.get"),
      recordDraftDelivery: neverCalled("snapshots.recordDraftDelivery"),
      adoptDraftDeliveryFromPredecessor: neverCalled("snapshots.adoptDraftDeliveryFromPredecessor"),
    },
    mutationDeps: {
      redactor: (value: unknown): unknown => value,
      evidenceStore: createInMemoryEvidenceStore(),
    },
    execution: {
      activityLog: {
        write: (event: ServerLogEvent): void => {
          events.push(event);
        },
      },
    },
    resolveTarget: (): Promise<DraftDeliveryTargetResolution> =>
      Promise.resolve({ ok: true, repository }),
    inspectionAdapter: neverCalled("inspectionAdapter"),
    publishSeams: neverCalled("publishSeams"),
    pullRequestSeams: neverCalled("pullRequestSeams"),
  };
}

/** Resolves to the rejection's `DraftDeliveryFailure`, or fails the test if it is anything else. */
async function captureFailure(promise: Promise<unknown>): Promise<DraftDeliveryFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DraftDeliveryFailure) return error;
    throw error;
  }
  throw new Error("expected resolveDraftRepository to reject with a DraftDeliveryFailure");
}

interface DriftCase {
  readonly condition:
    | "target-repository-mismatch"
    | "workspace-repository-mismatch"
    | "base-ref-mismatch"
    | "head-equals-base";
  readonly repository: string;
  readonly deriveContext: (base: DraftDeliveryRunContext) => DraftDeliveryRunContext;
}

const DRIFT_CASES: readonly DriftCase[] = [
  {
    condition: "target-repository-mismatch",
    repository: "someone-else/other-repository",
    deriveContext: (base) => base,
  },
  {
    condition: "workspace-repository-mismatch",
    repository: REPOSITORY,
    deriveContext: (base) => ({ ...base, repositoryDigest: MISMATCHED_DIGEST }),
  },
  {
    condition: "base-ref-mismatch",
    repository: REPOSITORY,
    deriveContext: (base) => ({ ...base, baseRef: "not-the-default-base" }),
  },
  {
    condition: "head-equals-base",
    repository: REPOSITORY,
    deriveContext: (base) => ({ ...base, headRef: base.baseRef }),
  },
];

describe("resolveDraftRepository repository drift", () => {
  it.each(DRIFT_CASES)(
    "refuses with remote-drift and logs condition $condition",
    async ({ condition, repository, deriveContext }) => {
      const context = deriveContext(makeContext(makeIssueBinding()));
      const events: ServerLogEvent[] = [];
      const dependencies = makeDependencies(events, repository);

      const failure = await captureFailure(resolveDraftRepository(dependencies, context));
      expect(failure.reason).toBe("remote-drift");

      expect(events).toHaveLength(1);
      const line = events.find((event) => event.op === DRIFT_OP);
      expect(line?.correlationId).toBe(CORRELATION_ID);
      expect(line?.extra).toMatchObject({ runId: context.runId, condition });
    },
  );

  it("resolves the repository and logs nothing when no fact drifts", async () => {
    const context = makeContext(makeIssueBinding());
    const events: ServerLogEvent[] = [];
    const dependencies = makeDependencies(events, REPOSITORY);

    await expect(resolveDraftRepository(dependencies, context)).resolves.toBe(REPOSITORY);
    expect(events).toHaveLength(0);
  });
});
