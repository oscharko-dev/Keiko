// Windows custody attestation for the secret vault's key file (#4358).
//
// On POSIX the vault directory is 0o700 and the key file 0o600. Windows has neither, so until now
// Keiko could only report that custody as inherited from the platform. This module answers it from
// the objects' own security descriptors, with the inspection the product already trusts for
// operator-controlled inputs (windows-owner-private.ts, ADR-0182), under the stricter
// confidentiality policy: no principal other than the user, SYSTEM and Administrators may hold ANY
// access to the key file or to its directory.
//
// ORDER. A new key file inherits its permissions from its directory, so the directory is made
// private and verified BEFORE the key is created (`secureWindowsVaultDirectory`); the key is then
// never readable by another principal, not even for a moment. The key file is afterwards judged on
// the descriptor the caller reads the key from, and the directory on the identity at its path, so
// an object swapped after the inspection is refused, not read.
//
// Outcomes (`security.vault.custody`), and the process-wide summary a person sees in
// `keiko status` and `/api/health` (`currentWindowsVaultCustody`):
//   attested    both objects are private as found.
//   protected   the DIRECTORY was not private; Keiko gave it a protected owner-only DACL. The key
//               file itself was private, so the key was not readable.
//   exposed     a key file was reachable by another principal. Keiko protected it, but the key may
//               have been read: stored secrets should be replaced. Never reported as "all good".
//   unattested  the inspection itself could not run (PowerShell blocked or unavailable). Nothing is
//               known and nothing is claimed; the vault keeps working as it did before this
//               attestation existed. It is never treated as attested.
//   refused     an object is not private and could not be made private. Thrown, fail closed.
import { lstatSync } from "node:fs";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ActivityLogErrorKind } from "@oscharko-dev/keiko-contracts";
import { emitSecurityLogEvent, unwiredSecurityLogSink, type SecurityLogSink } from "./log-port.js";
import {
  inspectWindowsOwnerPrivateFiles,
  protectWindowsOwnerPrivateFile,
  windowsOwnerPrivateDirectoryVerdict,
  windowsOwnerPrivateVerdict,
  type WindowsOpenedFileIdentity,
  type WindowsOwnerPrivateFacts,
  type WindowsOwnerPrivateInspection,
  type WindowsOwnerPrivateVerdict,
} from "./windows-owner-private.js";

export type WindowsVaultCustodyOutcome = "attested" | "protected" | "exposed" | "unattested";

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
      values: ["attested", "protected", "exposed", "unattested", "refused"],
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

// Worst first: the summary of a process is the worst outcome any of its vaults reported.
const CUSTODY_SEVERITY: readonly WindowsVaultCustodyOutcome[] = [
  "exposed",
  "unattested",
  "protected",
  "attested",
];

let processCustody: WindowsVaultCustodyOutcome | undefined;

function noteCustody(outcome: WindowsVaultCustodyOutcome): WindowsVaultCustodyOutcome {
  const known = processCustody === undefined ? Infinity : CUSTODY_SEVERITY.indexOf(processCustody);
  if (CUSTODY_SEVERITY.indexOf(outcome) < known) processCustody = outcome;
  return outcome;
}

/**
 * The custody of the secret vaults this process has opened from a key file on Windows: the worst
 * outcome any of them reported, or `undefined` when none was judged (another platform, or no vault
 * key resolved from a key file yet). `unattested` and `exposed` are states of their own: a caller
 * must never read anything but `attested` and `protected` as a private key file.
 */
export function currentWindowsVaultCustody(): WindowsVaultCustodyOutcome | undefined {
  return processCustody;
}

/** Test seam: forgets the process summary. */
export function resetWindowsVaultCustodyForTest(): void {
  processCustody = undefined;
}

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

export interface WindowsVaultDirectoryInput {
  readonly directory: string;
  readonly sink?: SecurityLogSink | undefined;
}

