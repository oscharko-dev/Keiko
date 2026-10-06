import type { CodingWorkbenchAuthorityEnvelope } from "@oscharko-dev/keiko-contracts";

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
  readonly chargeMaterializedPatch?: ((patchBytes: number) => boolean) | undefined;
  readonly binding?: CodingToolProducerBinding | undefined;
}

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
