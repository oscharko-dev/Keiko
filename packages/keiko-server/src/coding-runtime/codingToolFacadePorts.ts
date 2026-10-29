import type {
  ActivityLogErrorKind,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchActionClass,
  VerificationKind,
} from "@oscharko-dev/keiko-contracts";

import type {
  CodingToolAction,
  CodingToolActionRequest,
  CodingToolResult,
} from "./codingToolIpc.js";
import type {
  GovernedTextSnapshotResult,
  GovernedNativeFileIO,
  GovernedNativeFileRequest,
} from "./codingToolReadEditPorts.js";
import type { CodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";

export interface CodingToolProducerBinding {
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly workspaceId: string;
  readonly workspaceRootDigest: string;
  readonly expiresAt: string;
}

export interface CodingToolMutationGuard {
  /** Actual catalog invocation clock/deadline, supplied only by server admission. */
  readonly executionBudget?:
    { readonly nowMs: () => number; readonly deadlineAtMs: number } | undefined;
  /** Server-held one-use delivery execution lease, never populated from IPC. */
  readonly deliveryApproval?: object;
  readonly stageApproval?: object;
  /** Must be called at the final governed mutation/commit boundary. */
  readonly check: () => boolean;
  /** Server-private live authority projection for narrower auxiliary composition. */
  readonly resolveParentAuthority?:
    (() => CodingWorkbenchAuthorityEnvelope | undefined) | undefined;
  /** Charges one concrete read-only child call against the parent runtime budget. */
  readonly chargeDelegatedRead?:
    ((delegationId: string, idempotencyKey: string) => boolean) | undefined;
  /** Whether one more delegated read would fit the parent runtime budget; charges nothing. */
  readonly canChargeDelegatedRead?: (() => boolean) | undefined;
  /**
   * Charges the bytes a materialized replacement changeset adds beyond the request payload its
   * admission reserved, against the same run budget, before the editor applies it (#3873 review:
   * the envelope's patch budget bounds what is applied). Absent on a wiring that owns no edit
   * budget, which then charges nothing here, as its admission charged nothing.
   */
  readonly chargeMaterializedPatch?: ((patchBytes: number) => MaterializedPatchCharge) | undefined;
  readonly binding?: CodingToolProducerBinding | undefined;
}

/**
 * The answer to one materialized-patch charge: accepted, or refused with the authority's closed
 * reason, so a refusal that is not an exhausted budget is never reported as one (#3873 review).
 */
export type MaterializedPatchCharge =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CodingWorkbenchRuntimeFailureCode };

export type CodingToolAdmission =
  | {
      readonly ok: true;
      readonly mutationGuard: CodingToolMutationGuard;
      readonly binding?: CodingToolProducerBinding | undefined;
    }
  | { readonly ok: false; readonly reason?: string | undefined };

export interface CodingToolAuthorityPort {
  readonly admit: (
    /** Opaque authority material; only the authoritative admission port may inspect its value. */
    capability: string | undefined,
    request: CodingToolActionRequest,
  ) => CodingToolAdmission;
}

export interface CodingToolDelegatePort {
  readonly execute: (
    request: CodingToolActionRequest,
    signal: AbortSignal | undefined,
    mutationGuard: CodingToolMutationGuard,
  ) => Promise<unknown>;
}

export interface CodingToolFacadePorts {
  readonly authority: CodingToolAuthorityPort;
  readonly delegate: CodingToolDelegatePort;
}

/**
 * Why the edit port refused an edit before the editor route saw it (`EDIT_PREPARE_FAILED`): one
 * closed word per preparation step. The model-facing code stays `EDIT_PREPARE_FAILED` for every one
 * of them; the cause is what tells a refusal the model can repair from one it cannot (F5, #3873
 * review), and `coding-runtime.edit.refused` records it beside the code.
 */
export const EDIT_PREPARE_CAUSES = [
  "workspace-access-lost",
  "cancelled",
  "guard-denied",
  "changeset-invalid",
  "binding-unavailable",
  "editor-context-unavailable",
  "lease-unavailable",
  // #3873: the governed read a replacement edit is materialized against did not answer.
  "replacement-read-failed",
] as const;
export type EditPrepareCause = (typeof EDIT_PREPARE_CAUSES)[number];

/**
 * Why the governed read a replacement edit is materialized against did not answer: the secure read's
 * own closed reasons plus the refusals of the governed read path that serves it. The edit port names
 * the type (`GovernedWorkspaceReadFailure`); this is its runtime vocabulary, so the refusal line, the
 * facade and the run's refusal escalation all admit exactly these words.
 */
