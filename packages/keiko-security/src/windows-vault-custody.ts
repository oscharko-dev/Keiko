// Windows custody attestation for the secret vault's key file (#4358).
//
// On POSIX the vault directory is 0o700 and the key file 0o600. Windows has neither, so until now
// Keiko could only report that custody as inherited from the platform. This module answers it from
// the objects' own security descriptors, with the inspection the product already trusts for
// operator-controlled inputs (windows-owner-private.ts, ADR-0182), under the stricter
// confidentiality policy: no principal other than the user, SYSTEM and Administrators may hold ANY
// access to the key file or to its directory.
//
// The key file is judged on the descriptor the caller reads the key from, and the directory on the
// identity at its path, so an object swapped after the inspection is refused, not read.
//
// Outcomes:
//   attested    both objects are private as found.
//   protected   one was not; Keiko gave it a protected owner-only DACL and it then attested.
//   unattested  the inspection itself could not run (PowerShell blocked or unavailable). Nothing is
//               known, nothing is claimed, and the vault keeps working as it did before this
//               attestation existed. The Activity Log records it at warn.
//   refused     an object is not private and could not be made private. Thrown, fail closed.
import { lstatSync } from "node:fs";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ActivityLogErrorKind } from "@oscharko-dev/keiko-contracts";
import { emitSecurityLogEvent, type SecurityLogSink } from "./log-port.js";
import {
  inspectWindowsOwnerPrivateFiles,
  protectWindowsOwnerPrivateFile,
  windowsOwnerPrivateDirectoryVerdict,
  windowsOwnerPrivateVerdict,
  type WindowsOpenedFileIdentity,
  type WindowsOwnerPrivateInspection,
  type WindowsOwnerPrivateVerdict,
} from "./windows-owner-private.js";

export type WindowsVaultCustodyOutcome = "attested" | "protected" | "unattested";

type CustodyTarget = "directory" | "keyfile";
type CustodyRefusal = Extract<WindowsOwnerPrivateVerdict, { kind: "refused" }>["reason"];
type CustodyReason = CustodyRefusal | "none" | "inspection-unavailable" | "protect-failed";

const CUSTODY_REASONS = [
  "none",
  "inspection-unavailable",
  "protect-failed",
  "unavailable",
  "replaced",
  "not-regular-file",
  "not-directory",
  "malformed-descriptor",
  "foreign-owner",
  "null-dacl",
  "foreign-write",
  "foreign-access",
  "unsupported-ace",
] as const satisfies readonly CustodyReason[];

const SECURITY_VAULT_CUSTODY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.vault.custody",
  category: "security",
  owner: "keiko-security",
  emitter: "windows-vault-custody.emitCustody",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["attested", "protected", "unattested", "refused"],
    },
    // Which object was protected or refused; "none" when both attested as found.
    target: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["none", "directory", "keyfile", "both"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...CUSTODY_REASONS],
    },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["security-vault-key-resolution"],
  proofIds: ["security.vault.custody.decision"],
  releaseImpact: "patch",
});

/** The key file or its directory is not private to the current principal and could not be made so. */
export class WindowsVaultCustodyError extends Error {
  public override readonly name = "WindowsVaultCustodyError";
  public readonly code = "unsafe-target";
  public constructor(
    public readonly target: CustodyTarget,
    public readonly reason: CustodyReason,
  ) {
    // The message names the remedy and never a path, an account or a SID.
    super(
      `secret vault ${target === "directory" ? "directory" : "key file"} is not private to the current Windows user (${reason}); restrict its permissions to this user, SYSTEM and Administrators`,
    );
  }
}

export interface WindowsVaultCustodyInput {
  readonly directory: string;
  readonly keyfile: string;
  /** `fstatSync(fd, { bigint: true })` of the descriptor the caller reads the key from. */
  readonly keyfileIdentity: WindowsOpenedFileIdentity;
  readonly sink?: SecurityLogSink | undefined;
}

/** Hermetic seams; production callers pass none. */
export interface WindowsVaultCustodyPorts {
  readonly inspect?: typeof inspectWindowsOwnerPrivateFiles | undefined;
  readonly protect?: typeof protectWindowsOwnerPrivateFile | undefined;
  readonly directoryIdentity?: ((path: string) => WindowsOpenedFileIdentity) | undefined;
}

interface CustodyVerdicts {
  readonly directory: WindowsOwnerPrivateVerdict;
  readonly keyfile: WindowsOwnerPrivateVerdict;
}

// A swapped or wrong-typed object is an attack or a broken state directory, never a permission
// Keiko should rewrite; a per-object "unavailable" means the object could not be opened at all.
const UNREPAIRABLE: ReadonlySet<CustodyReason> = new Set([
  "replaced",
  "not-regular-file",
  "not-directory",
]);

