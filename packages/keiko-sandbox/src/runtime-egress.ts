import { createHash } from "node:crypto";

import type {
  CodingWorkbenchModelSource,
  CodingWorkbenchRuntimeSource,
} from "@oscharko-dev/keiko-contracts";

import { buildWrappedCommand } from "./backends.js";
import type { BackendAvailability, IsolatedRunPlan, SandboxBackend } from "./types.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const RECEIPT = /^sha256:[a-f0-9]{64}$/u;

export type LongLivedRuntimeEgressPolicy =
  | {
      readonly kind: "loopback-only";
      readonly reviewedEgressReceipt: string;
    }
  | {
      readonly kind: "enterprise-proxy";
      readonly reviewedEgressReceipt: string;
      readonly directEgress: "disabled" | "approved";
      readonly proxyIdentityDigest: string;
      readonly caIdentityDigest?: string | undefined;
      readonly noProxyIdentityDigest?: string | undefined;
    }
  | {
      readonly kind: "approved-direct";
      readonly reviewedEgressReceipt: string;
    };

export interface LongLivedRuntimeSandboxRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly authorityEnvelopeDigest: string;
  readonly policy: LongLivedRuntimeEgressPolicy;
}

export interface LongLivedRuntimeSandboxAttestation {
  readonly schemaVersion: 1;
  readonly backend: SandboxBackend;
  readonly platform: string;
  readonly networkEnforced: true;
  readonly policyKind: LongLivedRuntimeEgressPolicy["kind"];
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly authorityEnvelopeDigest: string;
  readonly reviewedEgressReceipt: string;
  readonly policyDigest: string;
  readonly directEgress?: "disabled" | "approved" | undefined;
  readonly proxyIdentityDigest?: string | undefined;
  readonly caIdentityDigest?: string | undefined;
  readonly noProxyIdentityDigest?: string | undefined;
}

export type LongLivedRuntimeSandboxDecision =
  | {
      readonly kind: "wrapped";
      readonly command: string;
      readonly args: readonly string[];
      readonly attestation: LongLivedRuntimeSandboxAttestation;
    }
  | {
      readonly kind: "fail-closed";
      readonly reason: "policy-invalid" | "policy-unenforceable";
    };

/**
 * Plans the subset of long-lived policies that the existing OS wrappers can honestly enforce.
 * Seatbelt preserves host loopback while denying public egress. Network namespaces and
 * `--network=none` containers deliberately are not selected: they also sever the BFF/runtime
 * loopback channel, so treating them as compatible would be a false availability claim.
 *
 * Reviewed proxy/direct policies require a release-qualified address-aware backend. None of the
 * generic command wrappers can enforce an allowlist of remote destinations, so they fail closed.
 */
export function planLongLivedRuntimeSandbox(
  request: LongLivedRuntimeSandboxRequest,
  availability: BackendAvailability,
  platform: NodeJS.Platform,
): LongLivedRuntimeSandboxDecision {
  if (!requestIsValid(request)) return { kind: "fail-closed", reason: "policy-invalid" };
  const backend = selectRuntimeBackend(request.policy, availability, platform);
  if (backend === "none") return { kind: "fail-closed", reason: "policy-unenforceable" };
  const plan: IsolatedRunPlan = {
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    network: "none",
  };
  const wrapped = buildWrappedCommand(backend, plan);
  if (wrapped === undefined) return { kind: "fail-closed", reason: "policy-unenforceable" };
  return {
    kind: "wrapped",
    // Long-lived children start with an intentionally minimal environment. Pin the OS-owned
    // executable instead of depending on PATH lookup in either the Node or native supervisor.
    command: backend === "seatbelt" ? "/usr/bin/sandbox-exec" : wrapped.command,
    args: wrapped.args,
    attestation: attestation(request, backend, platform),
  };
}

export function verifyLongLivedRuntimeSandboxAttestation(
  candidate: unknown,
  request: LongLivedRuntimeSandboxRequest,
): candidate is LongLivedRuntimeSandboxAttestation {
  return (
    requestIsValid(request) &&
    attestationIsStructurallyValid(candidate) &&
    bindingMatches(candidate, request) &&
    policyMatches(candidate, request)
  );
}

function attestationIsStructurallyValid(
  candidate: unknown,
): candidate is LongLivedRuntimeSandboxAttestation {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const value = candidate as Record<string, unknown>;
  const requiredStrings = [
    value.platform,
    value.runtimeSource,
    value.modelSource,
    value.authorityEnvelopeDigest,
    value.reviewedEgressReceipt,
    value.policyDigest,
  ];
  const optionalStrings = [
    value.proxyIdentityDigest,
    value.caIdentityDigest,
    value.noProxyIdentityDigest,
  ];
  return (
    value.schemaVersion === 1 &&
    isSandboxBackend(value.backend) &&
    value.networkEnforced === true &&
    isPolicyKind(value.policyKind) &&
    requiredStrings.every((entry) => typeof entry === "string") &&
    isOptionalDirectEgress(value.directEgress) &&
    optionalStrings.every(isOptionalString)
  );
}

function isSandboxBackend(value: unknown): value is SandboxBackend {
  return (
    value === "bubblewrap" ||
    value === "unshare" ||
    value === "seatbelt" ||
    value === "container-docker" ||
    value === "container-podman" ||
    value === "none"
  );
}

function isPolicyKind(value: unknown): value is LongLivedRuntimeEgressPolicy["kind"] {
  return value === "loopback-only" || value === "enterprise-proxy" || value === "approved-direct";
}

