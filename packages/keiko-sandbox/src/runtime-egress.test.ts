import { describe, expect, it } from "vitest";

import { SEATBELT_DENY_EGRESS_PROFILE } from "./backends.js";
import {
  longLivedRuntimeEgressPolicyDigest,
  planLongLivedRuntimeSandbox,
  verifyLongLivedRuntimeSandboxAttestation,
  type LongLivedRuntimeSandboxRequest,
} from "./runtime-egress.js";
import type { BackendAvailability } from "./types.js";

const NONE: BackendAvailability = {
  bubblewrap: false,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
};
const RECEIPT = `sha256:${"b".repeat(64)}`;

function loopbackRequest(): LongLivedRuntimeSandboxRequest {
  return {
    command: "/managed/opencode",
    args: ["serve"],
    cwd: "/workspace",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    authorityEnvelopeDigest: "a".repeat(64),
    policy: { kind: "loopback-only", reviewedEgressReceipt: RECEIPT },
  };
}

function enterpriseProxyRequest(
  policy: Partial<Extract<LongLivedRuntimeSandboxRequest["policy"], { kind: "enterprise-proxy" }>>,
): LongLivedRuntimeSandboxRequest {
  return {
    ...loopbackRequest(),
    runtimeSource: "codex-cli-adapter",
    modelSource: "chatgpt-codex-subscription-profile",
    policy: {
      kind: "enterprise-proxy",
      reviewedEgressReceipt: RECEIPT,
      directEgress: "disabled",
      proxyIdentityDigest: "c".repeat(64),
      ...policy,
    },
  };
}

