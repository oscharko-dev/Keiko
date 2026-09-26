import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";

import { attestPortableManagedRegistrationFacts } from "./update-portable-activation-files.js";
import { createPortableHandoffTreeAttestor } from "./update-portable-handoff-builder.js";
import type { WindowsPortableHandoffPlan } from "./update-portable-handoff-plan.js";
import type { PortableHandoffReceipt } from "./update-portable-handoff-receipts.js";
import {
  digestPortableHandoffFile,
  portableHandoffOperationFrom,
} from "./update-portable-handoff-tree.js";
import { windowsGenerationBindingsEqual } from "./update-portable-windows-generation.js";

const SETUP_MAX_BYTES = 64 * 1024;
const ATTESTATION_TIMEOUT_MS = 2 * 60_000;

export interface WindowsGenerationInspectionAllowance {
  readonly kind: "windows-generation-v1";
  readonly managedRoot: string;
  readonly activationId: string;
  readonly allowedResourceRoots: readonly string[];
}

export type WindowsGenerationSelection = "current" | "candidate";

function generationRoot(treeSha256: string): string {
  return `.portable/generations/${treeSha256}`;
}

function receiptCompleted(
  receipts: readonly PortableHandoffReceipt[],
  kind: PortableHandoffReceipt["kind"],
): boolean {
  return receipts.some((receipt) => receipt.kind === kind && receipt.outcome === "completed");
}

function receiptStarted(
  receipts: readonly PortableHandoffReceipt[],
  kind: PortableHandoffReceipt["kind"],
): boolean {
  return receipts.some((receipt) => receipt.kind === kind);
}

export function windowsGenerationInspectionAllowance(
  plan: WindowsPortableHandoffPlan,
  receipts: readonly PortableHandoffReceipt[],
): WindowsGenerationInspectionAllowance {
  const current = generationRoot(plan.currentGenerationTreeSha256);
  const candidate = generationRoot(plan.candidateGenerationTreeSha256);
  let allowedResourceRoots: readonly string[];
  if (receiptCompleted(receipts, "cleanup")) {
    allowedResourceRoots = [candidate];
  } else if (receiptCompleted(receipts, "restore")) {
    allowedResourceRoots = [current];
  } else if (
    receiptStarted(receipts, "promote") ||
    receiptStarted(receipts, "restore") ||
    receiptStarted(receipts, "cleanup")
  ) {
    allowedResourceRoots = [
      current,
      candidate,
      `.portable/generations/.incoming-${plan.activationId}`,
    ];
  } else {
    allowedResourceRoots = [current];
  }
  return {
    kind: "windows-generation-v1",
    managedRoot: plan.paths.managedRoot,
    activationId: plan.activationId,
    allowedResourceRoots,
  };
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.nlink === 1 &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function setupDigest(path: string, deadline: number): Promise<string | undefined> {
  try {
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > SETUP_MAX_BYTES
    ) {
      return undefined;
    }
    const digest = await digestPortableHandoffFile(
      path,
      portableHandoffOperationFrom({ deadline }),
      SETUP_MAX_BYTES,
    );
    return sameFile(before, lstatSync(path)) ? digest.toString("hex") : undefined;
  } catch {
    return undefined;
  }
}

export async function attestWindowsGenerationInstallation(input: {
  readonly plan: WindowsPortableHandoffPlan;
  readonly selection: WindowsGenerationSelection;
  readonly stateDir: string;
}): Promise<boolean> {
  const current = input.selection === "current";
  const treeSha256 = current
    ? input.plan.currentGenerationTreeSha256
    : input.plan.candidateGenerationTreeSha256;
  const expectedSetupSha256 = current
    ? input.plan.currentSetupManifestSha256
    : input.plan.candidateSetupManifestSha256;
  const expectedRegistrationSha256 = current
    ? input.plan.digests.previousRegistrationSha256
    : input.plan.digests.preparedRegistrationSha256;
  const expectedLauncherSha256 = current
    ? input.plan.digests.currentLauncherSha256
    : input.plan.digests.candidateLauncherSha256;
  const expectedVersion = current ? input.plan.oldProcess.version : input.plan.targetVersion;
  const deadline = Date.now() + ATTESTATION_TIMEOUT_MS;
  const registration = attestPortableManagedRegistrationFacts({
    stateDir: input.stateDir,
    managedRoot: input.plan.paths.managedRoot,
    target: input.plan.target,
    version: expectedVersion,
    expectedSha256: expectedRegistrationSha256,
  });
  if (
    registration?.windowsGeneration === undefined ||
    !windowsGenerationBindingsEqual(registration.windowsGeneration, {
      schemaVersion: 1,
      resourceRoot: generationRoot(treeSha256),
      treeHashSchema: "KHT1",
      treeSha256,
      launcherPath: "Keiko.exe",
      launcherSha256: expectedLauncherSha256,
    }) ||
    (await setupDigest(
      join(input.plan.paths.managedRoot, ".portable", "setup-manifest.json"),
      deadline,
    )) !== expectedSetupSha256
  ) {
    return false;
  }
  return createPortableHandoffTreeAttestor({
    managedRoot: join(input.plan.paths.managedRoot, ...generationRoot(treeSha256).split("/")),
    operationTimeoutMs: Math.max(1, deadline - Date.now()),
  })(treeSha256);
}
