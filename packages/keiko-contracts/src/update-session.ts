// Governed update execution contract (Issue #1693). This module is pure wire vocabulary and
// boundary validation only: no filesystem, no process execution, no clock, and no sibling imports.

export const UPDATE_SESSION_SCHEMA_VERSION = "1" as const;

export type UpdateInstallPackageManager = "npm" | "yarn";

export const UPDATE_INSTALL_PACKAGE_MANAGERS: readonly UpdateInstallPackageManager[] =
  Object.freeze(["npm", "yarn"] as const satisfies readonly UpdateInstallPackageManager[]);

export type UpdatePortableTarget = "windows-x64" | "macos-arm64" | "macos-x64";

export const UPDATE_PORTABLE_TARGETS: readonly UpdatePortableTarget[] = Object.freeze([
  "windows-x64",
  "macos-arm64",
  "macos-x64",
] as const satisfies readonly UpdatePortableTarget[]);

export const UPDATE_PORTABLE_TARGET_ASSET_NAMES: Readonly<Record<UpdatePortableTarget, string>> =
  Object.freeze({
    "windows-x64": "keiko-windows-x64.zip",
    "macos-arm64": "keiko-macos-arm64.zip",
    "macos-x64": "keiko-macos-x64.zip",
  } as const satisfies Readonly<Record<UpdatePortableTarget, string>>);

export type UpdateInstallModeKind =
  | "package-manager"
  | "portable-managed"
  | "portable-bootstrap"
  | "portable-setup-failed"
  | "portable-it-managed";

export const UPDATE_INSTALL_MODE_KINDS: readonly UpdateInstallModeKind[] = Object.freeze([
  "package-manager",
  "portable-managed",
  "portable-bootstrap",
  "portable-setup-failed",
  "portable-it-managed",
] as const satisfies readonly UpdateInstallModeKind[]);

export type UpdateInstallModeStatus = "supported" | "unsupported";

export const UPDATE_INSTALL_MODE_STATUSES: readonly UpdateInstallModeStatus[] = Object.freeze([
  "supported",
  "unsupported",
] as const satisfies readonly UpdateInstallModeStatus[]);

export type UpdateRecommendedAction =
  | "package-manager-maintenance"
  | "portable-managed-update"
  | "portable-bootstrap-setup"
  | "manual-download";

export const UPDATE_RECOMMENDED_ACTIONS: readonly UpdateRecommendedAction[] = Object.freeze([
  "package-manager-maintenance",
  "portable-managed-update",
  "portable-bootstrap-setup",
  "manual-download",
] as const satisfies readonly UpdateRecommendedAction[]);

export type UpdatePortableInstallStatus = "managed" | "bootstrap" | "setup-failed" | "it-managed";

export const UPDATE_PORTABLE_INSTALL_STATUSES: readonly UpdatePortableInstallStatus[] =
  Object.freeze([
    "managed",
    "bootstrap",
    "setup-failed",
    "it-managed",
  ] as const satisfies readonly UpdatePortableInstallStatus[]);

export type UpdatePortableManagedRootKind =
  "default" | "home-relative" | "absolute-local" | "unknown";

export interface UpdatePortableInstallSummary {
  readonly status: UpdatePortableInstallStatus;
  readonly target: UpdatePortableTarget;
  readonly updateEligible: boolean;
  readonly packageVersion?: string | undefined;
  readonly stable?: boolean | undefined;
  readonly managedRootKind?: UpdatePortableManagedRootKind | undefined;
  readonly setupManifestSha256?: string | undefined;
  readonly installRootIdentitySha256?: string | undefined;
  readonly launcherIdentitySha256?: string | undefined;
  readonly failureReason?: string | undefined;
}

export type UpdatePortableAssetVerificationStatus = "pending" | "verified" | "failed";

export const UPDATE_PORTABLE_ASSET_VERIFICATION_STATUSES: readonly UpdatePortableAssetVerificationStatus[] =
  Object.freeze([
    "pending",
    "verified",
    "failed",
  ] as const satisfies readonly UpdatePortableAssetVerificationStatus[]);

export interface UpdatePortableAssetSummary {
  readonly target: UpdatePortableTarget;
  readonly fileName: string;
  readonly packageVersion: string;
  readonly sha256?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly verificationStatus?: UpdatePortableAssetVerificationStatus | undefined;
}

export type UpdateUnsupportedReason =
  | "unknown-path"
  | "local-checkout"
  | "local-install"
  | "linked-package"
  | "transient-runner"
  | "launcher-drift"
  | "package-manager-ambiguous"
  | "package-manager-unsupported"
  | "manifest-unavailable"
  | "portable-bootstrap"
  | "portable-setup-failed"
  | "portable-it-managed"
  | "portable-registration-invalid"
  | "portable-non-stable";

export const UPDATE_UNSUPPORTED_REASONS: readonly UpdateUnsupportedReason[] = Object.freeze([
  "unknown-path",
  "local-checkout",
  "local-install",
  "linked-package",
  "transient-runner",
  "launcher-drift",
  "package-manager-ambiguous",
  "package-manager-unsupported",
  "manifest-unavailable",
  "portable-bootstrap",
  "portable-setup-failed",
  "portable-it-managed",
  "portable-registration-invalid",
  "portable-non-stable",
] as const satisfies readonly UpdateUnsupportedReason[]);

export type UpdatePolicySource = "default" | "environment";

export interface UpdateMutationPolicy {
  readonly enabled: boolean;
  readonly source: UpdatePolicySource;
  readonly reason?: string | undefined;
}

