import type { GitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { GitJourneyReadTarget } from "./git-journey-read-argv.js";

export type GitJourneyFacts =
  import("@oscharko-dev/keiko-contracts/runtime/git-journey-outcome").GitJourneyRemoteFacts;
export type GitJourneyHeader = Omit<
  GitJourneyFacts,
  "status" | "reviewConversations" | "factsDigest"
>;
export type GitJourneyFactsResult =
  | GitJourneyFacts
  | { readonly status: "unavailable"; readonly failure: GitDeliveryObservationFailure };
export interface GitJourneyReader {
  readJourney(target: GitJourneyReadTarget): Promise<GitJourneyFactsResult>;
}
export interface GitJourneyPage {
  readonly header: GitJourneyHeader;
  readonly threads: readonly { readonly id: string; readonly isResolved: boolean }[];
  readonly total: number;
  readonly hasNextPage: boolean;
  readonly cursor: string | null;
}