export interface WindowsVaultCustodyInput extends WindowsVaultDirectoryInput {
  readonly keyfile: string;
  /** `fstatSync(fd, { bigint: true })` of the descriptor the caller reads the key from. */
  readonly keyfileIdentity: WindowsOpenedFileIdentity;
}

/** Hermetic seams; production callers pass none. */
export interface WindowsVaultCustodyPorts {
  readonly inspect?: typeof inspectWindowsOwnerPrivateFiles | undefined;
  readonly protect?: typeof protectWindowsOwnerPrivateFile | undefined;
  readonly directoryIdentity?: ((path: string) => WindowsOpenedFileIdentity) | undefined;
}

type Verdicts = Readonly<Partial<Record<CustodyTarget, WindowsOwnerPrivateVerdict>>>;

interface Subject {
  readonly directory: string;
  readonly keyfile?: { readonly path: string; readonly identity: WindowsOpenedFileIdentity };
  readonly sink: SecurityLogSink | undefined;
  readonly ports: WindowsVaultCustodyPorts;
}

// A swapped or wrong-typed object is an attack or a broken state directory, never a permission
// Keiko should rewrite.
const UNREPAIRABLE: ReadonlySet<CustodyReason> = new Set([
  "replaced",
  "not-regular-file",
  "not-directory",
]);

