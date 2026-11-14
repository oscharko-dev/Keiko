import { join } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import { attestedPortableInstallRecord, resumedPortableInstallRecord } from "./portable-install.js";
import {
  portableRegistrationArtifactPaths,
  removePortableManagedInstall,
  removeEmptyInstallTree,
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

export type ResumeState = "none" | "files-remaining" | "installation-gone";

interface ManagedRecord {
  readonly target: PortableTarget;
  readonly managedRoot: string;
  readonly layout: PortableLayout;
}

export interface ManagedRemovalPlan {
  readonly record: ManagedRecord;
  /** What an earlier, interrupted run left: nothing, files, or only the registration. */
  readonly resume: ResumeState;
  readonly selfInside: boolean;
  readonly helper: UninstallHelperHandle | undefined;
  /** The registration artifacts a removal deletes, each verified as Keiko's own. */
  readonly artifacts: readonly string[];
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
      /** The helper had ended before the list was committed: nothing was handed over. */
      readonly helperLost: boolean;
    };

const NOOP_IO: CliIo = {
  out: (_text: string): void => undefined,
  err: (_text: string): void => undefined,
};
const MAX_REPORTED_RESIDUE = 20;

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

function locateManagedRecord(
  context: ManagedRemovalContext,
): { readonly record: ManagedRecord; readonly resume: ResumeState } | undefined {
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
      resume: "none",
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
      resume: resumed.state,
    };
  }
  throw new Error(
    "recorded portable-managed install could not be attested from user-local registration or default roots",
  );
}

// Every path the helper may delete besides the installation's own entries, named exactly.
function helperExternals(artifacts: readonly string[], stateDir: string): readonly string[] {
  return [
    ...artifacts,
    join(stateDir, REGISTRATION_FILE),
    uninstallJournalPath(stateDir),
    stateDir,
  ];
}

export async function planManagedRemoval(
  context: ManagedRemovalContext,
): Promise<ManagedRemovalPlanResult> {
  const located = locateManagedRecord(context);
  if (located === undefined) return { kind: "none" };
  const { record, resume } = located;
  const { deps } = context;
  const selfInside =
    resume !== "installation-gone" &&
    runsInsideInstallation({
      installRoot: record.layout.installRoot,
      platform: deps.platform,
      execPath: deps.execPath,
      argv1: deps.argv1,
      cwd: deps.cwd,
    });
  const plain = { record, resume, selfInside, helper: undefined, artifacts: [] };
  if (context.dryRun) return { kind: "ready", plan: plain };
  if (resume !== "installation-gone") removePortableManagedInstall(record.layout, NOOP_IO, true);
  // The Start-menu entry and the like must be Keiko's own before anything is removed.
  const artifacts = portableRegistrationArtifactPaths(registrationInput(record, context));
  if (!selfInside) return { kind: "ready", plan: { ...plain, artifacts } };
  const started = await startUninstallHelper(
    record.layout.installRoot,
    context.env,
    { ...deps.helper, pid: deps.pid },
    helperExternals(artifacts, context.stateDir),
  );
  if (started.kind === "refused") {
    return started.failureKind === undefined
      ? { kind: "refused", reason: started.reason }
      : { kind: "refused", reason: started.reason, failureKind: started.failureKind };
  }
  return { kind: "ready", plan: { ...plain, helper: started.handle, artifacts } };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Only the first run writes it: a resumed run may no longer have the manifest to digest.
function writeJournal(plan: ManagedRemovalPlan, stateDir: string): void {
  if (plan.resume !== "none") return;
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
  for (const path of outcome.residueDirectories.slice(0, MAX_REPORTED_RESIDUE)) {
    io.out(`remaining: ${path}\n`);
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
  const identity = new Set(outcome.identityResidue);
  return [
    ...outcome.residueFiles
      .filter((path) => !identity.has(path))
      .map((path): HelperEntry => ({ kind: "file", path })),
    // Left to the end, and only if every file before them went: a later run needs them to find the
    // installation.
    ...outcome.identityResidue.map((path): HelperEntry => ({ kind: "identity-file", path })),
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
  if (plan.resume !== "installation-gone") removePortableManagedInstall(record.layout, io, true);
  dryRunNotes(plan, io);
  removePortableRegistrationArtifacts({ ...registrationInput(record, context), dryRun: true, io });
  return { kind: "complete", removedCount: 0 };
}

function finishRegistration(
  plan: ManagedRemovalPlan,
  context: ManagedRemovalContext,
  removedCount: number,
): ManagedRemovalResult {
  plan.helper?.commit([]);
  removePortableRegistrationArtifacts({
    ...registrationInput(plan.record, context),
    dryRun: false,
    io: context.io,
  });
  return { kind: "complete", removedCount };
}

function handOff(
  plan: ManagedRemovalPlan,
  context: ManagedRemovalContext,
  outcome: ManagedRemovalOutcome,
  helper: UninstallHelperHandle,
): ManagedRemovalResult {
  const residueFileCount = outcome.residueFiles.length;
  const residueDirectoryCount = outcome.residueDirectories.length;
  const { stateDir } = context;
  const committed = helper.commit(handedOffEntries(outcome, plan.artifacts, stateDir));
  if (committed === "helper-gone") {
    reportResidue(outcome, context.io);
    return {
      kind: "incomplete",
      removedCount: outcome.removedCount,
      residueFileCount,
      residueDirectoryCount,
      helperLost: true,
    };
  }
  return {
    kind: "handed-off",
    removedCount: outcome.removedCount,
    residueFileCount,
    residueDirectoryCount,
    deferredStatePaths: [join(stateDir, REGISTRATION_FILE), uninstallJournalPath(stateDir)],
  };
}

export function applyManagedRemoval(
  plan: ManagedRemovalPlan,
  context: ManagedRemovalContext,
): ManagedRemovalResult {
  if (context.dryRun) return applyDryRun(plan, context);
  const { io, stateDir } = context;
  const { record } = plan;
  writeJournal(plan, stateDir);
  const outcome =
    plan.resume === "installation-gone"
      ? removeEmptyInstallTree(record.layout.installRoot, io, context.deps.rmdir)
      : removePortableManagedInstallTolerant(record.layout, io, {
          deferIdentity: plan.helper !== undefined,
          unlink: context.deps.unlink,
          rmdir: context.deps.rmdir,
        });
  const residue = outcome.residueFiles.length + outcome.residueDirectories.length;
  if (residue === 0) return finishRegistration(plan, context, outcome.removedCount);
  if (plan.helper !== undefined) return handOff(plan, context, outcome, plan.helper);
  reportResidue(outcome, io);
  return {
    kind: "incomplete",
    removedCount: outcome.removedCount,
    residueFileCount: outcome.residueFiles.length,
    residueDirectoryCount: outcome.residueDirectories.length,
    helperLost: false,
  };
}
