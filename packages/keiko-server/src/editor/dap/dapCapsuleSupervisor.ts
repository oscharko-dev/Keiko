import {
  escalateKill,
  type ChildExitRegistration,
  type KillableChild,
} from "../processHardening.js";
import type { DapByteSink, DapByteSource } from "./dapFrameCodec.js";
import type { DebugCapsuleBackend } from "./debugCapsulePlan.js";

export interface DebugCapsuleScopeInspection {
  readonly qualified: boolean;
  readonly backend: DebugCapsuleBackend;
  readonly runtimeIdentityDigest: string;
  readonly descendants: number;
}

export interface QualifiedDebugCapsuleHandle {
  readonly planId: string;
  readonly source: DapByteSource;
  readonly sink: DapByteSink;
  readonly processGroup: KillableChild;
  readonly exited: () => boolean;
  readonly whenExited?: ChildExitRegistration | undefined;
  inspectScope(): Promise<DebugCapsuleScopeInspection>;
  terminateContainment(signal: "SIGKILL"): Promise<void>;
  cleanup(): Promise<void>;
  onExit?(callback: () => Promise<void>): void;
}

export interface DebugCapsuleQualification {
  readonly backend: DebugCapsuleBackend;
  readonly runtimeIdentityDigest: string;
}

export interface DebugCapsuleTerminationStatus {
  readonly terminated: boolean;
  readonly cleanupComplete: boolean;
}

export async function superviseCapsuleTermination(
  handle: QualifiedDebugCapsuleHandle,
  qualification: DebugCapsuleQualification,
  previous?: DebugCapsuleTerminationStatus,
): Promise<DebugCapsuleTerminationStatus> {
  const terminated =
    previous?.terminated === true || (await terminateVerifiedScope(handle, qualification));
  if (terminationFailed(terminated)) return { terminated: false, cleanupComplete: false };
  const cleanupComplete =
    (previous?.terminated === true && previous.cleanupComplete) || (await cleanupCapsule(handle));
  return { terminated, cleanupComplete };
}

function terminationFailed(value: unknown): value is false {
  return value === false;
}

async function terminateVerifiedScope(
  handle: QualifiedDebugCapsuleHandle,
  qualification: DebugCapsuleQualification,
): Promise<boolean> {
  return runVerifiedTermination(handle, qualification).then(
    (terminated) => terminated,
    () => false,
  );
}

async function runVerifiedTermination(
  handle: QualifiedDebugCapsuleHandle,
  qualification: DebugCapsuleQualification,
): Promise<boolean> {
  const before = await handle.inspectScope();
  const qualified = matchesQualification(before, qualification);
  await escalateKill(handle.processGroup, 5_000, handle.exited, undefined, handle.whenExited);
  if (!qualified) return false;
  let after = await handle.inspectScope();
  if (!matchesQualification(after, qualification)) return false;
  if (after.descendants > 0) {
    await handle.terminateContainment("SIGKILL");
    after = await handle.inspectScope();
  }
  return matchesQualification(after, qualification) && after.descendants === 0;
}

function matchesQualification(
  inspection: DebugCapsuleScopeInspection,
  qualification: DebugCapsuleQualification,
): boolean {
  if (!inspection.qualified) return false;
  if (inspection.backend !== qualification.backend) return false;
  if (inspection.runtimeIdentityDigest !== qualification.runtimeIdentityDigest) return false;
  if (!Number.isSafeInteger(inspection.descendants)) return false;
  return inspection.descendants >= 0;
}

async function cleanupCapsule(handle: QualifiedDebugCapsuleHandle): Promise<boolean> {
  return handle.cleanup().then(
    () => true,
    () => false,
  );
}
