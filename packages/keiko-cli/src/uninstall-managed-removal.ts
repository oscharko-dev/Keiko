import { join } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import { attestedPortableInstallRecord, resumedPortableInstallRecord } from "./portable-install.js";
import {
  portableRegistrationArtifactPaths,
  removePortableManagedInstall,
  removePortableManagedInstallTolerant,
  removePortableRegistrationArtifacts,
  type ManagedRemovalOutcome,
} from "./portable-maintenance.js";
import { REGISTRATION_FILE, type PortableLayout, type PortableTarget } from "./portable-shared.js";
import type { CliIo } from "./runner.js";
import {
  uninstallJournalPath,
  readUninstallJournal,
  writeUninstallJournal,
} from "./uninstall-journal.js";
import {
  runsInsideInstallation,
  startUninstallHelper,
  type HelperEntry,
  type UninstallHelperDeps,
  type UninstallHelperHandle,
  type UninstallHelperRefusal,
} from "./uninstall-windows-helper.js";
import { portableInstallRootIdentitySha256 } from "./portable-registration.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The managed-install part of `keiko uninstall`, in two steps. Planning is read-only: it finds and
 * judges the installation (an interrupted earlier run through its journal) and, on Windows when
 * this command itself runs from inside the installation, starts the helper that will remove what
 * the running program cannot. Applying removes everything it can, keeps going past an entry that is
 * held open, and either finishes, hands the rest to the helper, or reports exactly what remains.
 */

export interface ManagedRemovalDeps {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly argv1: string | undefined;
  readonly cwd: string;
  readonly pid: number;
  readonly helper?: Omit<UninstallHelperDeps, "pid"> | undefined;
  readonly unlink?: ((path: string) => void) | undefined;
  readonly rmdir?: ((path: string) => void) | undefined;
}

export interface ManagedRemovalContext {
  readonly dryRun: boolean;
  readonly io: CliIo;
  readonly env: EnvSource;
  readonly stateDir: string;
  readonly homedir: string;
  readonly securityLogSink?: SecurityLogSink | undefined;
  readonly deps: ManagedRemovalDeps;
}

interface ManagedRecord {
  readonly target: PortableTarget;
  readonly managedRoot: string;
  readonly layout: PortableLayout;
}

export interface ManagedRemovalPlan {
  readonly record: ManagedRecord;
  readonly resumed: boolean;
  readonly selfInside: boolean;
  readonly helper: UninstallHelperHandle | undefined;
}

export type ManagedRemovalPlanResult =
  | { readonly kind: "none" }
  | { readonly kind: "ready"; readonly plan: ManagedRemovalPlan }
  | {
      readonly kind: "refused";
      readonly reason: UninstallHelperRefusal;
      readonly failureKind?: string;
    };

export type ManagedRemovalResult =
  | { readonly kind: "complete"; readonly removedCount: number }
  | {
      readonly kind: "handed-off";
      readonly removedCount: number;
      readonly residueFileCount: number;
      readonly residueDirectoryCount: number;
      /** State entries the helper removes last, so the registration stays until the end. */
      readonly deferredStatePaths: readonly string[];
    }
  | {
      readonly kind: "incomplete";
      readonly removedCount: number;
      readonly residueFileCount: number;
      readonly residueDirectoryCount: number;
    };

const NOOP_IO: CliIo = {
  out: (_text: string): void => undefined,
  err: (_text: string): void => undefined,
};
const MAX_REPORTED_RESIDUE = 20;

function inspectForRemoval(layout: PortableLayout): void {
  removePortableManagedInstall(layout, NOOP_IO, true);
}

function registrationInput(
  record: ManagedRecord,
  context: ManagedRemovalContext,
): Parameters<typeof portableRegistrationArtifactPaths>[0] {
  return {
    layout: record.layout,
    target: record.target,
    managedRoot: record.managedRoot,
    env: context.env,
    home: context.homedir,
    options: { securityLogSink: context.securityLogSink },
  };
}

// The Start-menu entry and the like must be Keiko's own before anything is removed.
function assertRegistrationRemovable(record: ManagedRecord, context: ManagedRemovalContext): void {
  removePortableRegistrationArtifacts({
    ...registrationInput(record, context),
    dryRun: true,
    io: NOOP_IO,
  });
}

function locateManagedRecord(
  context: ManagedRemovalContext,
): { readonly record: ManagedRecord; readonly resumed: boolean } | undefined {
  const { stateDir, env, homedir, securityLogSink } = context;
  const attested = attestedPortableInstallRecord(stateDir, env, homedir, { securityLogSink });
  if (attested === undefined || attested.registration.status === "setup-failed") return undefined;
  if (attested.layout !== undefined && attested.managedRoot !== undefined) {
    return {
      record: {
        target: attested.target,
        managedRoot: attested.managedRoot,
        layout: attested.layout,
      },
      resumed: false,
    };
  }
  const journal = readUninstallJournal(stateDir);
  const resumed =
    journal === undefined
      ? undefined
      : resumedPortableInstallRecord(stateDir, env, homedir, journal, { securityLogSink });
  if (resumed !== undefined) {
    return {
      record: { target: resumed.target, managedRoot: resumed.managedRoot, layout: resumed.layout },
      resumed: true,
    };
  }
  throw new Error(
    "recorded portable-managed install could not be attested from user-local registration or default roots",
  );
}

