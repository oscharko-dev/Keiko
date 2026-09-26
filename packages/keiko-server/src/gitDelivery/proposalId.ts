import { randomBytes } from "node:crypto";

/**
 * The exact three prefixes the server's git-delivery pipeline mints for proposals that a model
 * redeems through keiko_git_execute (packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts):
 * - "stage": RuntimeGitService.buildStageProposal (runtimeGitService.ts)
 * - "commit": VerifiedCommitService's binding (verifiedCommitService.ts)
 * - "delivery": DraftDeliveryService's push/pull-request proposals, minted via
 *   draftDeliveryId("delivery") (draftDeliveryFacts.ts)
 *
 * This list is the single source of truth: keiko_git_execute's proposalId pattern is derived
 * from it (see proposalIdPattern below) instead of being hand-typed a second time.
 */
export const PROPOSAL_ID_PREFIXES = ["stage", "delivery", "commit"] as const;
export type ProposalIdPrefix = (typeof PROPOSAL_ID_PREFIXES)[number];

/**
 * The regex source keiko_git_execute's proposalId field must accept. Derived from
 * PROPOSAL_ID_PREFIXES so the model-visible schema can never drift from the prefixes the server
 * actually mints without both sides changing together.
 */
export function proposalIdPattern(): string {
  return `^(?:${PROPOSAL_ID_PREFIXES.join("|")})-[0-9]{1,39}$`;
}

/**
 * Mints a proposal-shaped id: `<prefix>-<128-bit random value as decimal>`. Shared by the three
 * model-visible minters above and by draftDeliveryFacts.ts's "recovery" id, which reuses the same
 * shape but is never redeemed through keiko_git_execute.
 */
export function mintProposalId(prefix: ProposalIdPrefix | "recovery"): string {
  const randomHex = randomBytes(16).toString("hex");
  return `${prefix}-${BigInt("0x" + randomHex).toString(10)}`;
}
