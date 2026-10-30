import { createHash, randomBytes } from "node:crypto";

import { EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAdapterKind,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeDelegationUsage,
  VerificationKind,
} from "@oscharko-dev/keiko-contracts";

import type {
  CodingToolEditOutcome,
  CodingToolNativeCall,
  CodingToolNativeEffectAdmission,
  CodingToolNativeEffectFacet,
  CodingToolNativeEffectInput,
  CodingToolNativeCommitProof,
  CodingToolNativeInvocation,
  CodingToolNativeSettlement,
  CodingToolNativeSettlementFacet,
  CodingToolNativeSettlementInput,
  CodingToolNativeVerificationHooks,
  CodingVerificationExecutedObserver,
} from "./codingToolFacadePorts.js";
import type { CodingToolAction, CodingToolResult } from "./codingToolIpc.js";
import { isOpenCodeNativeDeliveryToolName } from "./opencodeNativeDeliveryTools.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";

/**
 * Native OpenCode tool calls execute in the original runtime, outside `execute()`, so the facade's
 * own admission and settlement never see them. Two small owners keep the existing contracts true for
 * them (#3897 review): the live authority and the run's tool-call budget, and the run's effort
 * evidence. Both are bound to the call's own identity so a repeated check or a replayed history
 * read of one call is never counted twice.
 */

/** The authority this module reads: live revalidation plus the one reservation owner. */
type NativeEffectAuthority = Pick<
  CodingRuntimeAuthorityService,
  "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
>;

/** The trusted facts of the run, resolved on every check; a structural subset of the port context. */
interface NativeEffectContext {
  readonly adapterKind: CodingWorkbenchRuntimeAdapterKind;
  readonly liveFacts: CodingWorkbenchRuntimeAuthorityFacts;
  readonly workspaceRoot: string;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly nowIso: string;
  readonly runId?: string | undefined;
}

/** One native tool call is one tool call of the run's budget, whatever its action class. */
const NATIVE_CALL_USAGE: CodingWorkbenchRuntimeDelegationUsage = Object.freeze({
  toolCalls: 1,
  patchBytes: 0,
  promptTokens: 0,
});

/**
 * A proposed edit also spends the run's patch budget (and may not exceed one changeset's cap): the size of the diff the producer computed for
 * it, the measure the mapped path charges for a materialized patch (#3897 review). It rides the same
 * invocation-bound reservation as the tool call, so a repeated check charges neither twice, and a
 * budget it would exceed refuses the edit before the runtime writes anything.
 */
function nativeCallUsage(patchBytes: number | undefined): CodingWorkbenchRuntimeDelegationUsage {
  return patchBytes === undefined || patchBytes === 0
    ? NATIVE_CALL_USAGE
    : { ...NATIVE_CALL_USAGE, patchBytes };
}

/**
 * The reservation identity of one native invocation: the run and the runtime's own session,
 * message and call ids, digested into one bounded word. Two checks of one invocation share it, so
 * the authority's replay ledger answers `authority-replayed` for the second; a child session has
 * its own session id and so its own identity on the same run budget. Inner MCP actions additionally
 * carry a server-minted per-request identity: the producer repeats the enclosing Code Mode call id
 * for different tools and even separate physical reads with identical arguments.
 */
function nativeInvocationIdentity(
  runId: string | undefined,
  invocation: CodingToolNativeInvocation | undefined,
): string | undefined {
  if (runId === undefined || invocation === undefined) return undefined;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        runId,
        invocation.sessionId,
        invocation.messageId,
        invocation.callId,
        ...(invocation.mcpActionDigest === undefined ? [] : [invocation.mcpActionDigest]),
      ]),
      "utf8",
    )
    .digest("hex");
  return `native-invocation-${digest}`;
}

/**
 * Every permission check of a native action takes the same path as a governed tool call. Live
 * authority is revalidated on EVERY check (capability, running run on its tree binding, live
 * facts, expiry), then the envelope must allow the action class, and only then is the invocation's
 * one tool call reserved against the run's budget through the authority's own reservation owner.
 * That owner is also the dedup memory: it keeps one entry per reservation, bounded by the
 * envelope's `maxToolCalls`, dropped with the run's authority record, so no second ledger exists.
 *
 * A check that names no tool invocation (a non-tool evaluation) cannot be recognised when it comes
 * again, so it is charged on its own: the budget can only be spent faster by such checks, never
 * bypassed by them. Nothing is executed here; the runtime performs the effect itself.
 */
export function createCodingToolNativeEffectFacet(
  authority: NativeEffectAuthority,
  context: () => NativeEffectContext,
): CodingToolNativeEffectFacet {
  return {
    admit: (input): CodingToolNativeEffectAdmission =>
      admitNativeEffect(authority, context(), input),
  };
}

