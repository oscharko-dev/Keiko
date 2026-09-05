import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  createGitJourneyOutcomeStore,
  produceJourneyOutcome,
} from "../gitDelivery/journeyOutcome.js";
import { journeyFixture } from "../gitDelivery/journeyOutcomeTest/_support.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import { MIGRATIONS, runMigrations } from "./schema.js";

// Exact V27 table shipped in 9219079e, before its in-place rewrite in 799c4900.
const ORIGINAL_V27 = `CREATE TABLE git_journey_outcomes (
  remote_digest TEXT NOT NULL CHECK (length(remote_digest) = 64),
  pr_number INTEGER NOT NULL CHECK (pr_number BETWEEN 1 AND 1000000000),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (length(state) BETWEEN 1 AND 64),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 64),
  observed_at TEXT NOT NULL,
  outcome_json TEXT NOT NULL CHECK (length(outcome_json) <= 8192 AND json_valid(outcome_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (remote_digest, pr_number)
) STRICT;`;

function legacyDatabase(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    db.exec(migration.version === 27 ? ORIGINAL_V27 : migration.sql);
    migration.apply?.(db);
  }
  db.exec(`PRAGMA user_version = ${String(version)}`);
  return db;
}

function seedLegacy(db: DatabaseSync): ReturnType<typeof produceJourneyOutcome> {
  const outcome = produceJourneyOutcome(journeyFixture());
  const { remoteDigest, prNumber, runId } = outcome.binding;
  db.prepare("INSERT INTO git_journey_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    remoteDigest,
    prNumber,
    runId,
    7,
    outcome.state,
    outcome.reason,
    outcome.observedAt,
    JSON.stringify(outcome),
    outcome.observedAt,
  );
  return outcome;
}

describe("V32 upgrades the original journey outcome table", () => {
  it("keeps an already-upgraded projection unchanged", () => {
    const db = new DatabaseSync(":memory:");
    try {
      runMigrations(db);
      const outcome = produceJourneyOutcome(journeyFixture());
      const store = createGitJourneyOutcomeStore(db);
      expect(store.record(outcome)).toBe(true);
      const previous = store.get(outcome.binding.remoteDigest, outcome.binding.prNumber);
      db.exec("PRAGMA user_version = 31");
      runMigrations(db);
      expect(store.get(outcome.binding.remoteDigest, outcome.binding.prNumber)).toEqual(previous);
    } finally {
      db.close();
    }
  });

  it("rolls back rather than blessing a mismatched legacy projection", () => {
    const db = legacyDatabase(31);
    try {
      seedLegacy(db);
      db.exec("UPDATE git_journey_outcomes SET run_id = 'different-run'");
      expect(() => runMigrations(db)).toThrow("Legacy journey projection mismatch");
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(31);
      expect(db.prepare("SELECT COUNT(*) AS count FROM git_journey_outcomes").get()?.count).toBe(1);
      expect(db.prepare("PRAGMA table_info(git_journey_outcomes_v32)").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("logs only migration version, stage and row count through the existing activity sink", () => {
    const db = legacyDatabase(31);
    const write = vi.spyOn(processServerLogSink(), "write").mockImplementation(() => undefined);
    try {
      const outcome = seedLegacy(db);
      runMigrations(db);
      expect(write).toHaveBeenCalledWith({
        category: "setup",
        op: "store.journey-outcomes.migration",
        correlationId: UNKNOWN_CORRELATION_ID,
        extra: { storeSchemaVersion: 32, stage: "prepared", migratedCount: 1 },
      });
      expect(JSON.stringify(write.mock.calls)).not.toContain(outcome.binding.repository);
    } finally {
      write.mockRestore();
      db.close();
    }
  });

  it.each([27, 29, 31])(
    "preserves the original v%i projection and CAS after upgrade",
    (version) => {
      const db = legacyDatabase(version);
      try {
        const outcome = seedLegacy(db);
        runMigrations(db);
        const store = createGitJourneyOutcomeStore(db);
        expect(store.get(outcome.binding.remoteDigest, outcome.binding.prNumber)).toMatchObject({
          revision: 7,
          headSha: outcome.binding.headSha,
          evidenceRef: outcome.evidenceRef,
          observedAt: outcome.observedAt,
        });
        expect(store.record(outcome)).toBe(false);
        const newer = {
          ...outcome,
          observedAt: new Date(Date.parse(outcome.observedAt) + 1).toISOString(),
        };
        expect(store.record(newer)).toBe(true);
        expect(store.get(outcome.binding.remoteDigest, outcome.binding.prNumber)?.revision).toBe(8);
        const columns = db.prepare("PRAGMA table_info(git_journey_outcomes)").all();
        expect(columns.map((column) => column.name)).not.toContain("outcome_json");
        runMigrations(db);
        expect(store.get(outcome.binding.remoteDigest, outcome.binding.prNumber)?.revision).toBe(8);
      } finally {
        db.close();
      }
    },
  );
});
