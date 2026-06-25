// Unit tests for GET /api/git-delivery/evidence (Issue #474, Epic #470).
// Proves: the audit-export surface is default-off (404) unless the deployment enables it; when
// enabled it returns a structured GitDeliveryAuditPacket aggregating the ledger (AC1/AC4); the
// response is re-redacted on read so a record that escaped persist-time redaction is still scrubbed
// (AC5 defence-in-depth); and a malformed/tampered record is dropped rather than served.

import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { redact } from "@oscharko-dev/keiko-security";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  GitDeliveryAuditPacket,
  GitDeliveryEvidenceRecord,
} from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import { createHandleGitDeliveryEvidenceExport } from "./evidenceRoutes.js";
import {
  gitDeliveryEvidenceRunIdFor,
  recordGitDeliveryMutationEvidence,
} from "./mutationEvidenceLedger.js";

const NOW = Date.UTC(2026, 5, 21, 12, 0, 0);
const SK_FAKE = ["sk", "-live-", "ZYXWVUTSRQPONMLK9876543210"].join("");

function record(overrides: Partial<GitDeliveryEvidenceRecord> = {}): GitDeliveryEvidenceRecord {
  return {
    schemaVersion: "1",
    evidenceId: "gde-route-00000000000000000000000000000000",
    actionKind: "commit",
    riskClass: "local-mutation",
    riskSeverity: 1,
    outcomeClass: "succeeded",
    phaseReached: "result",
    policyOutcome: "allowed",
    correlation: { workflowRunIdHash: "a".repeat(64), actionId: "act-1" },
    approval: { required: false },
    repoContext: {
      targetBranchName: "feature/x",
      headDetached: false,
      stagedFileCount: 1,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
    },
    recovery: { disposition: "none" },
    recordedAtMs: NOW,
    ...overrides,
  };
}

function deps(env: Record<string, string>, evidenceStore: EvidenceStore): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore,
    env,
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

function ctx(query = "days=7&limit=200"): RouteContext {
  const req = Readable.from([]) as IncomingMessage;
  req.method = "GET";
  return {
    req,
    res: {} as ServerResponse,
    params: {},
    url: new URL(`http://127.0.0.1/api/git-delivery/evidence?${query}`),
  };
}

const handler = createHandleGitDeliveryEvidenceExport({ now: () => NOW });
const ENABLED = { KEIKO_GIT_DELIVERY_ENABLED: "true" } as const;

describe("GET /api/git-delivery/evidence — capability gate", () => {
  it("returns 404 when the deployment has not enabled the surface", () => {
    const result = handler(ctx(), deps({}, createInMemoryEvidenceStore()));
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: "GIT_DELIVERY_EVIDENCE_NOT_ENABLED" } });
  });

  it("returns an empty but well-formed packet when enabled with no records", () => {
    const result = handler(ctx(), deps(ENABLED, createInMemoryEvidenceStore()));
    expect(result.status).toBe(200);
    const packet = result.body as GitDeliveryAuditPacket;
    expect(packet.recordCount).toBe(0);
    expect(packet.records).toStrictEqual([]);
    expect(packet.knownLimitations.length).toBeGreaterThan(0);
  });
});

describe("GET /api/git-delivery/evidence — aggregation (AC1/AC4)", () => {
  it("returns the ledger records with class and disposition counts", () => {
    const store = createInMemoryEvidenceStore();
    const redactString = (input: string): string => redact(input);
    recordGitDeliveryMutationEvidence({ evidenceStore: store, redactString }, record());
    recordGitDeliveryMutationEvidence(
      { evidenceStore: store, redactString },
      record({
        evidenceId: "gde-blocked",
        outcomeClass: "blocked",
        blockReason: "protected-branch",
        recovery: { disposition: "policy-forbidden", actionHint: "adjust-policy-target" },
      }),
    );
    const result = handler(ctx(), deps(ENABLED, store));
    const packet = result.body as GitDeliveryAuditPacket;
    expect(packet.recordCount).toBe(2);
    expect(packet.outcomeClassCounts.succeeded).toBe(1);
    expect(packet.outcomeClassCounts.blocked).toBe(1);
    expect(packet.recoveryDispositionCounts["policy-forbidden"]).toBe(1);
  });

  it("honours the limit query bound", () => {
    const store = createInMemoryEvidenceStore();
    const redactString = (input: string): string => redact(input);
    for (let i = 0; i < 5; i += 1) {
      recordGitDeliveryMutationEvidence(
        { evidenceStore: store, redactString },
        record({ evidenceId: `gde-${String(i)}` }),
      );
    }
    const result = handler(ctx("days=7&limit=2"), deps(ENABLED, store));
    const packet = result.body as GitDeliveryAuditPacket;
    expect(packet.recordCount).toBe(2);
    expect(packet.records.map((r) => r.evidenceId)).toStrictEqual(["gde-3", "gde-4"]);
  });
});

describe("GET /api/git-delivery/evidence — defence in depth (AC5)", () => {
  it("re-redacts a record that reached the store unredacted", () => {
    const store = createInMemoryEvidenceStore();
    // Seed the ledger document DIRECTLY (bypassing the redact-on-write path) with a secret-shaped leaf.
    const raw = record({
      repoContext: {
        targetBranchName: `feature/${SK_FAKE}`,
        headDetached: false,
        stagedFileCount: 0,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
      },
    });
    store.put(
      gitDeliveryEvidenceRunIdFor(NOW),
      JSON.stringify({ schemaVersion: "1", records: [raw] }),
    );
    const result = handler(ctx(), deps(ENABLED, store));
    const json = JSON.stringify(result.body);
    expect(json).not.toContain(SK_FAKE);
    expect(json).toContain("[REDACTED]");
  });

  it("drops a malformed record from the exported packet", () => {
    const store = createInMemoryEvidenceStore();
    store.put(
      gitDeliveryEvidenceRunIdFor(NOW),
      JSON.stringify({ schemaVersion: "1", records: [record(), { not: "a record" }] }),
    );
    const result = handler(ctx(), deps(ENABLED, store));
    const packet = result.body as GitDeliveryAuditPacket;
    expect(packet.recordCount).toBe(1);
    expect(packet.records[0]?.evidenceId).toBe("gde-route-00000000000000000000000000000000");
  });

  it("ignores a corrupt bucket document rather than failing the export", () => {
    const store = createInMemoryEvidenceStore();
    store.put(gitDeliveryEvidenceRunIdFor(NOW), "{ not valid json");
    const result = handler(ctx(), deps(ENABLED, store));
    expect(result.status).toBe(200);
    expect((result.body as GitDeliveryAuditPacket).recordCount).toBe(0);
  });
});
