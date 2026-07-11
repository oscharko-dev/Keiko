export type LongLivedRuntimePlatform = "darwin" | "win32";
export type LongLivedRuntimeArchitecture = "arm64" | "x64";
export type LongLivedRuntimeBackend = "macos-app-sandbox" | "windows-job-object";

export interface LongLivedRuntimeQualification {
  readonly platform: LongLivedRuntimePlatform;
  readonly arch: LongLivedRuntimeArchitecture;
  readonly backend: LongLivedRuntimeBackend;
  readonly releaseReceipt: string;
}

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
