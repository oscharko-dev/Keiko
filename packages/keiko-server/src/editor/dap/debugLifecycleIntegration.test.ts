import { describe, expect, it, vi } from "vitest";
import { createDapEvidenceProjector } from "./dapEvidenceProjector.js";
import { createDapLifecycleLedger } from "./dapLifecycleLedger.js";
import { createDebugSessionRegistry } from "./debugSessionRegistry.js";

describe("canonical debug lifecycle evidence composition", () => {
  it("composes registry evidence through the partitioned ledger and projector", async () => {
    const put = vi.fn((_runId: string, _json: string) => "/evidence");
    const projector = createDapEvidenceProjector({
      put,
      list: () => [],
      get: () => undefined,
      delete: vi.fn(),
    });
    const journal: string[] = [];
    const ledger = createDapLifecycleLedger({
      appendJournal: (_partition, record) => {
        journal.push(record.eventKind);
        return Promise.resolve();
      },
      projectLive: (partition, projection) => projector.project(partition, projection),
    });
    const registry = createDebugSessionRegistry({
      appendEvidence: (partition, record) => ledger.append(partition, record).then(() => undefined),
      now: () => 1,
      emitOutputLimit: () => undefined,
    });
    await registry.reserve({
      sessionId: "opaque-session",
      workspaceId: "workspace-id",
      workspacePartitionKey: "private-partition",
      browserSessionBinding: "browser-session-digest",
      planId: "plan_a",
      planEpoch: 1,
      planExpiresAtMs: 10_000,
      targetKind: "file",
      activationRevision: 1,
      provisioningDigest: "a".repeat(64),
      backend: "oci",
      network: "none",
      filesystem: "executionRoot",
      runtimeIdentityDigest: "b".repeat(64),
    });
    const stopping = registry.stop("opaque-session");
    await stopping;
    expect(journal).toStrictEqual(["start", "stop", "teardown"]);
    expect(
      ledger.list("private-partition").records.map((record) => record.eventKind),
    ).toStrictEqual(["start", "stop", "teardown"]);
    expect(String(put.mock.calls.at(-1)?.[1])).not.toContain("private-partition");
  });
});
