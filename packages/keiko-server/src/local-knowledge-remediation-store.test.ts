import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCapsule,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
} from "@oscharko-dev/keiko-local-knowledge";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { localKnowledgeIndexingRegistry } from "./local-knowledge-indexing-registry.js";
import {
  inspectRemediationStore,
  openRemediationStore,
} from "./local-knowledge-remediation-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  localKnowledgeIndexingRegistry.reset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function seedCapsuleWithRunningJob(runtimeStateDir: string): KnowledgeCapsuleId {
  const dbPath = resolveKnowledgeStorePath({ runtimeStateDir });
  const store = openKnowledgeStore({ dbPath });
  const capId = "cap-1" as KnowledgeCapsuleId;
  createCapsule(store, {
    id: capId,
    displayName: "Remediation Capsule",
    tags: ["docs"],
    retrievalEffort: "default",
    outputMode: "snippets",
    answerGroundingPolicy: "require-citations",
    embeddingModelIdentity: {
      provider: "openai",
      modelId: "text-embedding-3-small",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
    },
    lifecycleState: "indexing",
    storageReference: "capsules/cap-1",
  });
  store._internal.db
    .prepare(
      "INSERT INTO indexing_jobs (id, capsule_id, source_ids_json, started_at, finished_at, status, total_documents, processed_documents, failed_documents, skipped_documents, last_error_code, last_error_message, resume_token, cancellation_requested) VALUES ('job-stranded', :c, '[]', 10, NULL, 'running', 3, 1, 0, 1, NULL, NULL, NULL, 0)",
    )
    .run({ c: capId });
  store.close();
  return capId;
}

function readJobStatus(runtimeStateDir: string): string {
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir }),
  });
  try {
    return (
      store._internal.db
        .prepare("SELECT status FROM indexing_jobs WHERE id = 'job-stranded'")
        .get() as { readonly status: string }
    ).status;
  } finally {
    store.close();
  }
}

describe("local-knowledge remediation store", () => {
  it("recovers a stranded running job to a terminal state when opening the store", () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-remediation-"));
    tempDirs.push(tmp);
    seedCapsuleWithRunningJob(tmp);

    // The remediation path opens with recover-on-open, so a run left `running` by a crash/restart
    // is finalized before the scope is inspected — mirroring the capsule-management handlers.
    const env = openRemediationStore({ runtimeStateDir: tmp });
    try {
      const status = (
        env.store._internal.db
          .prepare("SELECT status FROM indexing_jobs WHERE id = 'job-stranded'")
          .get() as { readonly status: string }
      ).status;
      expect(status).toBe("failed");
    } finally {
      env.close();
    }

    expect(readJobStatus(tmp)).toBe("failed");
  });

  it("leaves a still-active running job untouched during recovery", () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-remediation-"));
    tempDirs.push(tmp);
    const capId = seedCapsuleWithRunningJob(tmp);
    // A job still tracked as active in-process must not be flipped by a concurrent open.
    localKnowledgeIndexingRegistry.start(String(capId));
    localKnowledgeIndexingRegistry.attachJobId(String(capId), "job-stranded");

    const env = openRemediationStore({ runtimeStateDir: tmp });
    try {
      const status = (
        env.store._internal.db
          .prepare("SELECT status FROM indexing_jobs WHERE id = 'job-stranded'")
          .get() as { readonly status: string }
      ).status;
      expect(status).toBe("running");
    } finally {
      env.close();
    }
  });

  it("aggregates capsule scope counts", () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-remediation-"));
    tempDirs.push(tmp);
    seedCapsuleWithRunningJob(tmp);

    const env = openRemediationStore({ runtimeStateDir: tmp });
    try {
      const scope = inspectRemediationStore(env.store);
      expect(scope.capsules).toBe(1);
      expect(scope.documents).toBe(0);
      expect(scope.chunks).toBe(0);
      expect(scope.vectors).toBe(0);
    } finally {
      env.close();
    }
  });

  it("throws when the runtime-state path is unavailable", () => {
    expect(() => openRemediationStore({})).toThrow(/runtime-state path is unavailable/u);
  });
});