function admitNativeEffect(
  authority: NativeEffectAuthority,
  current: NativeEffectContext,
  input: CodingToolNativeEffectInput,
): CodingToolNativeEffectAdmission {
  const live = {
    capability: input.capability,
    adapterKind: current.adapterKind,
    liveFacts: current.liveFacts,
    workspaceRoot: current.workspaceRoot,
    deploymentCeiling: current.deploymentCeiling,
    nowIso: current.nowIso,
  };
  const revalidated = authority.revalidateCapabilityForMutation(live);
  if (!revalidated.ok) return { ok: false, reason: revalidated.reason };
  // A class the envelope does not carry is refused before it can spend a tool call.
  if (!revalidated.envelope.authority.actionClasses.includes(input.actionClass))
    return { ok: false, reason: "action-not-authorized" };
  // One edit is capped at the changeset size the mapped path enforces (`patch-too-large`), checked
  // before the reservation so a refused edit spends neither the tool call nor patch budget.
  if ((input.patchBytes ?? 0) > EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES)
    return { ok: false, reason: "patch-too-large" };
  const identity = nativeInvocationIdentity(current.runId, input.invocation);
  const delegationId = identity ?? `native-${randomBytes(12).toString("hex")}`;
  const reserved = authority.resolveCapabilityForDelegation({
    ...live,
    delegationId,
    idempotencyKey: delegationId,
    usage: nativeCallUsage(input.patchBytes),
  });
  if (reserved.ok) return { ok: true, charge: identity === undefined ? "per-check" : "charged" };
  // The identity is this module's own: a replay of it is the invocation's earlier check, which
  // already reserved the call, and live authority was just revalidated above.
  return identity !== undefined && reserved.reason === "authority-replayed"
    ? { ok: true, charge: "already-charged" }
    : { ok: false, reason: reserved.reason };
}

/** Calls remembered per run; the oldest is forgotten first. A replay only ever reaches recent ones. */
export const NATIVE_SETTLEMENT_MEMORY_MAX = 4_096;

/** The runtime's tool ids that map onto the facade's closed action vocabulary; others have none. */
const NATIVE_TOOL_ACTION_ENTRIES: readonly (readonly [string, CodingToolAction])[] = [
  ["read", "read"],
  ["glob", "discover"],
  ["grep", "search"],
  ["edit", "edit"],
  ["write", "edit"],
  ["patch", "edit"],
  ["shell", "command"],
  ["webfetch", "egress"],
  ["websearch", "egress"],
  ["skill", "skill"],
  ["subagent", "child-agent"],
];
const NATIVE_TOOL_ACTIONS: ReadonlyMap<string, CodingToolAction> = new Map(
  NATIVE_TOOL_ACTION_ENTRIES,
);

function nativeToolAction(tool: string | undefined): CodingToolAction | undefined {
  return tool === undefined ? undefined : NATIVE_TOOL_ACTIONS.get(tool);
}

function nativeCallKey(call: CodingToolNativeCall): string {
  return `${call.messageId}\u0000${call.callId}`;
}

/** A fixed-capacity set that forgets its oldest key first. */
function boundedKeys(capacity: number): {
  readonly has: (key: string) => boolean;
  readonly add: (key: string) => void;
  readonly take: (key: string) => boolean;
} {
  const keys = new Set<string>();
  return {
    has: (key): boolean => keys.has(key),
    add: (key): void => {
      keys.delete(key);
      keys.add(key);
      if (keys.size <= capacity) return;
      const oldest = keys.values().next().value;
      if (oldest !== undefined) keys.delete(oldest);
    },
    take: (key): boolean => keys.delete(key),
  };
}

/**
 * The run's effort evidence for native calls (#3873, #3897 review): each terminal call the original
 * runtime reports is handed to the same `onToolSettled` owner the facade's own calls reach, once per
 * call identity. A call the policy refused ends as `denied` (a refusal, no effect); a failure of the
 * tool itself ends as `failed`; only a completed call counts as a read or an edit. Approval is
 * never a settlement. Verification evidence is deliberately not fed: the governed verification
 * requirement belongs to Keiko's own verifier, which a native run calls only to record the commit
 * proof of a delivery. A Keiko delivery tool is served and settled by the facade itself, so it is
 * not settled again here.
 */