function defaultDirectoryIdentity(path: string): WindowsOpenedFileIdentity {
  const stat = lstatSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

type OpenedFacts = Extract<WindowsOwnerPrivateFacts, { kind: "facts" }>;

function opened(facts: WindowsOwnerPrivateFacts | undefined): OpenedFacts | undefined {
  return facts?.kind === "facts" ? facts : undefined;
}

function verdictsOf(
  subject: Subject,
  inspection: WindowsOwnerPrivateInspection,
): Verdicts | undefined {
  const directoryFacts = opened(inspection.files[0]);
  if (directoryFacts === undefined) return undefined;
  const identity = (subject.ports.directoryIdentity ?? defaultDirectoryIdentity)(subject.directory);
  const directory = windowsOwnerPrivateDirectoryVerdict(
    directoryFacts,
    inspection.principal,
    identity,
    "none",
  );
  if (subject.keyfile === undefined) return { directory };
  const keyfileFacts = opened(inspection.files[1]);
  if (keyfileFacts === undefined) return undefined;
  const keyfile = windowsOwnerPrivateVerdict(
    keyfileFacts,
    inspection.principal,
    subject.keyfile.identity,
    "none",
  );
  return { directory, keyfile };
}

/**
 * `undefined`: an object could not be opened, so nothing is known about it. Throws when the
 * inspection itself could not run; the inspection has then recorded its own body-free refusal.
 */
function inspectCustody(subject: Subject): Verdicts | undefined {
  const inspect = subject.ports.inspect ?? inspectWindowsOwnerPrivateFiles;
  const paths =
    subject.keyfile === undefined ? [subject.directory] : [subject.directory, subject.keyfile.path];
  return verdictsOf(
    subject,
    inspect(paths, { securityLogSink: subject.sink ?? unwiredSecurityLogSink() }),
  );
}

function refusedTargets(verdicts: Verdicts): readonly CustodyTarget[] {
  return (["directory", "keyfile"] as const).filter(
    (target) => verdicts[target]?.kind === "refused",
  );
}

function refusalOf(verdicts: Verdicts, target: CustodyTarget): CustodyReason {
  const verdict = verdicts[target];
  return verdict?.kind === "refused" ? verdict.reason : "none";
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
  if (outcome === "exposed") return { level: "warn", errorKind: "unsafe-target" };
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

/** Records an outcome on the Activity Log and in the process summary. */
function settle(
  subject: Subject,
  outcome: WindowsVaultCustodyOutcome,
  targets: readonly CustodyTarget[],
  reason: CustodyReason = "none",
): WindowsVaultCustodyOutcome {
  emitCustody(subject.sink, outcome, targets, reason);
  return noteCustody(outcome);
}

type FirstLook =
  { readonly kind: "found"; readonly verdicts: Verdicts } | { readonly kind: "unknown" };

/** The first look: an inspection that cannot run, or cannot open an object, knows nothing. */
function firstLook(subject: Subject): FirstLook {
  try {
    const verdicts = inspectCustody(subject);
    if (verdicts !== undefined) return { kind: "found", verdicts };
    emitCustody(subject.sink, "unattested", [], "inspection-unavailable");
  } catch {
    emitCustody(subject.sink, "unattested", [], "inspection-unavailable");
  }
  return { kind: "unknown" };
}

function protectTargets(subject: Subject, targets: readonly CustodyTarget[]): void {
  const protect = subject.ports.protect ?? protectWindowsOwnerPrivateFile;
  for (const target of targets) {
    try {
      // The directory's entries are inheritable, so the key and store files Keiko writes below it
      // are owner-only from the moment they exist; the key file gets its own protected DACL.
      if (target === "directory") {
        protect(subject.directory, {
          inheritToChildren: true,
          securityLogSink: subject.sink ?? unwiredSecurityLogSink(),
        });
      } else if (subject.keyfile !== undefined) {
        protect(subject.keyfile.path, {
          securityLogSink: subject.sink ?? unwiredSecurityLogSink(),
        });
      }
    } catch {
      reportCustodyRefused(subject.sink, target, "protect-failed");
    }
  }
}

function inspectAfterRepair(subject: Subject, repaired: CustodyTarget): Verdicts {
  try {
    const verdicts = inspectCustody(subject);
    if (verdicts !== undefined) return verdicts;
  } catch {
    reportCustodyRefused(subject.sink, repaired, "inspection-unavailable");
  }
  return reportCustodyRefused(subject.sink, repaired, "inspection-unavailable");
}

/** The look after a repair: an unverified repair proves nothing and is refused. */
function verifyRepair(subject: Subject, repaired: CustodyTarget): void {
  const verdicts = inspectAfterRepair(subject, repaired);
  const [stillRefused] = refusedTargets(verdicts);
  if (stillRefused !== undefined) {
    reportCustodyRefused(subject.sink, stillRefused, refusalOf(verdicts, stillRefused));
  }
}

function judge(subject: Subject): WindowsVaultCustodyOutcome {
  const look = firstLook(subject);
  if (look.kind === "unknown") return noteCustody("unattested");
  const targets = refusedTargets(look.verdicts);
  if (targets.length === 0) return settle(subject, "attested", []);
  for (const target of targets) {
    const reason = refusalOf(look.verdicts, target);
    if (UNREPAIRABLE.has(reason)) reportCustodyRefused(subject.sink, target, reason);
  }
  protectTargets(subject, targets);
  verifyRepair(subject, targets[0] ?? "directory");
  // A key file another principal could reach may have been read before it was protected.
  return settle(subject, targets.includes("keyfile") ? "exposed" : "protected", targets);
}

/**
 * Makes the vault directory private to the current Windows principal, and verifies it, BEFORE a
 * key file is created in it: a new file inherits the directory's permissions. Returns the outcome
 * for the directory, or throws {@link WindowsVaultCustodyError} when it stays reachable by another
 * principal.
 */
export function secureWindowsVaultDirectory(
  input: WindowsVaultDirectoryInput,
  ports: WindowsVaultCustodyPorts = {},
): WindowsVaultCustodyOutcome {
  return judge({ directory: input.directory, sink: input.sink, ports });
}

/**
 * Attests that the vault directory and the opened key file are private to the current Windows
 * principal, protecting them first when they are not. Returns the outcome, or throws
 * {@link WindowsVaultCustodyError} when an object stays reachable by another principal. Every
 * outcome is one body-free `security.vault.custody` line and enters the process summary.
 */
export function attestWindowsVaultCustody(
  input: WindowsVaultCustodyInput,
  ports: WindowsVaultCustodyPorts = {},
): WindowsVaultCustodyOutcome {
  return judge({
    directory: input.directory,
    keyfile: { path: input.keyfile, identity: input.keyfileIdentity },
    sink: input.sink,
    ports,
  });
}
