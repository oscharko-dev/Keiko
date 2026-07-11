import { describe, expect, it } from "vitest";
import {
  PostgresIntakeRepository,
  type PgAdmission,
  type PgClientLike,
  type PgPoolLike,
  type PgQueryResult,
} from "./postgres.js";

function admission(): PgAdmission {
  const at = new Date("2026-07-11T00:00:00Z");
  return {
    groupId: "00000000-0000-4000-8000-000000000001",
    payloadId: "00000000-0000-4000-8000-000000000002",
    receiptId: "00000000-0000-4000-8000-000000000003",
    dedupeKeyId: "dedupe-v1:2026-07-01",
    dedupeHmac: new Uint8Array(32),
    dedupeCandidates: [{ keyId: "dedupe-v1:2026-07-01", hmac: new Uint8Array(32) }],
    canonicalBytes: new TextEncoder().encode("{}"),
    exactBodySha256: "0".repeat(64),
    receiptSecretHash: new Uint8Array(32),
    createdAt: at,
    payloadExpiresAt: new Date(at.getTime() + 7_776_000_000),
    receiptExpiresAt: new Date(at.getTime() + 7_776_000_000),
    dedupeExpiresAt: new Date(at.getTime() + 15_552_000_000),
    openPayloadCount: 10,
    openPayloadBytes: 10_000,
    storageDeadlineMs: 5_000,
  };
}

class FakeClient implements PgClientLike {
  readonly calls: string[] = [];
  released = false;
  failOnce = false;
  query<Row extends object>(text: string): Promise<PgQueryResult<Row>> {
    this.calls.push(text);
    if (this.failOnce && text.startsWith("SELECT pg_advisory")) {
      this.failOnce = false;
      return Promise.reject(Object.assign(new Error("retry"), { code: "40001" }));
    }
    if (text.startsWith("SELECT count"))
      return Promise.resolve({ rows: [{ count: "0", bytes: "0" } as Row], rowCount: 1 });
    if (text.startsWith("SELECT id FROM feedback_semantic_groups"))
      return Promise.resolve({ rows: [], rowCount: 0 });
    if (text.includes("feedback_semantic_groups") && text.includes("RETURNING id"))
      return Promise.resolve({ rows: [{ id: admission().groupId } as Row], rowCount: 1 });
    if (text.startsWith("SELECT id, expires_at FROM feedback_payloads"))
      return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({ rows: [{} as Row], rowCount: 1 });
  }
  release(): void {
    this.released = true;
  }
}