export interface UpdateCommandPreview {
  readonly executable: UpdateInstallPackageManager;
  readonly args: readonly string[];
  readonly label: string;
}

export interface UpdateRestartCommandPreview {
  readonly executable: "keiko";
  readonly args: readonly string[];
  readonly label: string;
}

export interface UpdateInstallMode {
  readonly schemaVersion: typeof UPDATE_SESSION_SCHEMA_VERSION;
  readonly status: UpdateInstallModeStatus;
  readonly packageName: string;
  readonly installKind?: UpdateInstallModeKind | undefined;
  readonly packageManager?: UpdateInstallPackageManager | undefined;
  readonly installRoot?: string | undefined;
  readonly portable?: UpdatePortableInstallSummary | undefined;
  readonly asset?: UpdatePortableAssetSummary | undefined;
  readonly recommendedAction?: UpdateRecommendedAction | undefined;
  readonly reason?: UpdateUnsupportedReason | undefined;
  readonly manualInstructions?: string | undefined;
  readonly commandPreview?: UpdateCommandPreview | undefined;
}

export type UpdateSessionPhase =
  "preparing" | "running" | "restart-required" | "succeeded" | "failed" | "cancelled";

export const UPDATE_SESSION_PHASES: readonly UpdateSessionPhase[] = Object.freeze([
  "preparing",
  "running",
  "restart-required",
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly UpdateSessionPhase[]);

export type UpdateSessionFailureReason =
  | "none"
  | "policy-disabled"
  | "unsupported-install-mode"
  | "command-denied"
  | "spawn-error"
  | "non-zero-exit"
  | "timed-out"
  | "cancelled"
  | "restart-version-mismatch";

export const UPDATE_SESSION_FAILURE_REASONS: readonly UpdateSessionFailureReason[] = Object.freeze([
  "none",
  "policy-disabled",
  "unsupported-install-mode",
  "command-denied",
  "spawn-error",
  "non-zero-exit",
  "timed-out",
  "cancelled",
  "restart-version-mismatch",
] as const satisfies readonly UpdateSessionFailureReason[]);

export interface UpdateSessionLogPreview {
  readonly collapsed: true;
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
}

export interface UpdateSession {
  readonly schemaVersion: typeof UPDATE_SESSION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly packageName: string;
  readonly targetVersion: string;
  readonly phase: UpdateSessionPhase;
  readonly failureReason: UpdateSessionFailureReason;
  readonly packageManager?: UpdateInstallPackageManager | undefined;
  readonly installRoot?: string | undefined;
  readonly commandPreview?: UpdateCommandPreview | undefined;
  readonly restartCommandPreview?: UpdateRestartCommandPreview | undefined;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly cancelable: boolean;
  readonly retryable: boolean;
  readonly restartRequired: boolean;
  readonly message: string;
  readonly logs?: UpdateSessionLogPreview | undefined;
}

export interface UpdateSessionStatus {
  readonly schemaVersion: typeof UPDATE_SESSION_SCHEMA_VERSION;
  readonly installMode: UpdateInstallMode;
  readonly policy: UpdateMutationPolicy;
  readonly activeSession?: UpdateSession | undefined;
  readonly lastSession?: UpdateSession | undefined;
}

export interface UpdateSessionStartRequest {
  readonly targetVersion: string;
  readonly requestId?: string | undefined;
}

export interface UpdateRestartVerificationRequest {
  readonly targetVersion?: string | undefined;
}

export interface UpdateSessionStartRequestParseOk {
  readonly ok: true;
  readonly value: UpdateSessionStartRequest;
}

export interface UpdateSessionStartRequestParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type UpdateSessionStartRequestParse =
  UpdateSessionStartRequestParseOk | UpdateSessionStartRequestParseFail;

export interface UpdateRestartVerificationRequestParseOk {
  readonly ok: true;
  readonly value: UpdateRestartVerificationRequest;
}

export interface UpdateRestartVerificationRequestParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type UpdateRestartVerificationRequestParse =
  UpdateRestartVerificationRequestParseOk | UpdateRestartVerificationRequestParseFail;

const TARGET_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const MAX_TARGET_VERSION_LENGTH = 64;
const MAX_REQUEST_ID_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTargetVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TARGET_VERSION_LENGTH &&
    TARGET_VERSION_PATTERN.test(value)
  );
}

function validRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

export function parseUpdateSessionStartRequest(input: unknown): UpdateSessionStartRequestParse {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const targetVersion = validTargetVersion(input.targetVersion) ? input.targetVersion : undefined;
  const requestId = validRequestId(input.requestId) ? input.requestId : undefined;
  if (targetVersion === undefined) {
    errors.push("targetVersion must be a stable semver version");
  }
  if (input.requestId !== undefined && requestId === undefined) {
    errors.push(`requestId must be a token of 1-${String(MAX_REQUEST_ID_LENGTH)} characters`);
  }
  if (errors.length > 0 || targetVersion === undefined) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      targetVersion,
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}

export function parseUpdateRestartVerificationRequest(
  input: unknown,
): UpdateRestartVerificationRequestParse {
  if (!isRecord(input)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  if (input.targetVersion !== undefined && !validTargetVersion(input.targetVersion)) {
    return { ok: false, errors: ["targetVersion must be a stable semver version"] };
  }
  return {
    ok: true,
    value: input.targetVersion === undefined ? {} : { targetVersion: input.targetVersion },
  };
}
