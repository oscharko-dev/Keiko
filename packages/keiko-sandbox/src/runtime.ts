import { createHash } from "node:crypto";

export type LongLivedRuntimePlatform = "darwin" | "win32";
export type LongLivedRuntimeArchitecture = "arm64" | "x64";
export type LongLivedRuntimeBackend = "macos-app-sandbox" | "windows-job-object";

export interface LongLivedRuntimeQualification {
  readonly platform: LongLivedRuntimePlatform;
  readonly arch: LongLivedRuntimeArchitecture;
  readonly backend: LongLivedRuntimeBackend;
  readonly releaseReceipt: string;
}

export type RuntimeQualificationTarget = "windows-x64" | "macos-arm64" | "macos-x64";

export interface RuntimeQualificationSidecarDigest {
  readonly name: string;
  readonly sha256: string;
}

export interface RuntimeQualificationReceipt {
  readonly schemaVersion: 1;
  readonly suiteVersion: "runtime-tree-qualification-v1";
  readonly platformTarget: RuntimeQualificationTarget;
  readonly sourceCommitSha: string;
  readonly artifactSha256: string;
  readonly helperSha256: string;
  readonly sidecars: readonly RuntimeQualificationSidecarDigest[];
  readonly backend: LongLivedRuntimeBackend;
  readonly result: "passed" | "failed";
}

export type RuntimeQualificationReceiptBinding = Omit<
  RuntimeQualificationReceipt,
  "schemaVersion" | "suiteVersion" | "backend" | "result"
>;

export type RuntimeQualificationReceiptResult =
  | { readonly ok: true; readonly qualification: LongLivedRuntimeQualification }
  | { readonly ok: false; readonly reason: "runtime-unqualified" };

export interface ClosedRuntimeLaunchProfile {
  readonly upstreamEditAuthority: false;
  readonly upstreamShellAuthority: false;
  readonly upstreamGitAuthority: false;
  readonly upstreamDeliveryAuthority: false;
  readonly upstreamConnectorAuthority: false;
  readonly upstreamBrowserAuthority: false;
  readonly unrestrictedNetworkAuthority: false;
}

export const CLOSED_RUNTIME_LAUNCH_PROFILE: ClosedRuntimeLaunchProfile = Object.freeze({
  upstreamEditAuthority: false,
  upstreamShellAuthority: false,
  upstreamGitAuthority: false,
  upstreamDeliveryAuthority: false,
  upstreamConnectorAuthority: false,
  upstreamBrowserAuthority: false,
  unrestrictedNetworkAuthority: false,
});

export const PRODUCTION_RUNTIME_QUALIFICATIONS: readonly LongLivedRuntimeQualification[] =
  Object.freeze([]);

export type LongLivedRuntimeQualificationResult =
  | {
      readonly ok: true;
      readonly qualification: LongLivedRuntimeQualification;
      readonly launchProfile: ClosedRuntimeLaunchProfile;
    }
  | { readonly ok: false; readonly reason: "runtime-unqualified" };

export function qualifyLongLivedRuntime(
  requested: LongLivedRuntimeQualification,
  qualifications: readonly LongLivedRuntimeQualification[] = PRODUCTION_RUNTIME_QUALIFICATIONS,
): LongLivedRuntimeQualificationResult {
  const qualification = qualifications.find((entry) => qualificationMatches(entry, requested));
  return qualification === undefined
    ? { ok: false, reason: "runtime-unqualified" }
    : { ok: true, qualification, launchProfile: CLOSED_RUNTIME_LAUNCH_PROFILE };
}

export function qualificationFromReceipt(
  candidate: unknown,
  binding: RuntimeQualificationReceiptBinding,
): RuntimeQualificationReceiptResult {
  if (!receiptIsClosed(candidate) || !bindingIsCurrent(candidate, binding)) {
    return { ok: false, reason: "runtime-unqualified" };
  }
  // ADR-0131 D5 remains fail-closed: the portable architecture has no entitled Endpoint Security
  // System Extension that can independently observe every fork/exec/exit on macOS.
  if (candidate.platformTarget !== "windows-x64") {
    return { ok: false, reason: "runtime-unqualified" };
  }
  const releaseReceipt = `sha256:${createHash("sha256")
    .update(canonicalReceipt(candidate), "utf8")
    .digest("hex")}`;
  return {
    ok: true,
    qualification: {
      platform: "win32",
      arch: "x64",
      backend: "windows-job-object",
      releaseReceipt,
    },
  };
}

function qualificationMatches(
  qualification: LongLivedRuntimeQualification,
  requested: LongLivedRuntimeQualification,
): boolean {
  return (
    qualificationIsSupported(qualification) &&
    qualificationIsSupported(requested) &&
    qualification.platform === requested.platform &&
    qualification.arch === requested.arch &&
    qualification.backend === requested.backend &&
    qualification.releaseReceipt === requested.releaseReceipt
  );
}

const RELEASE_RECEIPT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SIDECAR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const RECEIPT_KEYS = [
  "schemaVersion",
  "suiteVersion",
  "platformTarget",
  "sourceCommitSha",
  "artifactSha256",
  "helperSha256",
  "sidecars",
  "backend",
  "result",
] as const;