function defaultDirectoryIdentity(path: string): WindowsOpenedFileIdentity {
  const stat = lstatSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

function verdictsOf(
  inspection: WindowsOwnerPrivateInspection,
  input: WindowsVaultCustodyInput,
  ports: WindowsVaultCustodyPorts,
): CustodyVerdicts | undefined {
  const [directoryFacts, keyfileFacts] = inspection.files;
  if (directoryFacts === undefined || keyfileFacts === undefined) return undefined;
  if (directoryFacts.kind === "unavailable" || keyfileFacts.kind === "unavailable") {
    return undefined;
  }
  const identity = (ports.directoryIdentity ?? defaultDirectoryIdentity)(input.directory);
  return {
    directory: windowsOwnerPrivateDirectoryVerdict(
      directoryFacts,
      inspection.principal,
      identity,
      "none",
    ),
    keyfile: windowsOwnerPrivateVerdict(
      keyfileFacts,
      inspection.principal,
      input.keyfileIdentity,
      "none",
    ),
  };
}

/**
 * `undefined`: an object could not be opened, so nothing is known about it. Throws when the
 * inspection itself could not run; the inspection has then recorded its own body-free refusal.
 */
function inspectCustody(
  input: WindowsVaultCustodyInput,
  ports: WindowsVaultCustodyPorts,
): CustodyVerdicts | undefined {
  const inspect = ports.inspect ?? inspectWindowsOwnerPrivateFiles;
  const inspection = inspect([input.directory, input.keyfile], { securityLogSink: input.sink });
  return verdictsOf(inspection, input, ports);
}

/** The first look: an inspection that cannot run is recorded as `unattested`, never thrown. */
function findCustody(
  input: WindowsVaultCustodyInput,
  ports: WindowsVaultCustodyPorts,
): CustodyVerdicts | undefined {
  try {
    const found = inspectCustody(input, ports);
    if (found === undefined) emitCustody(input.sink, "unattested", [], "inspection-unavailable");
    return found;
  } catch {
    emitCustody(input.sink, "unattested", [], "inspection-unavailable");
    return undefined;
  }
}

/** The look after a repair: an unverified repair proves nothing and is refused. */
function verifyRepair(
  input: WindowsVaultCustodyInput,
  ports: WindowsVaultCustodyPorts,
  repaired: CustodyTarget,
): CustodyVerdicts {
  try {
    const found = inspectCustody(input, ports);
    if (found !== undefined) return found;
  } catch {
    reportCustodyRefused(input.sink, repaired, "inspection-unavailable");
  }
  return reportCustodyRefused(input.sink, repaired, "inspection-unavailable");
}

function refusedTargets(verdicts: CustodyVerdicts): readonly CustodyTarget[] {
  const targets: CustodyTarget[] = [];
  if (verdicts.directory.kind === "refused") targets.push("directory");
  if (verdicts.keyfile.kind === "refused") targets.push("keyfile");
  return targets;
}

function refusalOf(verdicts: CustodyVerdicts, target: CustodyTarget): CustodyReason {
  const verdict = verdicts[target];
  return verdict.kind === "refused" ? verdict.reason : "none";
}

function targetLabel(targets: readonly CustodyTarget[]): "none" | CustodyTarget | "both" {
  if (targets.length === 2) return "both";
  return targets[0] ?? "none";
}

function custodyLevel(outcome: WindowsVaultCustodyOutcome | "refused"): {
  readonly level: "info" | "warn" | "error";
  readonly errorKind?: ActivityLogErrorKind;
} {
  if (outcome === "refused") return { level: "error", errorKind: "unsafe-target" };
  if (outcome === "unattested") return { level: "warn", errorKind: "unavailable" };
  return { level: "info" };
}

function emitCustody(
  sink: SecurityLogSink | undefined,
  outcome: WindowsVaultCustodyOutcome | "refused",
  targets: readonly CustodyTarget[],
  reason: CustodyReason,
): void {
  emitSecurityLogEvent(
    sink,
    activityLogEvent(SECURITY_VAULT_CUSTODY_OPERATION, custodyLevel(outcome), {
      outcome,
      target: targetLabel(targets),
      reason,
    }),
  );
}

function reportCustodyRefused(
  sink: SecurityLogSink | undefined,
  target: CustodyTarget,
  reason: CustodyReason,
): never {
  emitCustody(sink, "refused", [target], reason);
  throw new WindowsVaultCustodyError(target, reason);
}

function protectTargets(
  input: WindowsVaultCustodyInput,
  ports: WindowsVaultCustodyPorts,
  targets: readonly CustodyTarget[],
): void {
  const protect = ports.protect ?? protectWindowsOwnerPrivateFile;
  for (const target of targets) {
    try {
      // The directory's entries are inheritable, so the store files Keiko later writes beside the
      // key are owner-only too; the key file gets its own protected DACL.
      if (target === "directory") {
        protect(input.directory, { inheritToChildren: true, securityLogSink: input.sink });
      } else {
        protect(input.keyfile, { securityLogSink: input.sink });
      }
    } catch {
      reportCustodyRefused(input.sink, target, "protect-failed");
    }
  }
}

/**
 * Attests that the vault directory and the opened key file are private to the current Windows
 * principal, protecting them first when they are not. Returns the outcome, or throws
 * {@link WindowsVaultCustodyError} when an object stays reachable by another principal. Every
 * outcome is one body-free `security.vault.custody` line.
 */
export function attestWindowsVaultCustody(
  input: WindowsVaultCustodyInput,
  ports: WindowsVaultCustodyPorts = {},
): WindowsVaultCustodyOutcome {
  const found = findCustody(input, ports);
  if (found === undefined) return "unattested";
  const targets = refusedTargets(found);
  if (targets.length === 0) {
    emitCustody(input.sink, "attested", [], "none");
    return "attested";
  }
  for (const target of targets) {
    const reason = refusalOf(found, target);
    if (UNREPAIRABLE.has(reason)) reportCustodyRefused(input.sink, target, reason);
  }
  protectTargets(input, ports, targets);
  // The object was seen reachable by another principal; an unverified repair proves nothing.
  const repaired = verifyRepair(input, ports, targets[0] ?? "keyfile");
  const [stillRefused] = refusedTargets(repaired);
  if (stillRefused !== undefined) {
    reportCustodyRefused(input.sink, stillRefused, refusalOf(repaired, stillRefused));
  }
  emitCustody(input.sink, "protected", targets, "none");
  return "protected";
}
