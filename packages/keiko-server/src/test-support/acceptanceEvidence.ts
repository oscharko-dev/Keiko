// The body-free evidence file of the coding acceptance task (#4492), shared by the macOS suite and
// the Windows preconditions run, so both write one format that scripts/check-acceptance-evidence.mjs
// certifies. It records closed values, booleans and counts only.

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { release } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ACCEPTANCE_EVIDENCE_SCHEMA_VERSION = 5;

export interface PreconditionFacts {
  readonly userClass: string;
  readonly containerRuntime: Readonly<Record<string, boolean>>;
  readonly services?: object | undefined;
  readonly unmetPreconditions: readonly string[];
}

export interface AcceptanceEvidenceHost {
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: string;
  readonly node: string;
}

export interface AcceptanceEvidenceInput {
  readonly preconditions: PreconditionFacts;
  readonly opencode: string;
  readonly cases: readonly object[];
  readonly caseSetComplete: boolean;
  readonly everyCaseMetExpectation: boolean;
  /** The host the evidence describes; this process unless a test says otherwise. */
  readonly host?: AcceptanceEvidenceHost;
}

function thisHost(): AcceptanceEvidenceHost {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    node: process.versions.node,
  };
}

/** The evidence object; it certifies only met preconditions and a complete, met case set. */
export function buildAcceptanceEvidence(input: AcceptanceEvidenceInput): Record<string, unknown> {
  const { userClass, containerRuntime, services, unmetPreconditions } = input.preconditions;
  const host = input.host ?? thisHost();
  return {
    schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
    issue: 4492,
    platform: host.platform,
    arch: host.arch,
    osRelease: host.osRelease,
    node: host.node,
    opencode: input.opencode,
    userClass,
    containerRuntime,
    ...(services === undefined ? {} : { services }),
    caseSetComplete: input.caseSetComplete,
    everyCaseMetExpectation: input.everyCaseMetExpectation,
    certifiesPromise:
      unmetPreconditions.length === 0 && input.caseSetComplete && input.everyCaseMetExpectation,
    unmetPreconditions,
    cases: input.cases,
  };
}

/**
 * The evidence file's absolute path, refused when it lies inside the checkout. Symbolic links in
 * the existing part of the path are resolved first, so a link into the checkout is refused too.
 */
export function ownerPrivateEvidenceTarget(file: string, repositoryRoot: string): string {
  const requested = resolve(file);
  let existing = requested;
  const missing: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  const target = join(realpathSync(existing), ...missing);
  const fromCheckout = relative(realpathSync(repositoryRoot), target);
  const outside =
    fromCheckout === ".." || fromCheckout.startsWith(`..${sep}`) || isAbsolute(fromCheckout);
  if (!outside) throw new Error("acceptance-evidence-inside-checkout");
  return target;
}

/**
 * The Windows owner-private setters (`makeOwnerPrivate*` of owner-private-fixture.ts). A test
 * passes them in: production source may not import a test-support fixture (ADR-0019 trust rule 8).
 */
export interface WindowsOwnerPrivacy {
  readonly makeOwnerPrivate: (path: string) => void;
  readonly makeOwnerPrivateDirectory: (path: string) => void;
}

function writeOwnerPrivateWindows(
  target: string,
  content: string,
  privacy: WindowsOwnerPrivacy | undefined,
): void {
  if (privacy === undefined) throw new Error("acceptance-evidence-windows-privacy-missing");
  privacy.makeOwnerPrivateDirectory(dirname(target));
  writeFileSync(target, "");
  privacy.makeOwnerPrivate(target);
  writeFileSync(target, content);
}

/**
 * Writes the evidence file owner-private. On POSIX: never through a symbolic link, into a
 * directory only its owner can enter, with mode 0600 whatever existed before. On Windows: a
 * protected DACL (the user, SYSTEM and Administrators) is set before the content is written.
 */
export function writeOwnerPrivateEvidence(
  target: string,
  content: string,
  windowsPrivacy?: WindowsOwnerPrivacy,
): void {
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    writeOwnerPrivateWindows(target, content, windowsPrivacy);
    return;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("acceptance-evidence-directory-not-owner-private");
  }
  const descriptor = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}
