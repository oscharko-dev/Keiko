import type {
  ActivityLogErrorKind,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchRuntimeFailureCode,
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

/** The run-scoped form the run's orchestration receives an edit outcome in (F5, #3873). */
export type CodingRuntimeEditOutcomeObserver = ((
  runId: string,
  outcome: CodingToolEditOutcome,
) => void) & {
  /** Same ledger revision, read synchronously at an admitted verifier's start. */
  readonly verificationRevision?: ((runId: string) => number | undefined) | undefined;
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

export interface CodingToolFacade {
  readonly execute: (input: CodingToolFacadeInput) => Promise<CodingToolResult>;
  /** Inactive accepted initial acquisition; no model/HTTP dispatch surface. */
  readonly acceptedInitialization?: CodingAcceptedInitializationFacet | undefined;
  /** Inactive private service prerequisite; neither model IPC nor HTTP routes expose it. */
  readonly nativeTextRead?: CodingToolNativeTextReadFacet | undefined;
}
