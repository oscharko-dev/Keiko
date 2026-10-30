// The display-only stale flag (ADR-0182 D6, Issue #4136): a pull request whose current head is no
// longer the reviewed head shows its review as stale. It never changes a settlement; decisions stay
// bound to the reviewed head. The current head comes from the read-only pull request detail of
// child 3, cached briefly per pull request so list reads do not fan out to the provider.

import type { ReviewServices } from "../services.js";
import type { ReviewRunRow } from "./store.js";

const HEAD_CACHE_MS = 30_000;

interface CachedHead {
  readonly at: number;
  readonly headSha: string | undefined;
}

export class ReviewStaleHeads {
  private readonly cache = new Map<string, CachedHead>();

  public constructor(
    private readonly services: Pick<ReviewServices, "pullRequests">,
    private readonly now: () => number,
  ) {}

  /** Whether the run's pull request moved past the reviewed head; unknown heads are not stale. */
  public async isStale(row: ReviewRunRow, correlationId: string | undefined): Promise<boolean> {
    if (row.targetKind !== "pull-request" || row.pullRequestNumber === null) return false;
    if (row.headSha === null) return false;
    const current = await this.currentHead(
      row.repositoryRoot,
      row.pullRequestNumber,
      correlationId,
    );
    return current !== undefined && current !== row.headSha;
  }

  private async currentHead(
    repositoryRoot: string,
    number: number,
    correlationId: string | undefined,
  ): Promise<string | undefined> {
    const key = `${String(number)}\u0000${repositoryRoot}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && this.now() - cached.at < HEAD_CACHE_MS) return cached.headSha;
    const detail = await this.services.pullRequests.detail(repositoryRoot, number, correlationId);
    const headSha =
      detail.availability === "available" ? detail.pullRequest?.headSha : cached?.headSha;
    this.cache.set(key, { at: this.now(), headSha });
    return headSha;
  }
}
