import type {
  UpdateActivationWalCheckpoint,
  UpdateActivationWalState,
} from "@oscharko-dev/keiko-contracts";
import {
  portableHandoffPlanSha256,
  readPortableHandoffPlan,
  type PortableHandoffPlan,
} from "./update-portable-handoff-plan.js";
import {
  appendPortableHandoffReceipt,
  publishPortableHandoffVerifiedAck,
  portableHandoffReceiptSha256,
  readPortableHandoffReceipts,
  validatePortableHandoffReceiptSequence,
  type PortableHandoffReceipt,
} from "./update-portable-handoff-receipts.js";

type RecoveryReason = "interrupted" | "corrupt" | "incompatible" | "persistence-failed";
interface RecoveryResult {
  readonly status: "ready" | "recovery-required";
  readonly sessionId?: string | undefined;
  readonly reason?: RecoveryReason | undefined;
}

export interface UpdateStartupRecoveryCurrent {
  readonly pid: number;
  readonly launchId: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly version: string;
}

export interface UpdateStartupRecoveryPort {
  readonly reconcile: (input: {
    readonly phase: "pre-listen" | "post-listen";
    readonly current: UpdateStartupRecoveryCurrent;
  }) => Promise<RecoveryResult>;
}

export type UpdateStartupActiveInstallAttestationInput = {
  readonly activationId: string;
  readonly expectedRegistrationSha256: string;
  readonly expectedVersion: string;
} & (
  | {
      readonly kind: "whole-root-v1";
      readonly expectedTreeSha256: string;
    }
  | {
      readonly kind: "windows-generation-v1";
      readonly expectedGenerationTreeSha256: string;
      readonly expectedSetupManifestSha256: string;
    }
);

export interface UpdateStartupRecoveryOptions {
  readonly stateDir: string;
  readonly readActivation: () => {
    readonly sessionId?: string | undefined;
    readonly activationWal?: UpdateActivationWalState | undefined;
    readonly failureReason?: RecoveryReason | undefined;
  };
  readonly persistActivation: (input: {
    readonly sessionId: string;
    readonly activationWal: UpdateActivationWalState;
    readonly phase: "pre-listen" | "post-listen";
  }) => Promise<void>;
  readonly settleRestored: (input: {
    readonly sessionId: string;
    readonly activationWal: UpdateActivationWalState;
  }) => Promise<void>;
  readonly attestActiveTree: (
    input: UpdateStartupActiveInstallAttestationInput,
  ) => Promise<boolean>;
  readonly now?: (() => number) | undefined;
}

interface RecoveryContext {
  readonly sessionId: string;
  readonly wal: UpdateActivationWalState;
  readonly plan: PortableHandoffPlan;
  readonly receipts: readonly PortableHandoffReceipt[];
  readonly effectiveWal: UpdateActivationWalState;
}

const WAL_CHECKPOINTS: readonly UpdateActivationWalCheckpoint[] = [
  "prepared",
  "old-exited",
  "promoted",
  "registered",
  "new-started",
  "restoring",
  "restored-started",
  "restored-verified",
  "verified",
  "cleanup-pending",
  "complete",
];

const COMPLETION_CHECKPOINT = new Map<string, UpdateActivationWalCheckpoint>([
  ["prepared:completed", "prepared"],
  ["old-exit:completed", "old-exited"],
  ["promote:completed", "promoted"],
  ["register:completed", "registered"],
  ["start:completed", "new-started"],
  ["restore:intent", "restoring"],
  ["restored-start:completed", "restored-started"],
  ["restored-verify:completed", "restored-verified"],
  ["verify:completed", "verified"],
  ["cleanup:intent", "cleanup-pending"],
  ["complete:completed", "complete"],
]);

