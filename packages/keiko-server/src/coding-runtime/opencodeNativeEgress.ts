/** The kernel egress a native runtime tree is launched with (#3897). */
export type OpenCodeNativeEgress = "inherited" | "loopback-only";

/**
 * Full access keeps inherited egress, bounded by its Authority Envelope and the per-action policy;
 * every narrower mode reaches loopback only. Seatbelt binds the profile when the tree execs, so the
 * launch mode's egress holds for the tree's whole lifetime.
 */
export function openCodeNativeEgress(mode: string | undefined): OpenCodeNativeEgress {
  return mode === "autonomous-delivery" ? "inherited" : "loopback-only";
}