describe("long-lived runtime egress planning", () => {
  it("wraps a gateway sidecar with the macOS loopback-preserving Seatbelt policy", () => {
    const request = loopbackRequest();
    const decision = planLongLivedRuntimeSandbox(request, { ...NONE, seatbelt: true }, "darwin");

    expect(decision.kind).toBe("wrapped");
    if (decision.kind !== "wrapped") throw new Error("expected wrapped runtime");
    expect(decision.command).toBe("/usr/bin/sandbox-exec");
    expect(decision.args[1]).toBe(SEATBELT_DENY_EGRESS_PROFILE);
    expect(decision.args).toContain("/managed/opencode");
    expect(decision.attestation).toMatchObject({
      backend: "seatbelt",
      networkEnforced: true,
      policyKind: "loopback-only",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      reviewedEgressReceipt: RECEIPT,
    });
    expect(JSON.stringify(decision.attestation)).not.toContain("/managed/opencode");
    expect(JSON.stringify(decision.attestation)).not.toContain("/workspace");
    expect(verifyLongLivedRuntimeSandboxAttestation(decision.attestation, request)).toBe(true);
    expect(
      verifyLongLivedRuntimeSandboxAttestation(
        { ...decision.attestation, authorityEnvelopeDigest: "c".repeat(64) },
        request,
      ),
    ).toBe(false);
    expect(
      verifyLongLivedRuntimeSandboxAttestation(
        { ...decision.attestation, schemaVersion: 2, networkEnforced: false },
        request,
      ),
    ).toBe(false);
    expect(
      verifyLongLivedRuntimeSandboxAttestation(
        { ...decision.attestation, backend: "docker" },
        request,
      ),
    ).toBe(false);
  });

  it.each(["linux", "win32"] as const)(
    "does not misrepresent network namespaces or containers as host-loopback compatible on %s",
    (platform) => {
      const decision = planLongLivedRuntimeSandbox(
        loopbackRequest(),
        { ...NONE, bubblewrap: true, unshare: true, docker: true, podman: true },
        platform,
      );
      expect(decision).toEqual({ kind: "fail-closed", reason: "policy-unenforceable" });
    },
  );

  it("fails closed for a mismatched runtime/model profile", () => {
    const decision = planLongLivedRuntimeSandbox(
      { ...loopbackRequest(), modelSource: "chatgpt-codex-subscription-profile" },
      { ...NONE, seatbelt: true },
      "darwin",
    );
    expect(decision).toEqual({ kind: "fail-closed", reason: "policy-invalid" });
  });

  it("fails closed for reviewed Codex policy until an address-aware backend is qualified", () => {
    const request = enterpriseProxyRequest({ caIdentityDigest: "d".repeat(64) });
    const decision = planLongLivedRuntimeSandbox(
      request,
      { ...NONE, seatbelt: true, docker: true },
      "darwin",
    );
    expect(decision).toEqual({ kind: "fail-closed", reason: "policy-unenforceable" });
  });

  it("verifies enterprise proxy attestations with optional custody digests", () => {
    const request = enterpriseProxyRequest({
      caIdentityDigest: "d".repeat(64),
      noProxyIdentityDigest: "e".repeat(64),
    });
    if (request.policy.kind !== "enterprise-proxy") throw new Error("expected proxy policy");
    const attestation = {
      schemaVersion: 1 as const,
      backend: "seatbelt" as const,
      platform: "darwin",
      networkEnforced: true as const,
      policyKind: "enterprise-proxy" as const,
      runtimeSource: request.runtimeSource,
      modelSource: request.modelSource,
      authorityEnvelopeDigest: request.authorityEnvelopeDigest,
      reviewedEgressReceipt: request.policy.reviewedEgressReceipt,
      policyDigest: longLivedRuntimeEgressPolicyDigest(request.policy),
      directEgress: request.policy.directEgress,
      proxyIdentityDigest: request.policy.proxyIdentityDigest,
      caIdentityDigest: request.policy.caIdentityDigest,
      noProxyIdentityDigest: request.policy.noProxyIdentityDigest,
    };

    expect(verifyLongLivedRuntimeSandboxAttestation(attestation, request)).toBe(true);
    expect(
      verifyLongLivedRuntimeSandboxAttestation({ ...attestation, caIdentityDigest: 7 }, request),
    ).toBe(false);
    expect(
      verifyLongLivedRuntimeSandboxAttestation({ ...attestation, directEgress: "open" }, request),
    ).toBe(false);
    expect(
      verifyLongLivedRuntimeSandboxAttestation(
        { ...attestation, policyKind: "approved-direct" },
        request,
      ),
    ).toBe(false);
    expect(verifyLongLivedRuntimeSandboxAttestation(null, request)).toBe(false);
    expect(verifyLongLivedRuntimeSandboxAttestation([], request)).toBe(false);
  });

  it("rejects malformed enterprise proxy optional digests", () => {
    const decision = planLongLivedRuntimeSandbox(
      enterpriseProxyRequest({ noProxyIdentityDigest: "not-a-digest" }),
      { ...NONE, seatbelt: true },
      "darwin",
    );
    expect(decision).toEqual({ kind: "fail-closed", reason: "policy-invalid" });
  });

  it("retains an approved-direct Codex profile instead of coercing it to loopback", () => {
    const decision = planLongLivedRuntimeSandbox(
      {
        ...loopbackRequest(),
        runtimeSource: "codex-cli-adapter",
        modelSource: "chatgpt-codex-subscription-profile",
        policy: { kind: "approved-direct", reviewedEgressReceipt: RECEIPT },
      },
      { ...NONE, seatbelt: true, docker: true },
      "darwin",
    );
    expect(decision).toEqual({ kind: "fail-closed", reason: "policy-unenforceable" });
  });

  it("rejects raw receipt text so endpoints and credentials cannot enter evidence", () => {
    const request = loopbackRequest();
    const decision = planLongLivedRuntimeSandbox(
      {
        ...request,
        policy: { kind: "loopback-only", reviewedEgressReceipt: "https://proxy.example" },
      },
      { ...NONE, seatbelt: true },
      "darwin",
    );
    expect(decision).toEqual({ kind: "fail-closed", reason: "policy-invalid" });
  });
});