export const EDIT_READ_REASONS = [
  "unsupported-platform",
  "workspace-unavailable",
  "artifact-unverified",
  "busy",
  "cancelled",
  "timeout",
  "process-failed",
  "protocol-invalid",
  "denied",
  "not-found",
  "not-text",
  "too-large",
  "unstable",
  "exception",
  "postflight-refused",
  "preflight-refused",
  "response-too-large",
] as const;
export type EditReadReason = (typeof EDIT_READ_REASONS)[number];

/**
 * The error class `coding-runtime.edit.refused` records for each preparation cause. The run's refusal
 * escalation classifies the same refusal with the same table, so the refusal lines, the escalation
 * and the settlement name one failure alike.
 */
export const EDIT_PREPARE_ERROR_KINDS: Readonly<Record<EditPrepareCause, ActivityLogErrorKind>> = {
  "workspace-access-lost": "authority-denied",
  cancelled: "cancelled",
  "guard-denied": "authority-denied",
  "changeset-invalid": "validation-failed",
  "binding-unavailable": "authority-denied",
  "editor-context-unavailable": "unavailable",
  "lease-unavailable": "conflict",
  "replacement-read-failed": "unavailable",
};

/**
 * What one answered governed edit says, as the model received it (F5, #3873): applied, or refused
 * under the closed reason code the facade forwarded (`UNCLASSIFIED` when it forwarded none). A human
 * decision, a cancellation, a busy or a malformed call is neither and is not reported. A refusal
 * the edit port raised while preparing the edit (`EDIT_PREPARE_FAILED`) also carries the closed
 * preparation cause and, for a failed materialization read, the closed reason of that read: they
 * decide whether the model can repair the refusal, which its code alone cannot say. The model never
 * receives either. Body-free: closed words only, never a path, a message or read text.
 */
export type CodingToolEditOutcome =
  | { readonly kind: "applied" }
  | {
      readonly kind: "refused";
      readonly reasonCode: string;
      readonly prepareCause?: EditPrepareCause | undefined;
      readonly readReason?: EditReadReason | undefined;
    };

/** Actual reasons a governed verifier could not execute, never inferred from model prose. */
export type CodingVerificationBlockedReason =
  | "verification-command-denied"
  | "verification-authority-revoked"
  | "verification-verifier-unsupported"
  | "PROJECT_NOT_FOUND"
  | "WORKSPACE_TRUST_REQUIRED"
  | "NO_RUNNABLE_STEPS"
  | "VERIFICATION_RUNNER_UNAVAILABLE"
  | "VERIFICATION_NOT_RUN";

/** Captured at actual admission; called only after an executed check remains authorized. */
export type CodingVerificationExecutedObserver = (targetDigest: string) => void;

/** The run-scoped form the run's orchestration receives an edit outcome in (F5, #3873). */
export type CodingRuntimeEditOutcomeObserver = ((
  runId: string,
  outcome: CodingToolEditOutcome,
) => void) & {
  /** Same ledger revision, read synchronously at an admitted verifier's start. */
  readonly verificationRevision?: ((runId: string) => number | undefined) | undefined;
  readonly verificationBlocked?:
    | ((runId: string, reason: CodingVerificationBlockedReason, targetDigest?: string) => void)
    | undefined;
  readonly verificationAdmitted?:
    ((runId: string) => CodingVerificationExecutedObserver | undefined) | undefined;
};

export interface CodingToolFacadeOptions {
  readonly maxBodyBytes?: number | undefined;
  readonly maxInFlight?: number | undefined;
  readonly invocationRegistry?: CodingToolInvocationRegistry | undefined;
  readonly requireInvocationRegistryForEdits?: boolean | undefined;
  /**
   * Told of every call the facade answered for the run (#3873 run effort roll-up): the closed action
   * the call named — `undefined` when it named none — and the status of the answer. Never the
   * request or the result. Not told of a cross-origin refusal or a permission observation, which
   * are not the run's tool calls.
   */
  readonly onToolSettled?:
    | ((action: CodingToolAction | undefined, status: CodingToolResult["status"]) => void)
    | undefined;
  /**
   * F5 (#3873): told every applied or refused edit this facade answered, so the run's orchestration
   * can bound consecutive refusals instead of letting the model resend an edit that cannot apply.
   */
  readonly observeEditOutcome?: ((outcome: CodingToolEditOutcome) => void) | undefined;
}

