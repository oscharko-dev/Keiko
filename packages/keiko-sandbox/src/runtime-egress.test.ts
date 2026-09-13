import { describe, expect, it } from "vitest";

import { SEATBELT_DENY_EGRESS_PROFILE } from "./backends.js";
import {
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
    const request: LongLivedRuntimeSandboxRequest = {
      ...loopbackRequest(),
      runtimeSource: "codex-cli-adapter",
      modelSource: "chatgpt-codex-subscription-profile",
      policy: {
        kind: "enterprise-proxy",
        reviewedEgressReceipt: RECEIPT,
        directEgress: "disabled",
        proxyIdentityDigest: "c".repeat(64),
        caIdentityDigest: "d".repeat(64),
      },
    };
    const decision = planLongLivedRuntimeSandbox(
      request,
      { ...NONE, seatbelt: true, docker: true },
      "darwin",
    );
    expect(decision).toEqual({ kind: "fail-closed", reason: "policy-unenforceable" });
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
