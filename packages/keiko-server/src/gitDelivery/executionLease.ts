/**
 * One-use, server-held execution lease. A Git delivery service mints it when it consumes an
 * approval and redeems it by identity from its own private WeakMap. The `kind` tag carries no
 * authority: a lease the service did not mint, including a copy with the same tag, redeems nothing.
 * A lease is never serialized and cannot be reconstructed from serialized values.
 */
export interface GitDeliveryExecutionLease {
  readonly kind: "git-delivery-execution-lease";
}

/** Mints a fresh lease whose identity is the only thing a redeeming service compares. */
export function mintGitDeliveryExecutionLease(): GitDeliveryExecutionLease {
  return Object.freeze({ kind: "git-delivery-execution-lease" });
}
