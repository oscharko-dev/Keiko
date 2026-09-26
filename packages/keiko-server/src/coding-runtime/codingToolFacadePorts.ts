import type { CodingWorkbenchAuthorityEnvelope } from "@oscharko-dev/keiko-contracts";

import type { CodingToolActionRequest, CodingToolResult } from "./codingToolIpc.js";
import type { CodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";

export interface CodingToolProducerBinding {
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly workspaceId: string;
  readonly workspaceRootDigest: string;
  readonly expiresAt: string;
}

export interface CodingToolMutationGuard {
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
}

export interface CodingToolFacadeInput {
  readonly body: string | Buffer;
  /** Opaque authority material; only the authoritative admission port may inspect its value. */
  readonly capability?: string | undefined;
  readonly headers?: Headers | Readonly<Record<string, string | undefined>> | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** What a governed read of an asked file answers for an edit ask's base check (#3612). */
export type CodingToolEditBaseRead =
  | { readonly kind: "digest"; readonly digest: string }
  // The read cannot answer for the file (a new file, a denied path); the editor route checks it.
  | { readonly kind: "unreadable" }
  // The run's live authority does not admit the read: the ask must not reach the human.
  | { readonly kind: "authority-denied" };

export interface CodingToolFacade {
  readonly execute: (input: CodingToolFacadeInput) => Promise<CodingToolResult>;
  /**
   * The digest a governed read of the file reports now (#3612), whether the read cannot answer for
   * it, or whether the run's live authority, for this capability, does not admit the read at all.
   * The governed ask checks a changeset's base digests with it before any human is asked; a facade
   * without it leaves that check to the editor route after the approval.
   */
  readonly editBaseDigest?:
    | ((
        capability: string | undefined,
        relativePath: string,
        signal: AbortSignal,
      ) => Promise<CodingToolEditBaseRead>)
    | undefined;
}
