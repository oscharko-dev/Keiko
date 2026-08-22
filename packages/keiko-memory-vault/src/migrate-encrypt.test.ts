// Regression tests for the `store.encryption-migrated` activity-log event (w4a-memory-vault-fingerprint,
// epic #3233 §8/g19). Before this change `encryptExistingContent` re-sealed plaintext content
// completely silently — an operator had no way to see, from `server.log`, that a vault had just
// undergone the one-way v1 -> v2 encryption sweep.
//
// The event fires only on a REAL transition (at least one row was actually sealed this call), never
// on a fresh empty DB or a re-run over already-sealed content — both sweep zero rows.

import { afterEach, describe, expect, it, vi } from "vitest";

import { insertMemoryRow } from "./memories.js";
import { encryptExistingContent } from "./migrate-encrypt.js";
import { makeRecord, memId, openTestDb, TEST_CIPHER } from "./_support.js";
import type { MemoryVaultLogEvent, MemoryVaultLogSink } from "./vault-log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function recordingSink(): { sink: MemoryVaultLogSink; events: MemoryVaultLogEvent[] } {
  const events: MemoryVaultLogEvent[] = [];
  return {
    sink: {
      write: (event): void => {
        events.push(event);
      },
    },
    events,
  };
}

// Bypasses the row layer's own seal step so the column holds genuine plaintext, mirroring how
// `encryption-at-rest.test.ts`'s `downgradeToLegacyPlaintext` simulates a pre-migration DB.
function overwriteBodyWithPlaintext(
  db: ReturnType<typeof openTestDb>,
  id: string,
  body: string,
): void {
  db.prepare("UPDATE memories SET body = ? WHERE id = ?").run(body, id);
}

describe("encryptExistingContent — store.encryption-migrated event", () => {
  it("does not emit on a fresh DB with no rows to migrate", () => {
    const db = openTestDb();
    const { sink, events } = recordingSink();

    encryptExistingContent(db, TEST_CIPHER, sink);

    expect(events).toHaveLength(0);
    db.close();
  });

  // RED (before fix): encryptExistingContent had no sink parameter at all, so this migration was
  // unobservable from the activity log.
  it("emits exactly one event, with fromScope/toScope/durationMs, when content is re-sealed", () => {
    const db = openTestDb();
    insertMemoryRow(db, makeRecord({ id: memId("m1") }), TEST_CIPHER);
    overwriteBodyWithPlaintext(db, "m1", "plaintext body");
    const { sink, events } = recordingSink();

    encryptExistingContent(db, TEST_CIPHER, sink);

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toMatchObject({
      category: "diagnostic",
      op: "store.encryption-migrated",
    });
    expect(event?.extra).toMatchObject({ fromScope: "plaintext", toScope: "encrypted" });
    const rowsMigrated = (event?.extra as { rowsMigrated?: unknown } | undefined)?.rowsMigrated;
    expect(typeof rowsMigrated).toBe("number");
    expect(rowsMigrated as number).toBeGreaterThanOrEqual(1);
    expect(typeof event?.durationMs).toBe("number");

    const row = db.prepare("SELECT body FROM memories WHERE id = ?").get("m1") as {
      readonly body: string;
    };
    expect(TEST_CIPHER.isSealed(row.body)).toBe(true);
    expect(TEST_CIPHER.openString(row.body)).toBe("plaintext body");
    db.close();
  });

  it("is idempotent: a sweep over already-sealed content emits nothing", () => {
    const db = openTestDb();
    insertMemoryRow(db, makeRecord({ id: memId("m1") }), TEST_CIPHER);
    overwriteBodyWithPlaintext(db, "m1", "plaintext body");
    encryptExistingContent(db, TEST_CIPHER); // first sweep, no sink — must not throw either.

    const { sink, events } = recordingSink();
    encryptExistingContent(db, TEST_CIPHER, sink);

    expect(events).toHaveLength(0);
    db.close();
  });

  it("never throws when no sink is supplied", () => {
    const db = openTestDb();
    insertMemoryRow(db, makeRecord({ id: memId("m1") }), TEST_CIPHER);
    overwriteBodyWithPlaintext(db, "m1", "plaintext body");

    expect(() => {
      encryptExistingContent(db, TEST_CIPHER);
    }).not.toThrow();
    db.close();
  });

  // The migration itself must never fail because its OWN logging failed — the same rule
  // `vault-log.test.ts` proves for the seam in isolation, pinned again here at the real call site.
  it("never lets a throwing sink surface as a migration failure", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const db = openTestDb();
    insertMemoryRow(db, makeRecord({ id: memId("m1") }), TEST_CIPHER);
    overwriteBodyWithPlaintext(db, "m1", "plaintext body");
    const dead: MemoryVaultLogSink = {
      write: (): never => {
        throw new Error("sink is down");
      },
    };

    expect(() => {
      encryptExistingContent(db, TEST_CIPHER, dead);
    }).not.toThrow();
    const row = db.prepare("SELECT body FROM memories WHERE id = ?").get("m1") as {
      readonly body: string;
    };
    expect(TEST_CIPHER.isSealed(row.body)).toBe(true);
    db.close();
  });
});
