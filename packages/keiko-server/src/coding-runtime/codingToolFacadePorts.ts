import type { CodingToolActionRequest, CodingToolResult } from "./codingToolIpc.js";

/** Opaque authority material; only the authoritative admission port may inspect its value. */
export type CodingToolCapability = string;

export interface CodingToolMutationGuard {
  /** Must be called at the final governed mutation/commit boundary. */
  readonly check: () => boolean;
}

export type CodingToolAdmission =
  | { readonly ok: true; readonly mutationGuard: CodingToolMutationGuard }
  | { readonly ok: false; readonly reason?: string | undefined };

export interface CodingToolAuthorityPort {
  readonly admit: (
    capability: CodingToolCapability | undefined,
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
}

export interface CodingToolFacadeInput {
  readonly body: string;
  readonly capability?: CodingToolCapability | undefined;
  readonly headers?: Headers | Readonly<Record<string, string | undefined>> | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface CodingToolFacade {
  readonly execute: (input: CodingToolFacadeInput) => Promise<CodingToolResult>;
}
