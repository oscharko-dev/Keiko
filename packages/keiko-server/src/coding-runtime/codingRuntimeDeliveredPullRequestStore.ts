import type { DatabaseSync } from "node:sqlite";
import type {
  GitDeliveryDeliveredPullRequest,
  GitDeliveryDeliveredPullRequestPort,
  GitDeliveryDeliveredPullRequestScope,
} from "../gitDelivery/runBoundAuthority.js";
import { draftDeliveryFromRow } from "./codingRuntimeDraftDeliveryStore.js";

// #3390: the durable answer to "did a settled run deliver this pull request, and at which head?"
// -- the one fact the post-delivery handoff admission (ready-for-review, merge) rests on once the
// run-bound authority has ended with the run. Read from the run's own draft delivery record, never
// from a provider observation: the record was written by the run that pushed the head, under the
// accepted Authority Envelope whose digest it carries.
//
// Only a run that settled successfully with its draft pull request in place answers. A running run
// is still the sole authority for its own delivery; a failed, cancelled or recovery-required run
// delivered nothing a human should hand off without looking first.
export function createCodingRuntimeDeliveredPullRequestStore(
  db: DatabaseSync,
): GitDeliveryDeliveredPullRequestPort {
  const find = db.prepare(
    `SELECT draft_delivery_record FROM coding_runtime_snapshots
     WHERE state = 'succeeded'
       AND draft_delivery_record IS NOT NULL
       AND json_extract(draft_delivery_record, '$.phase') = 'draft-created'
       AND json_extract(draft_delivery_record, '$.binding.remoteDigest') = ?
       AND json_extract(draft_delivery_record, '$.pullRequest.number') = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
  );
  return {
    current(
      scope: GitDeliveryDeliveredPullRequestScope,
    ): GitDeliveryDeliveredPullRequest | undefined {
      if (!Number.isSafeInteger(scope.prNumber) || scope.prNumber <= 0) return undefined;
      const row = find.get(scope.remoteDigest, scope.prNumber) as
        { draft_delivery_record: string | null } | undefined;
      const record =
        row === undefined ? undefined : draftDeliveryFromRow(row.draft_delivery_record);
      const delivery = record?.draftDelivery;
      if (delivery?.pullRequest === undefined) return undefined;
      return {
        runId: delivery.binding.runId,
        envelopeDigest: delivery.binding.envelopeDigest,
        headSha: delivery.binding.headSha,
      };
    },
  };
}
