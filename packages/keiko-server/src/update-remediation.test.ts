import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UPDATE_LOCAL_STATE_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import type { UpdateReleaseImpactInput } from "@oscharko-dev/keiko-contracts";
import type {
  LocalKnowledgeRemediationPort,
  LocalKnowledgeRemediationRunResult,
  LocalKnowledgeRemediationScope,
} from "./local-knowledge-remediation.js";
import { createUpdateLocalStateManager } from "./update-local-state.js";
import {
  createUpdateRemediationManager,
  UpdateRemediationError,
  type UpdateRemediationManager,
} from "./update-remediation.js";

const tempRoots: string[] = [];
const NOW = Date.parse("2026-06-30T12:00:00.000Z");
const TARGET = "0.2.12";

function makeStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-update-remediation-"));
  tempRoots.push(root);
  const stateDir = join(root, ".keiko");
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function touch(path: string, content = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function fakeLocalKnowledge(
  result: LocalKnowledgeRemediationRunResult["status"] = "completed",
): LocalKnowledgeRemediationPort & { readonly runs: () => number } {
  let runs = 0;
  const scope: LocalKnowledgeRemediationScope = {
    capsules: 2,
    sources: 3,
    documents: 11,
    chunks: 41,
    vectors: 39,
  };
  return {
    inspect: () => scope,
    reindexAll: (): Promise<LocalKnowledgeRemediationRunResult> => {
      runs += 1;
      return Promise.resolve({
        status: result,
        scope,
        failedCapsules: result === "completed" ? 0 : 1,
        message: result === "completed" ? "done" : "failed",
      });
    },
    runs: () => runs,
  };
}

function throwingLocalKnowledge(): LocalKnowledgeRemediationPort {
  const scope: LocalKnowledgeRemediationScope = {
    capsules: 1,
    sources: 1,
    documents: 1,
    chunks: 1,
    vectors: 0,
  };
  return {
    inspect: () => scope,
    reindexAll: (): Promise<LocalKnowledgeRemediationRunResult> =>
      Promise.reject(new Error("denied source")),
  };
}

function deferredLocalKnowledge(): LocalKnowledgeRemediationPort & {
  readonly complete: () => void;
  readonly runs: () => number;
} {
  let runs = 0;
  let complete!: () => void;
  const scope: LocalKnowledgeRemediationScope = {
    capsules: 2,
    sources: 3,
    documents: 11,
    chunks: 41,
    vectors: 39,
  };
  return {
    inspect: () => scope,
    reindexAll: (): Promise<LocalKnowledgeRemediationRunResult> => {
      runs += 1;
      return new Promise((resolve) => {
        complete = (): void => {
          resolve({
            status: "completed",
            scope,
            failedCapsules: 0,
            message: "done",
          });
        };
      });
    },
    complete: (): void => {
      complete();
    },
    runs: () => runs,
  };
}

function manager(
  stateDir: string,
  localKnowledge?: LocalKnowledgeRemediationPort,
): UpdateRemediationManager {
  return createUpdateRemediationManager({
    localState: createUpdateLocalStateManager({
      stateDir,
      now: () => NOW,
      idFactory: () => "event-1",
    }),
    localKnowledge,
    now: () => NOW,
  });
}

const localKnowledgeImpact: UpdateReleaseImpactInput = {
  affectedStateStores: ["local-knowledge"],
  stateImpact: [
    {
      store: "local knowledge",
      description: "Local Knowledge vectors must be refreshed.",
      remediation: "local-knowledge-reindex-required",
      userActionRequired: true,
    },
  ],
  userActionRequired: true,
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("update remediation manager", () => {
  it("reports no required action when release impact has no affected stores", () => {
    const status = manager(makeStateDir()).getStatus({ targetVersion: TARGET, impact: {} });

    expect(status.overallStatus).toBe("not-required");
    expect(status.updateCanComplete).toBe(true);
    expect(status.actions).toHaveLength(0);
  });

  it("requires user-approved Local Knowledge reindex with scope counts and completion status", async () => {
    const stateDir = makeStateDir();
    touch(join(stateDir, "local-knowledge", "default", "capsules.db"));
    const localKnowledge = fakeLocalKnowledge();
    const subject = manager(stateDir, localKnowledge);

    const pending = subject.getStatus({
      targetVersion: TARGET,
      impact: localKnowledgeImpact,
      persist: true,
    });

    expect(pending.overallStatus).toBe("pending");
    expect(pending.updateCanComplete).toBe(false);
    expect(pending.actions[0]).toMatchObject({
      actionId: "local-knowledge-reindex:local-knowledge",
      status: "pending",
      canDefer: true,
      userApprovalRequired: true,
      scopeCounts: { capsules: 2, documents: 11, vectors: 39 },
    });
    expect(pending.affectedFeatures[0]).toMatchObject({
      featureId: "local-knowledge",
      state: "unavailable",
    });

    const completed = await subject.runAction({
      actionId: "local-knowledge-reindex:local-knowledge",
      targetVersion: TARGET,
      impact: localKnowledgeImpact,
    });

    expect(localKnowledge.runs()).toBe(1);
    expect(completed.overallStatus).toBe("completed");
    expect(completed.updateCanComplete).toBe(true);
    expect(completed.actions[0]?.status).toBe("completed");
  });

  it("repairs affected local-state artifacts without touching customer content", async () => {
    if (process.platform === "win32") return;
    const stateDir = makeStateDir();
    const memoryDb = join(stateDir, "memory", "keiko-memory.db");
    touch(memoryDb, "sealed-memory");
    chmodSync(memoryDb, 0o644);
    const subject = manager(stateDir);

    const completed = await subject.runAction({
      actionId: "local-state-repair:memory-vault",
      targetVersion: TARGET,
      impact: {
        stateImpact: [
          {
            store: "memory",
            description: "Memory store permissions require repair.",
            remediation: "repair-required",
            userActionRequired: true,
          },
        ],
      },
    });

    expect(completed.actions[0]?.status).toBe("completed");
    expect(statSync(memoryDb).mode & 0o777).toBe(0o600);
  });

  it("keeps manual review blocking when update impact requires migration review", async () => {
    const subject = manager(makeStateDir());
    const status = subject.getStatus({
      targetVersion: TARGET,
      impact: {
        stateImpact: [
          {
            store: "config",
            description: "Configuration migration requires review.",
            remediation: "migration-required",
            userActionRequired: true,
          },
        ],
      },
      persist: true,
    });

    expect(status.overallStatus).toBe("manual-review-required");
    expect(status.updateCanComplete).toBe(false);
    expect(subject.updateCanComplete(TARGET)).toBe(false);
    expect(status.actions[0]).toMatchObject({
      actionId: "manual-review:durable-config",
      status: "manual-review-required",
      cliFallback: "keiko repair",
    });
    await expect(
      subject.runAction({
        actionId: "manual-review:durable-config",
        targetVersion: TARGET,
        impact: {
          stateImpact: [
            {
              store: "config",
              description: "Configuration migration requires review.",
              remediation: "migration-required",
              userActionRequired: true,
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(UpdateRemediationError);
  });

  it("allows Local Knowledge reindex to be safely deferred while marking the feature degraded", async () => {
    const subject = manager(makeStateDir(), fakeLocalKnowledge());

    const deferred = await subject.runAction({
      actionId: "local-knowledge-reindex:local-knowledge",
      targetVersion: TARGET,
      impact: localKnowledgeImpact,
      decision: "defer",
    });

    expect(deferred.updateCanComplete).toBe(true);
    expect(deferred.actions[0]?.status).toBe("deferred");
    expect(deferred.affectedFeatures[0]).toMatchObject({
      featureId: "local-knowledge",
      state: "degraded",
    });
  });

  it("uses the injected clock when remediation state is persisted", () => {
    const stateDir = makeStateDir();
    const localState = createUpdateLocalStateManager({
      stateDir,
      now: () => NOW,
      idFactory: () => "event-1",
    });
    const subject = createUpdateRemediationManager({
      localState,
      localKnowledge: fakeLocalKnowledge(),
      now: () => NOW,
    });

    subject.getStatus({
      targetVersion: TARGET,
      impact: localKnowledgeImpact,
      persist: true,
    });

    expect(localState.readRuntimeState().remediations[0]?.updatedAt).toBe(
      new Date(NOW).toISOString(),
    );
  });

  it("rejects concurrent execution of the same remediation action", async () => {
    const localKnowledge = deferredLocalKnowledge();
    const subject = manager(makeStateDir(), localKnowledge);

    const first = subject.runAction({
      actionId: "local-knowledge-reindex:local-knowledge",
      targetVersion: TARGET,
      impact: localKnowledgeImpact,
    });
    await Promise.resolve();

    await expect(
      subject.runAction({
        actionId: "local-knowledge-reindex:local-knowledge",
        targetVersion: TARGET,
        impact: localKnowledgeImpact,
      }),
    ).rejects.toMatchObject({
      code: "UPDATE_REMEDIATION_RUNNING",
      status: 409,
    });
    expect(localKnowledge.runs()).toBe(1);

    localKnowledge.complete();
    await expect(first).resolves.toMatchObject({ overallStatus: "completed" });
  });

  it("resumes an interrupted running remediation as pending after restart", () => {
    const stateDir = makeStateDir();
    const localState = createUpdateLocalStateManager({ stateDir, now: () => NOW });
    localState.writeRuntimeState({
      schemaVersion: UPDATE_LOCAL_STATE_SCHEMA_VERSION,
      updatedAt: "stale",
      targetVersion: TARGET,
      remediations: [
        {
          store: "local-knowledge",
          remediation: "local-knowledge-reindex-required",
          status: "running",
          updatedAt: "stale",
        },
      ],
      warnings: [],
    });
    const subject = createUpdateRemediationManager({
      localState,
      localKnowledge: fakeLocalKnowledge(),
      now: () => NOW,
    });

    const status = subject.getStatus({ targetVersion: TARGET, impact: localKnowledgeImpact });

    expect(status.actions[0]?.status).toBe("pending");
    expect(status.updateCanComplete).toBe(false);
  });

  it("records failed remediation and keeps update completion blocked", async () => {
    const subject = manager(makeStateDir(), fakeLocalKnowledge("failed"));

    const failed = await subject.runAction({
      actionId: "local-knowledge-reindex:local-knowledge",
      targetVersion: TARGET,
      impact: localKnowledgeImpact,
    });

    expect(failed.overallStatus).toBe("failed");
    expect(failed.updateCanComplete).toBe(false);
    expect(failed.actions[0]?.status).toBe("failed");
  });

  it("records thrown remediation failures instead of resuming stale running state", async () => {
    const subject = manager(makeStateDir(), throwingLocalKnowledge());

    const failed = await subject.runAction({
      actionId: "local-knowledge-reindex:local-knowledge",
      targetVersion: TARGET,
      impact: localKnowledgeImpact,
    });

    expect(failed.overallStatus).toBe("failed");
    expect(failed.actions[0]).toMatchObject({
      status: "failed",
      failure: "manual-review-required",
    });
    expect(
      subject.getStatus({ targetVersion: TARGET, impact: localKnowledgeImpact }).actions[0]?.status,
    ).toBe("failed");
  });

  it("treats unsupported owned runtime entries as manual review", () => {
    if (process.platform === "win32") return;
    const stateDir = makeStateDir();
    const target = join(tempRoots[0] ?? dirname(stateDir), "outside");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(stateDir, "memory"));

    const status = manager(stateDir).getStatus({
      targetVersion: TARGET,
      impact: {
        stateImpact: [
          {
            store: "memory",
            description: "Memory store requires repair.",
            remediation: "repair-required",
            userActionRequired: true,
          },
        ],
      },
    });

    expect(status.overallStatus).toBe("manual-review-required");
    expect(status.actions[0]?.status).toBe("manual-review-required");
  });
});
