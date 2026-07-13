import { describe, expect, it } from "vitest";
import type { CodingWorkbenchAuthorityEnvelope } from "@oscharko-dev/keiko-contracts";
import {
  createAutonomousDeliveryApprovalStore,
  digestEnvelope,
} from "./autonomousDeliveryApprovalStore.js";

const APPROVAL_DIGEST = "a".repeat(64);

function envelope(
  overrides: Partial<CodingWorkbenchAuthorityEnvelope> = {},
): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: "1",
    runId: "run-1993",
    localUser: "operator",
    taskRefs: ["issue-1993"],
    workspace: {
      workspaceId: "workspace",
      rootLabel: "workspace",
      rootDigest: "b".repeat(64),
    },
    branch: {
      baseRef: "dev",
      headRef: "issue/1993",
      allowDetachedHead: false,
      allowedPrefixes: ["issue/"],
    },
    requestedMode: "autonomous-delivery",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "autonomous-delivery",
    runtimeSource: "delivery-runner",
    actionClasses: [
      "workspace-read",
      "workspace-write",
      "command-execution",
      "verification",
      "connector-access",
      "network-egress",
      "delivery-substrate",
    ],
    connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.read"],
    modelProfile: {
      profileId: "codex",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 120_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: {
      mode: "connector-scoped-egress",
      allowLoopback: true,
      connectorScopes: ["source-control.read", "source-control.write"],
    },
    gates: ["human-approval", "branch-allowlist", "verification-green", "policy-review"],
    budget: {
      maxRuntimeMs: 3_600_000,
      maxToolCalls: 20,
      maxPromptTokens: 200_000,
      maxPatchBytes: 1_000_000,
    },
    expiresAt: "2026-07-07T14:00:00.000Z",
    approvalProofDigest: APPROVAL_DIGEST,
    ...overrides,
  };
}

describe("digestEnvelope", () => {
  it("produces a deterministic sha256 hex with the fixed domain-separation prefix", () => {
    // Precomputed from the fixture above and the current
    // `sha256(ENVELOPE_DIGEST_DOMAIN || "\n" || canonicalJson(envelope))` shape.
    // Any change to the domain tag, the separator, or the canonical JSON encoding shifts this
    // hash — that's exactly what the mutation-testing gate needs to see.
    expect(digestEnvelope(envelope())).toBe(
      "e7231ade670ede9c61bad2e463b7867d81fda382d14b89e808daa0bd68d8683d",
    );
  });

  it("changes when any envelope field changes", () => {
    const base = digestEnvelope(envelope());
    expect(digestEnvelope(envelope({ runId: "run-1994" }))).not.toBe(base);
    expect(digestEnvelope(envelope({ expiresAt: "2026-07-07T14:00:01.000Z" }))).not.toBe(base);
  });

  it("returns 64 lowercase hex characters (sha256 shape)", () => {
    expect(digestEnvelope(envelope())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createAutonomousDeliveryApprovalStore", () => {
  const NOW = "2026-07-07T13:00:00.000Z";
  const LATER = "2026-07-07T13:30:00.000Z";
  const AFTER_EXPIRY = "2026-07-07T14:00:01.000Z";

  it("issues a confirmation that consume() accepts for the same envelope", () => {
    const store = createAutonomousDeliveryApprovalStore();
    const env = envelope();
    const confirmation = store.issue(env, NOW);

    expect(confirmation.confirmed).toBe(true);
    expect(confirmation.confirmedAt).toBe(NOW);
    expect(confirmation.approvalProofDigest).toMatch(/^[0-9a-f]{64}$/);

    expect(store.consume(env, confirmation, LATER)).toBe(true);
  });

  it("rejects consume() when the envelope's digest differs from the issued one", () => {
    const store = createAutonomousDeliveryApprovalStore();
    const issued = envelope();
    const confirmation = store.issue(issued, NOW);

    const tampered = envelope({ runId: "run-9999" });
    expect(store.consume(tampered, confirmation, LATER)).toBe(false);
  });

  it("refuses to consume the same confirmation twice (single-use)", () => {
    const store = createAutonomousDeliveryApprovalStore();
    const env = envelope();
    const confirmation = store.issue(env, NOW);

    expect(store.consume(env, confirmation, LATER)).toBe(true);
    expect(store.consume(env, confirmation, LATER)).toBe(false);
  });

  it("refuses to consume a confirmation whose envelope has expired", () => {
    const store = createAutonomousDeliveryApprovalStore();
    const env = envelope();
    const confirmation = store.issue(env, NOW);

    expect(store.consume(env, confirmation, AFTER_EXPIRY)).toBe(false);
  });

  it("refuses to consume when the confirmation itself is marked unconfirmed", () => {
    const store = createAutonomousDeliveryApprovalStore();
    const env = envelope();
    const confirmation = store.issue(env, NOW);

    expect(store.consume(env, { ...confirmation, confirmed: false }, LATER)).toBe(false);
  });

  it("refuses to consume an unknown approvalProofDigest", () => {
    const store = createAutonomousDeliveryApprovalStore();
    const env = envelope();

    expect(
      store.consume(
        env,
        { confirmed: true, approvalProofDigest: "0".repeat(64), confirmedAt: NOW },
        LATER,
      ),
    ).toBe(false);
  });

  it("refuses to consume when the nowIso is malformed", () => {
    const store = createAutonomousDeliveryApprovalStore();
    const env = envelope();
    const confirmation = store.issue(env, NOW);

    expect(store.consume(env, confirmation, "not-a-timestamp")).toBe(false);
  });

  it("refuses to consume when the envelope.expiresAt is malformed", () => {
    const store = createAutonomousDeliveryApprovalStore();
    const env = envelope({ expiresAt: "not-a-timestamp" });
    const confirmation = store.issue(env, NOW);

    expect(store.consume(env, confirmation, LATER)).toBe(false);
  });
});
