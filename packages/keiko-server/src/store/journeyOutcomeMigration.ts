import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import { isJourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-validation";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";

const PROJECTION_SQL = `CREATE TABLE git_journey_outcomes_v32 (
  remote_digest TEXT NOT NULL CHECK (length(remote_digest) = 64),
  pr_number INTEGER NOT NULL CHECK (pr_number BETWEEN 1 AND 1000000000),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (length(state) BETWEEN 1 AND 64),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 64),
  head_sha TEXT NOT NULL CHECK (length(head_sha) BETWEEN 7 AND 64),
  evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 128),
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (remote_digest, pr_number)
) STRICT;`;

function legacyOutcome(row: Record<string, SQLOutputValue>): JourneyOutcome {
  if (typeof row.outcome_json !== "string") throw new TypeError("Invalid legacy journey record");
  const value: unknown = JSON.parse(row.outcome_json);
  if (!isJourneyOutcome(value)) throw new TypeError("Invalid legacy journey outcome");
  if (
    value.binding.remoteDigest !== row.remote_digest ||
    value.binding.prNumber !== row.pr_number ||
    value.binding.runId !== row.run_id ||
    value.state !== row.state ||
    value.reason !== row.reason ||
    value.observedAt !== row.observed_at
  )
    throw new TypeError("Legacy journey projection mismatch");
  return value;
}

// V27 briefly shipped two shapes. Upgrade the original blob table forward; the later bounded
// projection already has the final shape and must retain every revision unchanged.
export function migrateJourneyOutcomeProjection(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(git_journey_outcomes)").all();
  if (!columns.some((column) => column.name === "outcome_json")) return;
  db.exec(PROJECTION_SQL);
  const insert = db.prepare(
    "INSERT INTO git_journey_outcomes_v32 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let migratedCount = 0;
  for (const row of db.prepare("SELECT * FROM git_journey_outcomes").iterate()) {
    const outcome = legacyOutcome(row);
    insert.run(
      outcome.binding.remoteDigest,
      outcome.binding.prNumber,
      outcome.binding.runId,
      row.revision ?? null,
      outcome.state,
      outcome.reason,
      outcome.binding.headSha,
      outcome.evidenceRef,
      outcome.observedAt,
      row.updated_at ?? null,
    );
    migratedCount += 1;
  }
  db.exec(
    "DROP TABLE git_journey_outcomes; ALTER TABLE git_journey_outcomes_v32 RENAME TO git_journey_outcomes;",
  );
  processServerLogSink().write({
    category: "setup",
    op: "store.journey-outcomes.migration",
    correlationId: UNKNOWN_CORRELATION_ID,
    extra: { storeSchemaVersion: 32, stage: "prepared", migratedCount },
  });
}