export function createCodingToolNativeSettlementFacet(
  onToolSettled:
    | ((action: CodingToolAction | undefined, status: CodingToolResult["status"]) => void)
    | undefined,
  observers: NativeSettlementObservers = {},
): CodingToolNativeSettlementFacet {
  const refused = boundedKeys(NATIVE_SETTLEMENT_MEMORY_MAX);
  const settled = boundedKeys(NATIVE_SETTLEMENT_MEMORY_MAX);
  const verification = nativeVerificationTracker(observers.verification);
  return {
    refused: (call): void => {
      refused.add(nativeCallKey(call));
    },
    settled: (input): CodingToolNativeSettlement => {
      // A Keiko delivery tool is served by this facade, which settles its every request itself;
      // counting the runtime's report of the same call would count it twice (#3897).
      if (isOpenCodeNativeDeliveryToolName(input.tool)) return "duplicate";
      const key = nativeCallKey(input);
      if (settled.has(key)) return "duplicate";
      settled.add(key);
      const action = nativeToolAction(input.tool);
      const refusedByPolicy = refused.take(key);
      onToolSettled?.(action, nativeToolStatus(input, refusedByPolicy));
      // A native edit the runtime applied is the run's edit like a governed one: it needs a check
      // at its own revision before the run can succeed (#3901). The plan agent's private notes are
      // planning and need none.
      if (action === "edit" && input.state === "succeeded" && input.workspaceEdit !== false)
        observers.observeEditOutcome?.({ kind: "applied" });
      verification.settled(key, input, refusedByPolicy);
      return "counted";
    },
    verificationAdmitted: (call, kind, resources): void => {
      verification.admitted(nativeCallKey(call), kind, resources);
    },
    verificationDenied: (): void => {
      observers.verification?.blocked?.("verification-command-denied");
    },
    unsettledEdit: (): void => {
      observers.observeEditOutcome?.({ kind: "applied" });
    },
  };
}

interface NativeSettlementObservers {
  readonly observeEditOutcome?: ((outcome: CodingToolEditOutcome) => void) | undefined;
  readonly verification?: CodingToolNativeVerificationHooks | undefined;
}

interface PendingNativeVerification {
  readonly kind: VerificationKind;
  readonly resources: readonly string[];
  /** Read at admission: the package scripts the line runs are the ones it was admitted with. */
  readonly credited: readonly VerificationKind[];
  readonly editRevision: number | undefined;
  readonly executed: CodingVerificationExecutedObserver | undefined;
  readonly admittedAtMs: number;
  readonly commitProof: CodingToolNativeCommitProof | undefined;
}

/**
 * A verification command is remembered from its admission (with the edit revision and admission
 * observer the governed verifier captures at the same point) until the runtime reports it. Only a
 * call that actually ran and reported an exit status is evidence: a refused, cancelled or
 * backgrounded one proves nothing either way. A pass also proves the other checks its `&&` line
 * and package scripts ran; a failure is the named check's alone.
 */
function nativeVerificationTracker(hooks: CodingToolNativeVerificationHooks | undefined): {
  readonly admitted: (key: string, kind: VerificationKind, resources?: readonly string[]) => void;
  readonly settled: (
    key: string,
    input: CodingToolNativeSettlementInput,
    refusedByPolicy: boolean,
  ) => void;
} {
  const pending = new Map<string, PendingNativeVerification>();
  return {
    admitted: (key, kind, resources = []): void => {
      if (hooks === undefined) return;
      if (pending.size >= NATIVE_SETTLEMENT_MEMORY_MAX)
        pending.delete(pending.keys().next().value ?? "");
      pending.set(key, {
        kind,
        resources,
        credited: hooks.credited?.(resources, true) ?? [],
        editRevision: hooks.revision?.(),
        executed: hooks.admitted?.(),
        admittedAtMs: Date.now(),
        commitProof: hooks.commitProof?.(),
      });
    },
    settled: (key, input, refusedByPolicy): void => {
      const entry = pending.get(key);
      if (entry === undefined || hooks === undefined) return;
      pending.delete(key);
      if (refusedByPolicy || input.exitCode === undefined) return;
      // The admission saw the line's commands; the finished line shows whether its status is the
      // check's own. A line whose status another command decided proves nothing either way.
      if (input.exitStatusCheck !== entry.kind) return;
      const passed = input.exitCode === 0;
      const durationMs = Math.max(0, Date.now() - entry.admittedAtMs);
      const result = { passed, editRevision: entry.editRevision, durationMs };
      hooks.publish({ ...result, kind: entry.kind, executed: entry.executed });
      const credited = passed ? creditedKinds(hooks, entry, input.ownWorkdir === true) : [];
      entry.commitProof?.settle({
        passed,
        kinds: [entry.kind, ...credited],
        exitCode: input.exitCode,
        durationMs,
      });
      for (const kind of credited) {
        hooks.publish({ ...result, kind, executed: entry.executed, creditedBy: entry.kind });
      }
    },
  };
}

/**
 * A call that named its own working directory ran the scripts of whichever package.json governs
 * that directory, not necessarily the one read at admission: it credits its line's checks alone.
 */
function creditedKinds(
  hooks: CodingToolNativeVerificationHooks,
  entry: PendingNativeVerification,
  ownWorkdir: boolean,
): readonly VerificationKind[] {
  return ownWorkdir ? (hooks.credited?.(entry.resources, false) ?? []) : entry.credited;
}

function nativeToolStatus(
  input: CodingToolNativeSettlementInput,
  refusedByPolicy: boolean,
): CodingToolResult["status"] {
  if (input.state === "succeeded") return "completed";
  return refusedByPolicy ? "denied" : "failed";
}
