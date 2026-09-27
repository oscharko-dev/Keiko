import { describe, expect, it, vi } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createCodingRuntimeEvidenceAggregator } from "./codingRuntimeEvidenceAggregator.js";

const digest = "b".repeat(64);
const at = "2026-07-13T10:00:00.000Z";
const settlement = {
  runId: "run-evidence",
  state: "succeeded" as const,
  revision: 1,
  settledAt: at,
  taskDigest: digest,
  workspaceDigest: digest,
  operatorDigest: digest,
  authorityDigest: digest,
  bindingDigest: digest,
  provenanceDigest: digest,
};
describe("CodingRuntimeEvidenceAggregator", () => {
  it("does not write on observe and writes one content-free manifest on settlement", () => {
    const backing = createInMemoryEvidenceStore();
    const put = vi.spyOn(backing, "put");
    const aggregator = createCodingRuntimeEvidenceAggregator(backing);
    const sandboxAttestation = Object.assign(
      {
        schemaVersion: 1 as const,
        backend: "seatbelt" as const,
        platform: "darwin",
        networkEnforced: true as const,
        policyKind: "loopback-only" as const,
        runtimeSource: "keiko-sidecar" as const,
        modelSource: "keiko-model-gateway" as const,
        authorityEnvelopeDigest: digest,
        reviewedEgressReceipt: `sha256:${digest}`,
        policyDigest: digest,
      },
      {
        endpoint: "https://secret.example.invalid/v1",
        credential: "Bearer must-not-persist",
      },
    );
    aggregator.observe("run-evidence", {
      kind: "tool-call",
      state: "running",
      authorityDigest: digest,
    });
    aggregator.observe("run-evidence", {
      kind: "sandbox-attestation",
      state: "starting",
      sandboxAttestation,
    });
    expect(put).not.toHaveBeenCalled();
    aggregator.settle(settlement);
    aggregator.settle(settlement);
    expect(put).toHaveBeenCalledTimes(1);
    const json = backing.get("run-evidence") ?? "";
    expect(json).not.toContain("taskIntent");
    expect(json).not.toContain("argv");
    expect(json).not.toContain("output");
    expect(json).not.toContain("secret.example.invalid");
    expect(json).not.toContain("must-not-persist");
    expect(JSON.parse(json)).toMatchObject({
      counts: { "sandbox-attestation": 1 },
      sandboxAttestations: [
        {
          backend: "seatbelt",
          platform: "darwin",
          authorityEnvelopeDigest: digest,
          policyDigest: digest,
        },
      ],
    });
  });
  it("preserves sorted content-free sandbox attestations with optional proxy digests", () => {
    const backing = createInMemoryEvidenceStore();
    const aggregator = createCodingRuntimeEvidenceAggregator(backing);
    const sandboxAttestation = {
      schemaVersion: 1 as const,
      backend: "seatbelt" as const,
      platform: "darwin",
      networkEnforced: true as const,
      policyKind: "enterprise-proxy" as const,
      runtimeSource: "codex-cli-adapter" as const,
      modelSource: "chatgpt-codex-subscription-profile" as const,
      authorityEnvelopeDigest: digest,
      reviewedEgressReceipt: `sha256:${digest}`,
      policyDigest: digest,
      directEgress: "disabled" as const,
      proxyIdentityDigest: "c".repeat(64),
      caIdentityDigest: "d".repeat(64),
      noProxyIdentityDigest: "e".repeat(64),
    };
    aggregator.observe("run-evidence", {
      kind: "sandbox-attestation",
      state: "starting",
      sandboxAttestation: { ...sandboxAttestation, policyDigest: "f".repeat(64) },
    });
    aggregator.observe("run-evidence", {
      kind: "sandbox-attestation",
      state: "starting",
      sandboxAttestation,
    });
    aggregator.settle(settlement);

    expect(JSON.parse(backing.get("run-evidence") ?? "")).toMatchObject({
      sandboxAttestations: [
        { policyDigest: digest, proxyIdentityDigest: "c".repeat(64) },
        { policyDigest: "f".repeat(64), noProxyIdentityDigest: "e".repeat(64) },
      ],
    });
  });
  it("rejects sandbox attestation shape mismatches and raw receipts", () => {
    const aggregator = createCodingRuntimeEvidenceAggregator(createInMemoryEvidenceStore());
    expect(() => {
      aggregator.observe("run-evidence", {
        kind: "tool-call",
        state: "running",
        sandboxAttestation: {
          schemaVersion: 1,
          backend: "seatbelt",
          platform: "darwin",
          networkEnforced: true,
          policyKind: "loopback-only",
          runtimeSource: "keiko-sidecar",
          modelSource: "keiko-model-gateway",
          authorityEnvelopeDigest: digest,
          reviewedEgressReceipt: `sha256:${digest}`,
          policyDigest: digest,
        },
      });
    }).toThrow("sandbox attestation must use the sandbox-attestation observation kind");
    expect(() => {
      aggregator.observe("run-evidence", {
        kind: "sandbox-attestation",
        state: "starting",
        sandboxAttestation: {
          schemaVersion: 1,
          backend: "seatbelt",
          platform: "darwin",
          networkEnforced: true,
          policyKind: "loopback-only",
          runtimeSource: "keiko-sidecar",
          modelSource: "keiko-model-gateway",
          authorityEnvelopeDigest: digest,
          reviewedEgressReceipt: "https://proxy.example.invalid",
          policyDigest: digest,
        },
      });
    }).toThrow("invalid sandbox reviewedEgressReceipt");
  });
  it("deletes exactly store-pruned ids without listing the evidence directory", () => {
    const backing = createInMemoryEvidenceStore();
    const list = vi.spyOn(backing, "list");
    const aggregator = createCodingRuntimeEvidenceAggregator(backing);
    aggregator.settle(settlement);
    aggregator.deletePruned(["run-evidence"]);
    expect(backing.get("run-evidence")).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });
});
