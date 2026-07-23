export interface CodingRuntimePermissionDecision {
  readonly runId: string;
  readonly requestId: string;
  readonly decision: "approved" | "denied";
}

/**
 * Resolves a permission held by the managed runtime itself. Returning false means the exact
 * pending request could not be proven and settled; callers must fail closed and stop the run.
 */
export interface CodingRuntimePermissionPort {
  readonly resolve: (request: CodingRuntimePermissionDecision) => Promise<boolean>;
}