function result(
  status: RecoveryResult["status"],
  sessionId?: string,
  reason?: RecoveryReason,
): RecoveryResult {
  return {
    status,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function checkpointIndex(checkpoint: UpdateActivationWalCheckpoint): number {
  return WAL_CHECKPOINTS.indexOf(checkpoint);
}

function checkpointFromReceipts(
  receipts: readonly PortableHandoffReceipt[],
): UpdateActivationWalCheckpoint {
  let checkpoint: UpdateActivationWalCheckpoint = "prepared";
  for (const receipt of receipts) {
    checkpoint = COMPLETION_CHECKPOINT.get(`${receipt.kind}:${receipt.outcome}`) ?? checkpoint;
  }
  return checkpoint;
}

function receiptDigest(receipts: readonly PortableHandoffReceipt[]): string | undefined {
  const receipt = receipts.at(-1);
  return receipt === undefined ? undefined : portableHandoffReceiptSha256(receipt);
}

function receiptsMatchWal(
  wal: UpdateActivationWalState,
  receipts: readonly PortableHandoffReceipt[],
): boolean {
  if (receipts.length < wal.receiptSequence) return false;
  if (wal.receiptSequence === 0) return wal.receiptSha256 === undefined;
  const receipt = receipts[wal.receiptSequence - 1];
  return receipt !== undefined && portableHandoffReceiptSha256(receipt) === wal.receiptSha256;
}

function effectiveWal(
  wal: UpdateActivationWalState,
  receipts: readonly PortableHandoffReceipt[],
): UpdateActivationWalState {
  const receiptCheckpoint = checkpointFromReceipts(receipts);
  if (
    receipts.length <= wal.receiptSequence ||
    checkpointIndex(receiptCheckpoint) < checkpointIndex(wal.checkpoint)
  ) {
    return wal;
  }
  const digest = receiptDigest(receipts);
  return {
    ...wal,
    checkpoint: receiptCheckpoint,
    receiptSequence: receipts.length,
    ...(digest === undefined ? {} : { receiptSha256: digest }),
    coordinatorId: wal.coordinatorSha256,
  };
}

function loadRecoveryContext(
  options: UpdateStartupRecoveryOptions,
): RecoveryContext | RecoveryResult {
  let aggregate: ReturnType<UpdateStartupRecoveryOptions["readActivation"]>;
  try {
    aggregate = options.readActivation();
  } catch {
    return result("recovery-required", undefined, "persistence-failed");
  }
  if (aggregate.failureReason !== undefined) {
    return result("recovery-required", aggregate.sessionId, aggregate.failureReason);
  }
  const wal = aggregate.activationWal;
  if (wal === undefined) return result("ready", aggregate.sessionId);
  const sessionId = aggregate.sessionId;
  if (sessionId === undefined) return result("recovery-required", undefined, "corrupt");
  try {
    const plan = readPortableHandoffPlan(options.stateDir, wal.activationId);
    const planSha256 = portableHandoffPlanSha256(plan);
    if (
      planSha256 !== wal.planSha256 ||
      plan.aggregateRevision !== wal.intentRevision ||
      plan.sessionId !== sessionId
    ) {
      return result("recovery-required", sessionId, "incompatible");
    }
    const receipts = readPortableHandoffReceipts(options.stateDir, wal.activationId);
    validatePortableHandoffReceiptSequence({
      activationId: wal.activationId,
      planSha256,
      receipts,
    });
    if (!receiptsMatchWal(wal, receipts)) {
      return result("recovery-required", sessionId, "corrupt");
    }
    return { sessionId, wal, plan, receipts, effectiveWal: effectiveWal(wal, receipts) };
  } catch {
    return result("recovery-required", sessionId, "corrupt");
  }
}

function isRecoveryResult(value: RecoveryContext | RecoveryResult): value is RecoveryResult {
  return "status" in value;
}

async function persistIfAdvanced(
  options: UpdateStartupRecoveryOptions,
  context: RecoveryContext,
  phase: "pre-listen" | "post-listen",
): Promise<RecoveryResult | undefined> {
  try {
    await options.persistActivation({
      sessionId: context.sessionId,
      activationWal: context.effectiveWal,
      phase,
    });
    return undefined;
  } catch {
    return result("recovery-required", context.sessionId, "persistence-failed");
  }
}

async function activeTreeMatches(
  options: UpdateStartupRecoveryOptions,
  context: RecoveryContext,
): Promise<boolean> {
  const restored =
    context.effectiveWal.checkpoint === "restoring" ||
    context.effectiveWal.checkpoint === "restored-started" ||
    context.effectiveWal.checkpoint === "restored-verified";
  try {
    const common = {
      activationId: context.wal.activationId,
      expectedRegistrationSha256: restored
        ? context.plan.digests.previousRegistrationSha256
        : context.plan.digests.preparedRegistrationSha256,
      expectedVersion: restored ? context.plan.oldProcess.version : context.plan.targetVersion,
    } as const;
    return await options.attestActiveTree(
      context.plan.target === "windows-x64"
        ? {
            ...common,
            kind: "windows-generation-v1",
            expectedGenerationTreeSha256: restored
              ? context.plan.currentGenerationTreeSha256
              : context.plan.candidateGenerationTreeSha256,
            expectedSetupManifestSha256: restored
              ? context.plan.currentSetupManifestSha256
              : context.plan.candidateSetupManifestSha256,
          }
        : {
            ...common,
            kind: "whole-root-v1",
            expectedTreeSha256: restored
              ? context.plan.digests.currentTreeSha256
              : context.plan.digests.candidateTreeSha256,
          },
    );
  } catch {
    return false;
  }
}

async function reconcilePreListen(
  options: UpdateStartupRecoveryOptions,
  context: RecoveryContext,
  current: UpdateStartupRecoveryCurrent,
): Promise<RecoveryResult> {
  const checkpoint = context.effectiveWal.checkpoint;
  if (checkpoint === "restoring") return reconcileRestoringPreListen(options, context, current);
  const mayStart =
    checkpoint === "new-started" ||
    checkpoint === "restored-started" ||
    checkpoint === "restored-verified" ||
    checkpoint === "verified" ||
    checkpoint === "cleanup-pending" ||
    checkpoint === "complete";
  if (!mayStart) return result("recovery-required", context.sessionId, "interrupted");
  if (!(await activeTreeMatches(options, context))) {
    return result("recovery-required", context.sessionId, "interrupted");
  }
  return (
    (await persistIfAdvanced(options, context, "pre-listen")) ?? result("ready", context.sessionId)
  );
}

async function reconcileRestoringPreListen(
  options: UpdateStartupRecoveryOptions,
  context: RecoveryContext,
  current: UpdateStartupRecoveryCurrent,
): Promise<RecoveryResult> {
  if (!restoredIdentityMatches(context, current)) {
    return result("recovery-required", context.sessionId, "interrupted");
  }
  if (!(await activeTreeMatches(options, context))) {
    return result("recovery-required", context.sessionId, "interrupted");
  }
  try {
    const nextWal = effectiveWal(context.wal, appendRestoredStart(options, context));
    await options.persistActivation({
      sessionId: context.sessionId,
      activationWal: nextWal,
      phase: "pre-listen",
    });
    return result("ready", context.sessionId);
  } catch {
    return result("recovery-required", context.sessionId, "persistence-failed");
  }
}

function appendRestoredStart(
  options: UpdateStartupRecoveryOptions,
  context: RecoveryContext,
): readonly PortableHandoffReceipt[] {
  const common = {
    stateDir: options.stateDir,
    activationId: context.wal.activationId,
    planSha256: context.wal.planSha256,
    at: options.now?.() ?? Date.now(),
  };
  const pending = context.receipts.at(-1);
  if (pending?.kind === "restored-start" && pending.outcome === "intent") {
    const completed = appendPortableHandoffReceipt({
      ...common,
      kind: "restored-start",
      outcome: "completed",
      previousSha256: portableHandoffReceiptSha256(pending),
    });
    return [...context.receipts, completed.receipt];
  }
  const previous = receiptDigest(context.receipts);
  const intent = appendPortableHandoffReceipt({
    ...common,
    kind: "restored-start",
    outcome: "intent",
    ...(previous === undefined ? {} : { previousSha256: previous }),
  });
  const completed = appendPortableHandoffReceipt({
    ...common,
    kind: "restored-start",
    outcome: "completed",
    previousSha256: intent.sha256,
  });
  return [...context.receipts, intent.receipt, completed.receipt];
}

function restoredIdentityMatches(
  context: RecoveryContext,
  current: UpdateStartupRecoveryCurrent,
): boolean {
  return (
    current.pid === process.pid &&
    current.launchId === context.plan.restoreLaunchId &&
    loopbackHost(current.host) &&
    current.port === context.plan.oldProcess.port &&
    current.version === context.plan.oldProcess.version
  );
}

function loopbackHost(host: string): boolean {
  return host === "127.0.0.1";
}

function appendRestoredVerification(
  options: UpdateStartupRecoveryOptions,
  context: RecoveryContext,
): readonly PortableHandoffReceipt[] {
  const common = {
    stateDir: options.stateDir,
    activationId: context.wal.activationId,
    planSha256: context.wal.planSha256,
    at: options.now?.() ?? Date.now(),
  };
  const previous = receiptDigest(context.receipts);
  const pending = context.receipts.at(-1);
  if (pending?.kind === "restored-verify" && pending.outcome === "intent") {
    const completed = appendPortableHandoffReceipt({
      ...common,
      kind: "restored-verify",
      outcome: "completed",
      previousSha256: portableHandoffReceiptSha256(pending),
    });
    return [...context.receipts, completed.receipt];
  }
  const intent = appendPortableHandoffReceipt({
    ...common,
    kind: "restored-verify",
    outcome: "intent",
    ...(previous === undefined ? {} : { previousSha256: previous }),
  });
  const completed = appendPortableHandoffReceipt({
    ...common,
    kind: "restored-verify",
    outcome: "completed",
    previousSha256: intent.sha256,
  });
  return [...context.receipts, intent.receipt, completed.receipt];
}

async function reconcileRestored(
  options: UpdateStartupRecoveryOptions,
  context: RecoveryContext,
  current: UpdateStartupRecoveryCurrent,
): Promise<RecoveryResult> {
  if (!restoredIdentityMatches(context, current)) {
    return result("recovery-required", context.sessionId, "interrupted");
  }
  try {
    const nextWal =
      context.effectiveWal.checkpoint === "restored-verified"
        ? context.effectiveWal
        : effectiveWal(context.wal, appendRestoredVerification(options, context));
    if (context.wal.checkpoint !== "restored-verified") {
      await options.persistActivation({
        sessionId: context.sessionId,
        activationWal: nextWal,
        phase: "post-listen",
      });
    }
    await options.settleRestored({ sessionId: context.sessionId, activationWal: nextWal });
    return result("ready", context.sessionId);
  } catch {
    return result("recovery-required", context.sessionId, "persistence-failed");
  }
}

function currentIdentityMatches(
  context: RecoveryContext,
  current: UpdateStartupRecoveryCurrent,
): boolean {
  return (
    current.pid === process.pid &&
    current.launchId === context.plan.newLaunchId &&
    current.port === context.plan.oldProcess.port &&
    current.version === context.plan.targetVersion
  );
}

function appendVerification(
  options: UpdateStartupRecoveryOptions,
  context: RecoveryContext,
): readonly PortableHandoffReceipt[] {
  const common = {
    stateDir: options.stateDir,
    activationId: context.wal.activationId,
    planSha256: context.wal.planSha256,
    at: options.now?.() ?? Date.now(),
  };
  const previous = receiptDigest(context.receipts);
  const pending = context.receipts.at(-1);
  if (pending?.kind === "verify" && pending.outcome === "intent") {
    const completed = appendPortableHandoffReceipt({
      ...common,
      kind: "verify",
      outcome: "completed",
      previousSha256: portableHandoffReceiptSha256(pending),
    });
    return [...context.receipts, completed.receipt];
  }
  const intent = appendPortableHandoffReceipt({
    ...common,
    kind: "verify",
    outcome: "intent",
    ...(previous === undefined ? {} : { previousSha256: previous }),
  });
  const completed = appendPortableHandoffReceipt({
    ...common,
    kind: "verify",
    outcome: "completed",
    previousSha256: intent.sha256,
  });
  return [...context.receipts, intent.receipt, completed.receipt];
}

async function reconcileRetainedTarget(
  options: UpdateStartupRecoveryOptions,
  context: RecoveryContext,
  current: UpdateStartupRecoveryCurrent,
): Promise<RecoveryResult> {
  if (
    current.port !== context.plan.oldProcess.port ||
    current.version !== context.plan.targetVersion
  ) {
    return result("recovery-required", context.sessionId, "interrupted");
  }
  const persistenceFailure = await persistIfAdvanced(options, context, "post-listen");
  if (persistenceFailure !== undefined) return persistenceFailure;
  try {
    publishPortableHandoffVerifiedAck({
      stateDir: options.stateDir,
      activationId: context.wal.activationId,
      planSha256: context.wal.planSha256,
    });
    return result("ready", context.sessionId);
  } catch {
    return result("recovery-required", context.sessionId, "persistence-failed");
  }
}

async function reconcilePostListen(
  options: UpdateStartupRecoveryOptions,
  context: RecoveryContext,
  current: UpdateStartupRecoveryCurrent,
): Promise<RecoveryResult> {
  if (!(await activeTreeMatches(options, context))) {
    return result("recovery-required", context.sessionId, "interrupted");
  }
  if (
    context.effectiveWal.checkpoint === "restored-started" ||
    context.effectiveWal.checkpoint === "restored-verified"
  ) {
    return reconcileRestored(options, context, current);
  }
  if (
    context.effectiveWal.checkpoint === "verified" ||
    context.effectiveWal.checkpoint === "cleanup-pending" ||
    context.effectiveWal.checkpoint === "complete"
  ) {
    return reconcileRetainedTarget(options, context, current);
  }
  if (!currentIdentityMatches(context, current)) {
    return result("recovery-required", context.sessionId, "interrupted");
  }
  try {
    const nextWal = effectiveWal(context.wal, appendVerification(options, context));
    await options.persistActivation({
      sessionId: context.sessionId,
      activationWal: nextWal,
      phase: "post-listen",
    });
    publishPortableHandoffVerifiedAck({
      stateDir: options.stateDir,
      activationId: context.wal.activationId,
      planSha256: context.wal.planSha256,
    });
    return result("ready", context.sessionId);
  } catch {
    return result("recovery-required", context.sessionId, "persistence-failed");
  }
}

async function reconcile(
  options: UpdateStartupRecoveryOptions,
  input: {
    readonly phase: "pre-listen" | "post-listen";
    readonly current: UpdateStartupRecoveryCurrent;
  },
): Promise<RecoveryResult> {
  const loaded = loadRecoveryContext(options);
  if (isRecoveryResult(loaded)) return loaded;
  return input.phase === "pre-listen"
    ? reconcilePreListen(options, loaded, input.current)
    : reconcilePostListen(options, loaded, input.current);
}

export function createUpdateStartupRecovery(
  options: UpdateStartupRecoveryOptions,
): UpdateStartupRecoveryPort {
  return { reconcile: (input) => reconcile(options, input) };
}
