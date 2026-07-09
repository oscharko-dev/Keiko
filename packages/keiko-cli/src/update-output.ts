import type {
  UpdateInstallMode,
  UpdatePreflightReport,
  UpdateRemediationStatusReport,
  UpdateSession,
  UpdateSessionStatus,
} from "@oscharko-dev/keiko-contracts";

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

export function isPortableManagedInstallMode(mode: UpdateInstallMode): boolean {
  return (
    mode.installKind === "portable-managed" ||
    mode.recommendedAction === "portable-managed-update" ||
    mode.portable?.status === "managed"
  );
}

function supportedInstallModeLabel(mode: UpdateInstallMode): string {
  if (isPortableManagedInstallMode(mode)) {
    return mode.portable?.target === undefined
      ? "portable-managed"
      : `portable-managed (${mode.portable.target})`;
  }
  return mode.packageManager ?? "unknown package manager";
}

function manualInstruction(mode: UpdateInstallMode): string {
  if (mode.manualInstructions !== undefined) return mode.manualInstructions;
  if (mode.installKind !== undefined && mode.installKind !== "package-manager") {
    return "Use the Keiko update window to retry, keep using the current version, or download the latest release asset manually.";
  }
  return "Use your package manager outside Keiko, then restart Keiko.";
}

function installModeLines(status: UpdateSessionStatus): readonly string[] {
  const mode = status.installMode;
  if (mode.status === "supported") {
    return [
      `Install mode: supported (${supportedInstallModeLabel(mode)})`,
      "Manual instructions: not required",
    ];
  }
  return [
    `Install mode: unsupported (${mode.reason ?? "unknown"})`,
    `Manual instructions: ${manualInstruction(mode)}`,
  ];
}

function policyLines(status: UpdateSessionStatus): readonly string[] {
  if (status.policy.enabled) return [`Policy: enabled (${status.policy.source})`];
  const fallback = isPortableManagedInstallMode(status.installMode)
    ? "Use the app update window when policy allows it, or download the latest Keiko release asset manually."
    : "Use your package manager outside Keiko, then restart Keiko.";
  return [
    `Policy: disabled (${status.policy.source})`,
    `Manual instructions: ${status.policy.reason ?? "Package mutation is disabled."} ${fallback}`,
  ];
}

function blockerLines(report: UpdatePreflightReport): readonly string[] {
  if (report.blockers.length === 0) return ["Blockers: none"];
  return report.blockers.map(
    (blocker) => `Blocker: ${blocker.code} (${blocker.severity}) - ${blocker.message}`,
  );
}

function remediationLines(remediation: UpdateRemediationStatusReport): readonly string[] {
  if (remediation.actions.length === 0) {
    return [`Remediation: ${remediation.overallStatus}`];
  }
  return [
    `Remediation: ${remediation.overallStatus}`,
    ...remediation.actions.map((action) => {
      const fallback =
        action.cliFallback === undefined ? "" : `; CLI fallback: ${action.cliFallback}`;
      return `Action: ${action.remediation} for ${action.store} (${action.status})${fallback}`;
    }),
  ];
}

function activeSessionLine(status: UpdateSessionStatus): string {
  const active = status.activeSession;
  if (active !== undefined) return `Session: active ${active.phase} for ${active.targetVersion}`;
  const last = status.lastSession;
  if (last !== undefined) return `Session: last ${last.phase} for ${last.targetVersion}`;
  return "Session: none";
}

export function renderUpdateStatus(input: {
  readonly title: string;
  readonly report: UpdatePreflightReport;
  readonly status: UpdateSessionStatus;
  readonly remediation: UpdateRemediationStatusReport;
}): readonly string[] {
  return [
    input.title,
    `Current version: ${input.report.currentVersion}`,
    `Target version: ${input.report.targetVersion ?? "none"}`,
    `Update available: ${yesNo(input.report.updateAvailable)}`,
    `Availability: ${input.report.availabilityState}`,
    `Severity: ${input.report.severity}`,
    `Registry metadata: ${input.report.registryStatus}`,
    `Release metadata: ${input.report.releaseMetadataStatus}`,
    `Affected state: ${listOrNone(input.report.affectedStateStores)}`,
    `User action required: ${yesNo(input.report.userActionRequired)}`,
    `One-click eligible: ${yesNo(input.report.oneClickEligible)}`,
    ...policyLines(input.status),
    ...installModeLines(input.status),
    activeSessionLine(input.status),
    ...blockerLines(input.report),
    ...remediationLines(input.remediation),
  ];
}

function isTerminal(session: UpdateSession): boolean {
  return (
    session.phase === "restart-required" ||
    session.phase === "succeeded" ||
    session.phase === "failed" ||
    session.phase === "cancelled"
  );
}

export function renderApplyTerminal(
  session: UpdateSession | undefined,
  status?: UpdateSessionStatus,
): readonly string[] {
  if (session === undefined || !isTerminal(session)) {
    return ["Update apply timed out before a terminal session state was observed."];
  }
  if (session.phase === "restart-required" || session.phase === "succeeded") {
    const portableManaged =
      status !== undefined && isPortableManagedInstallMode(status.installMode);
    const nextStep =
      portableManaged && session.phase === "succeeded"
        ? "Next step: none. Keiko relaunched and verified the new version."
        : "Next step: restart Keiko, then run `keiko update status`.";
    return [`Update apply result: ${session.phase}`, session.message, nextStep];
  }
  return [`Update apply result: ${session.phase}`, session.message];
}