function isOptionalDirectEgress(value: unknown): boolean {
  return value === undefined || value === "disabled" || value === "approved";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function bindingMatches(
  candidate: LongLivedRuntimeSandboxAttestation,
  request: LongLivedRuntimeSandboxRequest,
): boolean {
  return (
    candidate.backend !== "none" &&
    candidate.platform.length > 0 &&
    candidate.runtimeSource === request.runtimeSource &&
    candidate.modelSource === request.modelSource &&
    candidate.authorityEnvelopeDigest === request.authorityEnvelopeDigest &&
    candidate.policyKind === request.policy.kind &&
    candidate.reviewedEgressReceipt === request.policy.reviewedEgressReceipt
  );
}

function policyMatches(
  candidate: LongLivedRuntimeSandboxAttestation,
  request: LongLivedRuntimeSandboxRequest,
): boolean {
  return (
    candidate.policyDigest === longLivedRuntimeEgressPolicyDigest(request.policy) &&
    candidate.directEgress === directEgress(request.policy) &&
    candidate.proxyIdentityDigest === proxyDigest(request.policy) &&
    candidate.caIdentityDigest === caDigest(request.policy) &&
    candidate.noProxyIdentityDigest === noProxyDigest(request.policy)
  );
}

function requestIsValid(request: LongLivedRuntimeSandboxRequest): boolean {
  if (
    !DIGEST.test(request.authorityEnvelopeDigest) ||
    !RECEIPT.test(request.policy.reviewedEgressReceipt)
  ) {
    return false;
  }
  if (request.policy.kind === "loopback-only") {
    return (
      request.runtimeSource === "keiko-sidecar" && request.modelSource === "keiko-model-gateway"
    );
  }
  if (
    request.runtimeSource !== "codex-cli-adapter" ||
    request.modelSource !== "chatgpt-codex-subscription-profile"
  ) {
    return false;
  }
  return request.policy.kind === "approved-direct" || proxyPolicyIsValid(request.policy);
}

function proxyPolicyIsValid(
  policy: Extract<LongLivedRuntimeEgressPolicy, { kind: "enterprise-proxy" }>,
): boolean {
  return (
    DIGEST.test(policy.proxyIdentityDigest) &&
    (policy.caIdentityDigest === undefined || DIGEST.test(policy.caIdentityDigest)) &&
    (policy.noProxyIdentityDigest === undefined || DIGEST.test(policy.noProxyIdentityDigest))
  );
}

function selectRuntimeBackend(
  policy: LongLivedRuntimeEgressPolicy,
  availability: BackendAvailability,
  platform: NodeJS.Platform,
): SandboxBackend {
  return policy.kind === "loopback-only" && platform === "darwin" && availability.seatbelt
    ? "seatbelt"
    : "none";
}

function attestation(
  request: LongLivedRuntimeSandboxRequest,
  backend: Exclude<SandboxBackend, "none">,
  platform: NodeJS.Platform,
): LongLivedRuntimeSandboxAttestation {
  return Object.freeze({
    schemaVersion: 1,
    backend,
    platform,
    networkEnforced: true,
    policyKind: request.policy.kind,
    runtimeSource: request.runtimeSource,
    modelSource: request.modelSource,
    authorityEnvelopeDigest: request.authorityEnvelopeDigest,
    reviewedEgressReceipt: request.policy.reviewedEgressReceipt,
    policyDigest: longLivedRuntimeEgressPolicyDigest(request.policy),
    ...(request.policy.kind === "enterprise-proxy"
      ? {
          proxyIdentityDigest: request.policy.proxyIdentityDigest,
          directEgress: request.policy.directEgress,
          ...(request.policy.caIdentityDigest === undefined
            ? {}
            : { caIdentityDigest: request.policy.caIdentityDigest }),
          ...(request.policy.noProxyIdentityDigest === undefined
            ? {}
            : { noProxyIdentityDigest: request.policy.noProxyIdentityDigest }),
        }
      : {}),
  });
}

export function longLivedRuntimeEgressPolicyDigest(policy: LongLivedRuntimeEgressPolicy): string {
  return createHash("sha256").update(canonicalPolicy(policy), "utf8").digest("hex");
}

function canonicalPolicy(policy: LongLivedRuntimeEgressPolicy): string {
  return JSON.stringify(
    policy.kind === "enterprise-proxy"
      ? {
          kind: policy.kind,
          reviewedEgressReceipt: policy.reviewedEgressReceipt,
          directEgress: policy.directEgress,
          proxyIdentityDigest: policy.proxyIdentityDigest,
          ...(policy.caIdentityDigest === undefined
            ? {}
            : { caIdentityDigest: policy.caIdentityDigest }),
          ...(policy.noProxyIdentityDigest === undefined
            ? {}
            : { noProxyIdentityDigest: policy.noProxyIdentityDigest }),
        }
      : { kind: policy.kind, reviewedEgressReceipt: policy.reviewedEgressReceipt },
  );
}

function proxyDigest(policy: LongLivedRuntimeEgressPolicy): string | undefined {
  return policy.kind === "enterprise-proxy" ? policy.proxyIdentityDigest : undefined;
}

function caDigest(policy: LongLivedRuntimeEgressPolicy): string | undefined {
  return policy.kind === "enterprise-proxy" ? policy.caIdentityDigest : undefined;
}

function noProxyDigest(policy: LongLivedRuntimeEgressPolicy): string | undefined {
  return policy.kind === "enterprise-proxy" ? policy.noProxyIdentityDigest : undefined;
}

function directEgress(policy: LongLivedRuntimeEgressPolicy): "disabled" | "approved" | undefined {
  return policy.kind === "enterprise-proxy" ? policy.directEgress : undefined;
}