export interface CodingToolFacadeInput {
  /** Server-owned observation at the actual authorized delegate boundary; never decoded from IPC. */
  readonly onDelegateStarted?: (() => void) | undefined;
  readonly body: string | Buffer;
  /** Opaque authority material; only the authoritative admission port may inspect its value. */
  readonly capability?: string | undefined;
  readonly headers?: Headers | Readonly<Record<string, string | undefined>> | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type CodingToolNativeTextSnapshotResult =
  | GovernedTextSnapshotResult
  | {
      readonly ok: false;
      readonly reason: "invalid-request" | "dispatch-refused";
    };

export interface CodingToolNativeTextReadFacet {
  /** Fixed server-only whole-file purpose. Windowed/model requests cannot enter this facet. */
  readonly readTextSnapshot: (
    input: CodingToolFacadeInput,
  ) => Promise<CodingToolNativeTextSnapshotResult>;
  /** Inactive original-read lifetime; neither model JSON nor HTTP exposes this owner. */
  readonly invocations?: CodingToolNativeReadInvocations | undefined;
}

export interface CodingToolNativeReadContext {
  readonly sessionID: string;
  readonly messageID: string;
  readonly id: string;
  readonly agent: string;
}

export interface CodingToolNativeReadBeginInput extends CodingToolFacadeInput {
  readonly context: CodingToolNativeReadContext;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

export interface CodingToolNativeReadIdentity {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly invocationId: string;
}

export interface CodingToolNativeReadFilePacket extends GovernedNativeFileRequest {
  readonly ordinal: number;
}

export interface CodingToolNativeInvocationRefusal {
  readonly ok: false;
  readonly reason: "invalid-request" | "dispatch-refused" | "cancelled" | "busy";
}

export type CodingToolNativeReadBytesResult =
  Awaited<ReturnType<GovernedNativeFileIO["readBytes"]>> | CodingToolNativeInvocationRefusal;
export type CodingToolNativeReadStatResult =
  Awaited<ReturnType<GovernedNativeFileIO["stat"]>> | CodingToolNativeInvocationRefusal;
export type CodingToolNativeReadListResult =
  Awaited<ReturnType<GovernedNativeFileIO["list"]>> | CodingToolNativeInvocationRefusal;

/** Private primitive transport under an already admitted original Read, never a model call. */
export interface CodingToolNativeReadFileIO {
  readonly readBytes: (
    identity: CodingToolNativeReadIdentity,
    input: CodingToolNativeReadFilePacket,
  ) => Promise<CodingToolNativeReadBytesResult>;
  readonly stat: (
    identity: CodingToolNativeReadIdentity,
    input: CodingToolNativeReadFilePacket,
  ) => Promise<CodingToolNativeReadStatResult>;
  readonly list: (
    identity: CodingToolNativeReadIdentity,
    input: CodingToolNativeReadFilePacket,
  ) => Promise<CodingToolNativeReadListResult>;
}

export interface CodingToolNativeReadFileIOOwner {
  readonly readBytes: (
    request: GovernedNativeFileRequest,
  ) => Promise<CodingToolNativeReadBytesResult>;
  readonly stat: (request: GovernedNativeFileRequest) => Promise<CodingToolNativeReadStatResult>;
  readonly list: (request: GovernedNativeFileRequest) => Promise<CodingToolNativeReadListResult>;
}

export type CodingToolNativeReadBeginResult =
  | {
      readonly ok: true;
      readonly identity: CodingToolNativeReadIdentity;
      readonly settled: Promise<void>;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid-request" | "dispatch-refused" | "busy" | "cancelled" | "timeout";
    };

export interface CodingToolNativeReadInvocations {
  readonly fileIO?: CodingToolNativeReadFileIO | undefined;
  readonly signalFor: (identity: CodingToolNativeReadIdentity) => AbortSignal | undefined;
  readonly begin: (
    input: CodingToolNativeReadBeginInput,
  ) => Promise<CodingToolNativeReadBeginResult>;
  readonly readTextSnapshot: (
    identity: CodingToolNativeReadIdentity,
    input: { readonly ordinal: number; readonly relativePath: string },
  ) => Promise<CodingToolNativeTextSnapshotResult>;
  readonly close: (
    identity: CodingToolNativeReadIdentity,
    outcome: "completed" | "failed" | "cancelled",
  ) => Promise<boolean>;
}

/** Attached only by the actual authorized catalog handler, on its existing claimed record. */
export interface CodingToolNativeReadOwner {
  readonly fileIO?: CodingToolNativeReadFileIOOwner | undefined;
  readonly signal: AbortSignal;
  readonly invocationId: string;
  readonly readTextSnapshot: (relativePath: string) => Promise<CodingToolNativeTextSnapshotResult>;
  readonly close: (outcome: "completed" | "failed" | "cancelled") => Promise<boolean>;
  readonly revoke: () => void;
}

/** Server-owned accepted STARTING projection; never populated by a tool or browser request. */
export interface CodingAcceptedInitializationAuthority {
  /** Same accepted-run cancellation owner; an additional veto, never an authority grant. */
  readonly signal: AbortSignal;
  readonly resolve: (signal?: AbortSignal) => CodingToolMutationGuard | undefined;
}

export type CodingAcceptedInitializationRequest = Omit<GovernedNativeFileRequest, "purpose">;

export interface CodingAcceptedInitializationReadPort {
  readonly readBytes: (
    request: CodingAcceptedInitializationRequest,
  ) => ReturnType<GovernedNativeFileIO["readBytes"]>;
  readonly stat: (
    request: CodingAcceptedInitializationRequest,
  ) => ReturnType<GovernedNativeFileIO["stat"]>;
  readonly list: (
    request: CodingAcceptedInitializationRequest,
  ) => ReturnType<GovernedNativeFileIO["list"]>;
}

export type CodingAcceptedInitializationResult<T> =
  // Completion says the callback settled under current authority, not that native sources exist.
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason:
        | "initialization-closed"
        | "initialization-refused"
        | "initialization-failed"
        | "cancelled"
        | "timeout"
        | "busy";
    };

export interface CodingAcceptedInitializationFacet {
  /** One initial acquisition only. Watch refresh cannot reuse this private callback lifetime. */
  readonly run: <T>(
    initialize: (io: CodingAcceptedInitializationReadPort) => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<CodingAcceptedInitializationResult<T>>;
}

/**
 * The original runtime's own identity of one native tool call: the session that ran it, the
 * assistant message it belongs to and its tool call id (the permission request's `source`). One
 * invocation may be asked about several times (an edit and the directory it touches, a repeated
 * evaluation), so this identity is what budget and run evidence are counted by (#3897 review).
 */
export interface CodingToolNativeInvocation {
  readonly sessionId: string;
  readonly messageId: string;
  readonly callId: string;
}

/**
 * One permission check of a native OpenCode action the server-owned policy is about to allow
 * (#3897 review). Every check revalidates live authority: a revoked or expired envelope, a paused
 * run or an action class outside the envelope refuses it before the runtime proceeds. The budget is
 * charged once per `invocation`, whatever its action class, so reads count like every other tool
 * call; a check without a tool invocation (a non-tool evaluation) cannot be recognised again and
 * is charged on its own.
 */
export interface CodingToolNativeEffectInput {
  readonly capability: string;
  readonly actionClass: CodingWorkbenchActionClass;
  readonly invocation?: CodingToolNativeInvocation | undefined;
  /** The UTF-8 size of the producer's diff of a proposed edit, charged to the patch budget. */
  readonly patchBytes?: number | undefined;
}

/**
 * How the admitted check was accounted: `charged` reserved the invocation's tool call,
 * `already-charged` found it reserved by an earlier check of the same invocation, `per-check`
 * reserved one for a check that names no invocation.
 */
export type CodingToolNativeCharge = "charged" | "already-charged" | "per-check";

export type CodingToolNativeEffectAdmission =
  | { readonly ok: true; readonly charge: CodingToolNativeCharge }
  | { readonly ok: false; readonly reason: string };

export interface CodingToolNativeEffectFacet {
  readonly admit: (input: CodingToolNativeEffectInput) => CodingToolNativeEffectAdmission;
}

/** The message and call id a native tool call is known by in the runtime's own history. */
export interface CodingToolNativeCall {
  readonly messageId: string;
  readonly callId: string;
}

/**
 * One native tool call the original runtime reported terminal (`succeeded` or `failed`). `tool` is
 * the runtime's own tool id, absent when it named none; approval, a pending or a running call is
 * never reported here: only execution settles a call.
 */
export interface CodingToolNativeSettlementInput extends CodingToolNativeCall {
  readonly tool?: string | undefined;
  readonly state: "succeeded" | "failed";
  /** A finished native `shell` call's own exit status; absent for every other tool and a job. */
  readonly exitCode?: number | undefined;
  /**
   * The project check that exit status speaks for, read from the call's whole command line; absent
   * when another command of the line could have decided it (`npm test; cd .`).
   */
  readonly exitStatusCheck?: VerificationKind | undefined;
  /**
   * The call ran in a working directory it named itself (`workdir`), not the session's: the
   * package.json read at its admission need not be the one its scripts ran from.
   */
  readonly ownWorkdir?: boolean | undefined;
  /**
   * Whether the call wrote the task workspace, as its admission named it (#3901): `false` for an
   * edit of the run's private plan notes, which is planning, not a change a check must cover.
   * Absent keeps the tool's own meaning: a completed edit tool call is the run's edit.
   */
  readonly workspaceEdit?: boolean | undefined;
}

/** A native verification command's result, as the runtime's own exit status reports it. */
export interface CodingToolNativeVerificationResult {
  readonly kind: VerificationKind;
  readonly passed: boolean;
  /** The run's edit revision when the command was admitted: a pass proves no later edit. */
  readonly editRevision: number | undefined;
  readonly durationMs: number;
  /** The run's admission observer captured with the command; told only after it executed. */
  readonly executed: CodingVerificationExecutedObserver | undefined;
  /**
   * The check whose passing line also proved this one (`openCodeNativeCreditedKinds`); absent for
   * the check the line's exit status is named for.
   */
  readonly creditedBy?: VerificationKind | undefined;
}

/**
 * The run's verification owner as native verification commands reach it (#3897 review, #3901):
 * the same edit revision, admission observer, blocker and summary event the governed verifier
 * uses, so a native edit needs a native check at its own revision before the run can succeed.
 */
export interface CodingToolNativeVerificationHooks {
  readonly revision?: (() => number | undefined) | undefined;
  readonly admitted?: (() => CodingVerificationExecutedObserver | undefined) | undefined;
  readonly blocked?:
    ((reason: CodingVerificationBlockedReason, targetDigest?: string) => void) | undefined;
  readonly publish: (result: CodingToolNativeVerificationResult) => void;
  /**
   * The other checks an admitted line proves when it passes (`openCodeNativeCreditedKinds`), with
   * or without reading the workspace's package scripts.
   */
  readonly credited?:
    | ((resources: readonly string[], readScripts: boolean) => readonly VerificationKind[])
    | undefined;
}

/**
 * `counted` reached the run's effort roll-up; `duplicate` was already counted: the same call seen
 * again, or a Keiko delivery tool the facade served and settled itself.
 */
export type CodingToolNativeSettlement = "counted" | "duplicate";

/**
 * The run evidence of native tool calls, which execute outside `execute()` and so never reach the
 * facade's own settlement (#3873, #3897 review). Fed from the runtime's validated history, it
 * reports each call to the run's effort roll-up exactly once, by call identity, so a repeated
 * history read or a reconnect never counts a call twice.
 */
export interface CodingToolNativeSettlementFacet {
  /** The policy refused or a human denied this call: its terminal failure is a refusal. */
  readonly refused: (call: CodingToolNativeCall) => void;
  readonly settled: (input: CodingToolNativeSettlementInput) => CodingToolNativeSettlement;
  /**
   * The policy admitted this call as a verification command (`openCodeNativeVerificationKind`);
   * `resources` are its admitted command line, from which a pass also credits the other checks it ran.
   */
  readonly verificationAdmitted?:
    | ((call: CodingToolNativeCall, kind: VerificationKind, resources?: readonly string[]) => void)
    | undefined;
  /** A human refused a native verification command: no later pass of an older one clears it. */
  readonly verificationDenied?: (() => void) | undefined;
  /**
   * An admitted workspace edit whose settlement the runtime reports only on a child session, which
   * the run's own history does not carry (#3901): it is the run's edit from its admission.
   */
  readonly unsettledEdit?: (() => void) | undefined;
}

export interface CodingToolFacade {
  readonly execute: (input: CodingToolFacadeInput) => Promise<CodingToolResult>;
  /** Live authority and budget admission for native OpenCode effects; absent wirings refuse them. */
  readonly nativeEffect?: CodingToolNativeEffectFacet | undefined;
  /** Run evidence for native tool calls that executed outside `execute()`; absent counts nothing. */
  readonly nativeSettlement?: CodingToolNativeSettlementFacet | undefined;
  /** Inactive accepted initial acquisition; no model/HTTP dispatch surface. */
  readonly acceptedInitialization?: CodingAcceptedInitializationFacet | undefined;
  /** Inactive private service prerequisite; neither model IPC nor HTTP routes expose it. */
  readonly nativeTextRead?: CodingToolNativeTextReadFacet | undefined;
}