function receiptIsClosed(value: unknown): value is RuntimeQualificationReceipt {
  if (!isExactRecord(value, RECEIPT_KEYS)) return false;
  return receiptIdentityIsClosed(value) && receiptResultIsClosed(value);
}

function receiptIdentityIsClosed(
  value: Record<(typeof RECEIPT_KEYS)[number], unknown>,
): value is Record<(typeof RECEIPT_KEYS)[number], unknown> &
  Pick<
    RuntimeQualificationReceipt,
    | "schemaVersion"
    | "suiteVersion"
    | "platformTarget"
    | "sourceCommitSha"
    | "artifactSha256"
    | "helperSha256"
    | "sidecars"
  > {
  return (
    value.schemaVersion === 1 &&
    value.suiteVersion === "runtime-tree-qualification-v1" &&
    isQualificationTarget(value.platformTarget) &&
    typeof value.sourceCommitSha === "string" &&
    COMMIT_PATTERN.test(value.sourceCommitSha) &&
    typeof value.artifactSha256 === "string" &&
    DIGEST_PATTERN.test(value.artifactSha256) &&
    typeof value.helperSha256 === "string" &&
    DIGEST_PATTERN.test(value.helperSha256) &&
    sidecarsAreClosed(value.sidecars)
  );
}

function receiptResultIsClosed(
  value: ReturnTypeNarrowedReceipt,
): value is RuntimeQualificationReceipt {
  const backend = value.backend;
  if (backend !== "windows-job-object" && backend !== "macos-app-sandbox") return false;
  if (value.result !== "passed" && value.result !== "failed") return false;
  return backendMatchesTarget({ backend, platformTarget: value.platformTarget });
}

type ReturnTypeNarrowedReceipt = Record<(typeof RECEIPT_KEYS)[number], unknown> &
  Pick<RuntimeQualificationReceipt, "platformTarget">;

function bindingIsCurrent(
  receipt: RuntimeQualificationReceipt,
  binding: RuntimeQualificationReceiptBinding,
): boolean {
  return (
    receipt.result === "passed" &&
    receipt.platformTarget === binding.platformTarget &&
    receipt.sourceCommitSha === binding.sourceCommitSha &&
    receipt.artifactSha256 === binding.artifactSha256 &&
    receipt.helperSha256 === binding.helperSha256 &&
    canonicalSidecars(receipt.sidecars) === canonicalSidecars(binding.sidecars)
  );
}

function sidecarsAreClosed(value: unknown): value is readonly RuntimeQualificationSidecarDigest[] {
  if (!Array.isArray(value) || value.length > 8) return false;
  const names = new Set<string>();
  for (const entry of value) {
    if (!isExactRecord(entry, ["name", "sha256"])) return false;
    if (!SIDECAR_NAME_PATTERN.test(entry.name) || !DIGEST_PATTERN.test(entry.sha256)) return false;
    if (names.has(entry.name)) return false;
    names.add(entry.name);
  }
  return true;
}

function canonicalReceipt(receipt: RuntimeQualificationReceipt): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    suiteVersion: receipt.suiteVersion,
    platformTarget: receipt.platformTarget,
    sourceCommitSha: receipt.sourceCommitSha,
    artifactSha256: receipt.artifactSha256,
    helperSha256: receipt.helperSha256,
    sidecars: canonicalSidecarRecords(receipt.sidecars),
    backend: receipt.backend,
    result: receipt.result,
  });
}

function canonicalSidecars(sidecars: readonly RuntimeQualificationSidecarDigest[]): string {
  return JSON.stringify(canonicalSidecarRecords(sidecars));
}

function canonicalSidecarRecords(
  sidecars: readonly RuntimeQualificationSidecarDigest[],
): readonly RuntimeQualificationSidecarDigest[] {
  return [...sidecars].sort((left, right) => left.name.localeCompare(right.name));
}

function backendMatchesTarget(
  receipt: Pick<RuntimeQualificationReceipt, "platformTarget" | "backend">,
): boolean {
  return receipt.platformTarget === "windows-x64"
    ? receipt.backend === "windows-job-object"
    : receipt.backend === "macos-app-sandbox";
}

function isQualificationTarget(value: unknown): value is RuntimeQualificationTarget {
  return value === "windows-x64" || value === "macos-arm64" || value === "macos-x64";
}

function isExactRecord<const K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, never> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function qualificationIsSupported(
  qualification: unknown,
): qualification is LongLivedRuntimeQualification {
  if (!isQualificationRecord(qualification)) return false;
  if (!RELEASE_RECEIPT_PATTERN.test(qualification.releaseReceipt)) return false;
  if (qualification.platform === "win32") {
    return qualification.arch === "x64" && qualification.backend === "windows-job-object";
  }
  if (qualification.platform === "darwin") {
    return (
      (qualification.arch === "arm64" || qualification.arch === "x64") &&
      qualification.backend === "macos-app-sandbox"
    );
  }
  return false;
}

function isQualificationRecord(
  value: unknown,
): value is Record<"platform" | "arch" | "backend" | "releaseReceipt", string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ["platform", "arch", "backend", "releaseReceipt"];
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key) => typeof record[key] === "string")
  );
}
