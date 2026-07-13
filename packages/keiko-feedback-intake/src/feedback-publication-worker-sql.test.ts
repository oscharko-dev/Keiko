import { describe, expect, it } from "vitest";
import {
  appendDeliveryAudit,
  candidateMode,
  claimWorkerCandidate,
  databaseNow,
  exactLeaseValues,
  selectWorkerCandidate,
} from "./feedback-publication-worker-sql.js";
import type { PgClientLike } from "./postgres-types.js";

const AT = new Date("2026-07-12T12:00:00.000Z");
const row = {
  id: "outbox",
  status: "unclaimed",
  target_installation_id: "123",
  create_attempt_count: 0,
};

class Client implements PgClientLike {
  calls = 0;
  query: PgClientLike["query"] = () => {
    this.calls += 1;
    const rows =
      this.calls === 1
        ? [{ database_now: AT }]
        : this.calls === 2
          ? [row]
          : [{ lease_expires_at: new Date(AT.getTime() + 60_000) }];
    return Promise.resolve({ rows: rows as never[], rowCount: 1 });
  };
  release(): void {
    return undefined;
  }
}

describe("feedback publication worker SQL helpers", () => {
  it("uses database time, exact lease bindings, and conservative worker modes", async () => {
    const client = new Client();
    expect(await databaseNow(client)).toEqual(AT);
    expect(await selectWorkerCandidate(client, [], 16)).toEqual(row);
    expect(await claimWorkerCandidate(client, row, "worker", AT, 60_000)).toEqual(
      new Date(AT.getTime() + 60_000),
    );
    await appendDeliveryAudit(client, "outbox", "claimed-create", "leased");
    expect(candidateMode(row)).toBe("create-eligible");
    expect(candidateMode({ ...row, status: "may-have-committed" })).toBe("reconcile-only");
    expect(
      exactLeaseValues({
        outboxId: "o",
        preparationId: "p",
        itemId: "i",
        targetPolicyDigest: "d",
        leaseOwner: "w",
        leaseExpiresAt: AT,
      }),
    ).toEqual(["o", "p", "i", "d", "w", AT]);
  });
});