describe("PostgreSQL intake repository", () => {
  it("returns both bounded live-key classes from one transaction snapshot", async () => {
    const observed: { readonly text: string; readonly values: readonly unknown[] }[] = [];
    const now = new Date("2026-07-11T12:00:00Z");
    let connects = 0;
    const client: PgClientLike = {
      query: <Row extends object>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<PgQueryResult<Row>> => {
        observed.push({ text, values });
        const keyIds = text.includes("feedback_abuse_buckets")
          ? ["2026-07-10", "2026-07-11"]
          : text.includes("feedback_dedupe_entries")
            ? ["dedupe-v1:2026-04-02", "dedupe-v1:2026-07-01"]
            : [];
        const rows = text.startsWith("SELECT DISTINCT")
          ? keyIds.map((key_id) => ({ key_id }) as Row)
          : [];
        return Promise.resolve({ rows, rowCount: rows.length });
      },
      release: () => undefined,
    };
    const repository = new PostgresIntakeRepository({
      connect: (): Promise<PgClientLike> => {
        connects += 1;
        return Promise.resolve(client);
      },
    });

    await expect(repository.liveKeyIdsSnapshot(now)).resolves.toEqual({
      abuse: ["2026-07-10", "2026-07-11"],
      dedupe: ["dedupe-v1:2026-04-02", "dedupe-v1:2026-07-01"],
    });
    expect(connects).toBe(1);
    expect(observed.map((item) => item.text)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "SELECT set_config('statement_timeout', $1::text, true)",
      "SELECT DISTINCT key_id FROM feedback_abuse_buckets WHERE expires_at > $1 ORDER BY key_id LIMIT $2",
      "SELECT DISTINCT dedupe_key_id AS key_id FROM feedback_dedupe_entries WHERE expires_at > $1 ORDER BY dedupe_key_id LIMIT $2",
      "COMMIT",
    ]);
    expect(observed[2]?.values).toEqual([now, 3]);
    expect(observed[3]?.values).toEqual([now, 4]);
  });

  it("purges only destroyed key evidence at the 365-day boundary and watermarks it", async () => {
    const observed: { readonly text: string; readonly values: readonly unknown[] }[] = [];
    const now = new Date("2027-07-11T00:00:00.000Z");
    const client: PgClientLike = {
      query: <Row extends object>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<PgQueryResult<Row>> => {
        observed.push({ text, values });
        const deleted = text.startsWith("DELETE FROM feedback_key_deletion_evidence");
        return Promise.resolve({ rows: [], rowCount: deleted ? 1 : 0 });
      },
      release: () => undefined,
    };
    const repository = new PostgresIntakeRepository({
      connect: (): Promise<PgClientLike> => Promise.resolve(client),
    });

    await expect(repository.purge(now)).resolves.toEqual([0, 0, 0, 0, 0, 1]);
    const evidencePurge = observed.find((item) =>
      item.text.startsWith("DELETE FROM feedback_key_deletion_evidence"),
    );
    expect(evidencePurge).toEqual({
      text: "DELETE FROM feedback_key_deletion_evidence WHERE result = 'destroyed' AND event_at <= $1 - interval '365 days'",
      values: [now],
    });
    expect(
      observed.some(
        (item) =>
          item.text.startsWith("INSERT INTO feedback_deletion_ledger") &&
          item.values[0] === "key-destruction-evidence" &&
          item.values[2] === 1,
      ),
    ).toBe(true);
  });

  it("persists and completes content-free key-deletion evidence idempotently", async () => {
    const observed: { readonly text: string; readonly values: readonly unknown[] }[] = [];
    const timestamp = new Date("2026-07-11T00:00:00Z");
    let storedResult: "pending" | "destroyed" | undefined;
    const client: PgClientLike = {
      query: <Row extends object>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<PgQueryResult<Row>> => {
        observed.push({ text, values });
        const rows = text.startsWith("SELECT key_class")
          ? ([
              {
                key_class: "dedupe",
                key_id: "dedupe-v1:2026-01-02",
                event_at: timestamp,
                result: "pending",
              },
            ] as Row[])
          : text.includes("INSERT INTO feedback_key")
            ? storedResult === "destroyed"
              ? []
              : ([{ result: (storedResult ??= "pending") }] as Row[])
            : text.includes("UPDATE feedback_key")
              ? ([{ result: (storedResult = "destroyed") }] as Row[])
              : [];
        return Promise.resolve({ rows, rowCount: rows.length });
      },
      release: () => undefined,
    };
    const repository = new PostgresIntakeRepository({
      connect: (): Promise<PgClientLike> => Promise.resolve(client),
    });
    const pending = {
      keyClass: "dedupe" as const,
      keyId: "dedupe-v1:2026-01-02",
      timestamp,
      result: "pending" as const,
    };

    await repository.beginDeletion(pending);
    await repository.beginDeletion(pending);
    await expect(repository.pendingDeletions("dedupe")).resolves.toEqual([pending]);
    await repository.completeDeletion({ ...pending, result: "destroyed" });
    await repository.completeDeletion({ ...pending, result: "destroyed" });
    await expect(repository.beginDeletion(pending)).rejects.toThrow("evidence is unavailable");

    const begins = observed.filter((item) => item.text.includes("INSERT INTO feedback_key"));
    expect(begins).toHaveLength(3);
    expect(
      begins.every(
        (item) =>
          JSON.stringify(item.values) ===
          JSON.stringify(["dedupe", pending.keyId, timestamp, "pending"]),
      ),
    ).toBe(true);
    const completions = observed.filter((item) => item.text.includes("UPDATE feedback_key"));
    expect(completions).toHaveLength(2);
    expect(
      completions.every(
        (item) =>
          JSON.stringify(item.values) ===
          JSON.stringify(["dedupe", pending.keyId, timestamp, "destroyed"]),
      ),
    ).toBe(true);
  });

  it("uses one checked-out client for an explicit serializable transaction", async () => {
    const client = new FakeClient();
    let connects = 0;
    const pool: PgPoolLike = {
      connect: () => {
        connects += 1;
        return Promise.resolve(client);
      },
    };
    await expect(new PostgresIntakeRepository(pool).admit(admission())).resolves.toEqual({
      accepted: true,
      payloadId: admission().payloadId,
    });
    expect(connects).toBe(1);
    expect(client.calls[0]).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(client.calls.at(-1)).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("rolls back, releases, and retries bounded serialization failures", async () => {
    const first = new FakeClient();
    first.failOnce = true;
    const second = new FakeClient();
    const clients = [first, second];
    const pool: PgPoolLike = { connect: () => Promise.resolve(clients.shift() ?? second) };
    await expect(new PostgresIntakeRepository(pool, 2).admit(admission())).resolves.toMatchObject({
      accepted: true,
    });
    expect(first.calls).toContain("ROLLBACK");
    expect(first.released).toBe(true);
    expect(second.calls).toContain("COMMIT");
  });

  it.each([
    ["count", { count: "10", bytes: "0" }],
    ["bytes", { count: "0", bytes: "10000" }],
  ] as const)(
    "rejects duplicate and unique admissions before %s-capacity dedupe",
    async (_, usage) => {
      const results = await Promise.all(
        [true, false].map(async (duplicate) => {
          const client = new FakeClient();
          const baseQuery = client.query.bind(client);
          client.query = <Row extends object>(text: string): Promise<PgQueryResult<Row>> => {
            if (text.startsWith("SELECT count")) {
              client.calls.push(text);
              return Promise.resolve({ rows: [usage as Row], rowCount: 1 });
            }
            if (text.startsWith("SELECT semantic_group_id")) {
              client.calls.push(text);
              return Promise.resolve({
                rows: duplicate ? ([{ semantic_group_id: admission().groupId }] as Row[]) : [],
                rowCount: duplicate ? 1 : 0,
              });
            }
            return baseQuery<Row>(text);
          };
          const repository = new PostgresIntakeRepository({
            connect: (): Promise<PgClientLike> => Promise.resolve(client),
          });
          const result = await repository.admit(admission());
          return { result, calls: client.calls };
        }),
      );

      expect(results.map(({ result }) => result)).toEqual([
        { accepted: false, reason: "capacity" },
        { accepted: false, reason: "capacity" },
      ]);
      expect(
        results.every(
          ({ calls }) => !calls.some((call) => call.startsWith("SELECT semantic_group_id")),
        ),
      ).toBe(true);
    },
  );

  it("releases a client that arrives after the acquisition deadline", async () => {
    let resolveClient: ((client: PgClientLike) => void) | undefined;
    const delayed = new Promise<PgClientLike>((resolve) => {
      resolveClient = resolve;
    });
    const client = new FakeClient();
    const repository = new PostgresIntakeRepository(
      { connect: (): Promise<PgClientLike> => delayed },
      1,
      10,
    );

    await expect(repository.findReceipt("A".repeat(22))).rejects.toThrow("acquisition deadline");
    resolveClient?.(client);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.released).toBe(true);
    expect(client.calls).toEqual([]);
  });
});