export async function planManagedRemoval(
  context: ManagedRemovalContext,
): Promise<ManagedRemovalPlanResult> {
  const located = locateManagedRecord(context);
  if (located === undefined) return { kind: "none" };
  const { record, resumed } = located;
  const { deps } = context;
  const selfInside = runsInsideInstallation({
    installRoot: record.layout.installRoot,
    platform: deps.platform,
    execPath: deps.execPath,
    argv1: deps.argv1,
    cwd: deps.cwd,
  });
  if (context.dryRun)
    return { kind: "ready", plan: { record, resumed, selfInside, helper: undefined } };
  inspectForRemoval(record.layout);
  assertRegistrationRemovable(record, context);
  if (!selfInside)
    return { kind: "ready", plan: { record, resumed, selfInside, helper: undefined } };
  const started = await startUninstallHelper(record.layout.installRoot, context.env, {
    ...deps.helper,
    pid: deps.pid,
  });
  if (started.kind === "refused") {
    return started.failureKind === undefined
      ? { kind: "refused", reason: started.reason }
      : { kind: "refused", reason: started.reason, failureKind: started.failureKind };
  }
  return { kind: "ready", plan: { record, resumed, selfInside, helper: started.handle } };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJournal(plan: ManagedRemovalPlan, stateDir: string): void {
  const { record } = plan;
  writeUninstallJournal(stateDir, {
    schemaVersion: 1,
    platformTarget: record.target,
    setupManifestSha256: sha256File(record.layout.setupManifestPath),
    installRootIdentitySha256: portableInstallRootIdentitySha256(record.layout.installRoot),
  });
}

function reportResidue(outcome: ManagedRemovalOutcome, io: CliIo): void {
  const files = outcome.residueFiles;
  for (const path of files.slice(0, MAX_REPORTED_RESIDUE)) io.out(`remaining: ${path}\n`);
  if (files.length > MAX_REPORTED_RESIDUE) {
    io.out(`remaining: and ${String(files.length - MAX_REPORTED_RESIDUE)} more files\n`);
  }
}

function dryRunNotes(plan: ManagedRemovalPlan, io: CliIo): void {
  if (plan.selfInside) {
    io.out(
      "note: this command runs from inside the installation; its own runtime is removed by a helper after the command ends\n",
    );
  }
}

function handedOffEntries(
  outcome: ManagedRemovalOutcome,
  artifacts: readonly string[],
  stateDir: string,
): readonly HelperEntry[] {
  return [
    ...outcome.residueFiles.map((path): HelperEntry => ({ kind: "file", path })),
    ...outcome.residueDirectories.map((path): HelperEntry => ({ kind: "directory", path })),
    // Last, so the installation stays registered, and resumable, until its last file is gone.
    ...artifacts.map((path): HelperEntry => ({ kind: "external-file", path })),
    { kind: "external-file", path: join(stateDir, REGISTRATION_FILE) },
    { kind: "external-file", path: uninstallJournalPath(stateDir) },
    { kind: "external-directory", path: stateDir },
  ];
}

function applyDryRun(
  plan: ManagedRemovalPlan,
  context: ManagedRemovalContext,
): ManagedRemovalResult {
  const { io } = context;
  const { record } = plan;
  removePortableManagedInstall(record.layout, io, true);
  assertRegistrationRemovable(record, context);
  dryRunNotes(plan, io);
  removePortableRegistrationArtifacts({ ...registrationInput(record, context), dryRun: true, io });
  return { kind: "complete", removedCount: 0 };
}

export function applyManagedRemoval(
  plan: ManagedRemovalPlan,
  context: ManagedRemovalContext,
): ManagedRemovalResult {
  if (context.dryRun) return applyDryRun(plan, context);
  const { io, stateDir } = context;
  const { record } = plan;
  writeJournal(plan, stateDir);
  const outcome = removePortableManagedInstallTolerant(record.layout, io, {
    deferIdentity: plan.helper !== undefined,
    unlink: context.deps.unlink,
    rmdir: context.deps.rmdir,
  });
  const residueFileCount = outcome.residueFiles.length;
  const residueDirectoryCount = outcome.residueDirectories.length;
  if (residueFileCount + residueDirectoryCount === 0) {
    plan.helper?.commit([]);
    removePortableRegistrationArtifacts({
      ...registrationInput(record, context),
      dryRun: false,
      io,
    });
    return { kind: "complete", removedCount: outcome.removedCount };
  }
  if (plan.helper === undefined) {
    reportResidue(outcome, io);
    return {
      kind: "incomplete",
      removedCount: outcome.removedCount,
      residueFileCount,
      residueDirectoryCount,
    };
  }
  const artifacts = portableRegistrationArtifactPaths(registrationInput(record, context));
  plan.helper.commit(handedOffEntries(outcome, artifacts, stateDir));
  return {
    kind: "handed-off",
    removedCount: outcome.removedCount,
    residueFileCount,
    residueDirectoryCount,
    deferredStatePaths: [join(stateDir, REGISTRATION_FILE), uninstallJournalPath(stateDir)],
  };
}
