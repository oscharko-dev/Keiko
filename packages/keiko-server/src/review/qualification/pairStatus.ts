// The status of a review model pair (ADR-0182 D8, Issue #4137). A status belongs to exactly one
// pair: the Reviewer model, the Counter-checker model and the gateway configuration generation it
// was measured under. A different model in either role, or a configuration change that advances the
// generation, reads `unmeasured` until that pair is qualified itself; nothing carries over. The
// generation is process-local, so a server restart also starts every pair at `unmeasured` again.
// Live counters (`collecting`, `measured-*`, Issue #4141) are recorded beside these by that child.

import type {
  ReviewPairStatusView,
  ReviewSeedScore,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

/** Records kept; the oldest pair is forgotten first. */
const MAX_PAIR_RECORDS = 64;

export interface ReviewPairIdentity {
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
  readonly generation: number | undefined;
}

export interface ReviewPairStatusRecord {
  readonly status: "seed-qualified" | "seed-failed";
  readonly qualificationId: string;
  readonly recordedAt: string;
  readonly score: ReviewSeedScore;
}

function pairKey(pair: ReviewPairIdentity): string {
  return JSON.stringify([
    pair.reviewerModelId,
    pair.counterCheckerModelId,
    pair.generation ?? null,
  ]);
}

export class ReviewPairStatusRegistry {
  private readonly records = new Map<string, ReviewPairStatusRecord>();

  public record(pair: ReviewPairIdentity, record: ReviewPairStatusRecord): void {
    const key = pairKey(pair);
    this.records.delete(key);
    this.records.set(key, record);
    while (this.records.size > MAX_PAIR_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  /** The status of exactly this pair at this generation; `unmeasured` when none was recorded. */
  public status(pair: ReviewPairIdentity): ReviewPairStatusView {
    const record = this.records.get(pairKey(pair));
    if (record === undefined) return { status: "unmeasured" };
    return {
      status: record.status,
      qualificationId: record.qualificationId,
      recordedAt: record.recordedAt,
      score: record.score,
    };
  }
}
