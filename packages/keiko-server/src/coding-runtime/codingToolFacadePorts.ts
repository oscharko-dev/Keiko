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
export type CodingRuntimeEditOutcomeObserver = (
  runId: string,
  outcome: CodingToolEditOutcome,
) => void;

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
  readonly body: string | Buffer;
  /** Opaque authority material; only the authoritative admission port may inspect its value. */
  readonly capability?: string | undefined;
  readonly headers?: Headers | Readonly<Record<string, string | undefined>> | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface CodingToolFacade {
  readonly execute: (input: CodingToolFacadeInput) => Promise<CodingToolResult>;
}
