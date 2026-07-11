import { describe, expect, it } from "vitest";
import { PostgresFeedbackReviewRepository } from "./feedback-review-store.js";
import { FeedbackReviewError, type FeedbackReviewCommand } from "./feedback-review-types.js";
import type { PgClientLike, PgQueryResult } from "./postgres-types.js";

const ITEM = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const PAYLOAD = new TextEncoder().encode("SENTINEL_REPORT_CONTENT");
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");
const AT = new Date("2026-07-11T12:00:00.000Z");

interface StoredReplay {
  readonly request_digest: string;
  readonly item_id: string;
  readonly result_state: "archived";
  readonly result_version: number;
  readonly result_at: Date;
  readonly restricted_review_group_id: string | null;
}

class ReviewClient implements PgClientLike {
  readonly calls: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  readonly replays = new Map<string, StoredReplay>();
  state: "pending" | "archived" = "pending";
  version = 1;
  released = false;
  payloadExpiresAt = new Date(AT.getTime() + 90 * 86_400_000);
  payloadExactDigest = DIGEST;
  canonicalBytes = PAYLOAD;
  failOnceCode: string | undefined;
  itemAvailable = true;
  targetPrivate = false;
  targetExpired = false;
  targetDrift = false;
  activeHold = false;
  expiredHold = false;

  private replay<Row extends object>(values: readonly unknown[]): PgQueryResult<Row> {
    const replay = this.replays.get(String(values[0]));
    if (replay === undefined) return { rows: [], rowCount: 0 };
    return { rows: [replay as Row], rowCount: 1 };
  }

  private item<Row extends object>(values: readonly unknown[]): PgQueryResult<Row> {
    if (!this.itemAvailable) return { rows: [], rowCount: 0 };
    const target = values[0] === TARGET;
    if (target && this.targetPrivate && values[1] === false) return { rows: [], rowCount: 0 };
    return { rows: [(target ? this.targetItem() : this.sourceItem()) as Row], rowCount: 1 };
  }

  private sourceItem(): Record<string, unknown> {
    return {
      id: ITEM,
      payload_id: ITEM,
      semantic_group_id: ITEM,
      review_group_id: ITEM,
      payload_digest: DIGEST,
      state: this.state,
      version: this.version,
      hold_policy_key: this.activeHold || this.expiredHold ? "policy-1" : null,
      hold_expires_at: this.activeHold
        ? new Date(AT.getTime() + 60_000)
        : this.expiredHold
          ? new Date(AT.getTime() - 60_000)
          : null,
      hold_active: this.activeHold,
      payload_exact_digest: this.payloadExactDigest,
      canonical_bytes: this.canonicalBytes,
      payload_expires_at: this.payloadExpiresAt,
      payload_eligible: this.activeHold || this.payloadExpiresAt > AT,
    };
  }

  private targetItem(): Record<string, unknown> {
    return {
      ...this.sourceItem(),
      id: TARGET,
      payload_id: TARGET,
      payload_exact_digest: this.targetDrift ? "0".repeat(64) : this.payloadExactDigest,
      payload_eligible: !this.targetExpired,
    };
  }

  private update<Row extends object>(values: readonly unknown[]): PgQueryResult<Row> {
    if (values[4] !== this.version || values[5] !== DIGEST) return { rows: [], rowCount: 0 };
    this.version += 1;
    this.state = values[1] as "pending" | "archived";
    return { rows: [{ version: this.version } as Row], rowCount: 1 };
  }

  private saveReplay(values: readonly unknown[]): void {
    this.replays.set(String(values[0]), {
      request_digest: String(values[1]),
      item_id: ITEM,
      result_state: "archived",
      result_version: Number(values[5]),
      result_at: values[6] as Date,
      restricted_review_group_id: null,
      active_private_group_id: null,
    });
  }

  query<Row extends object>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.calls.push({ text, values });
    if (text.startsWith("BEGIN") && this.failOnceCode !== undefined) {
      const code = this.failOnceCode;
      this.failOnceCode = undefined;
      return Promise.reject(Object.assign(new Error("retry"), { code }));
    }
    if (text.includes("FROM feedback_review_idempotency")) {
      return Promise.resolve(this.replay<Row>(values));
    }
    if (text.startsWith("SELECT i.id") && text.includes("FOR UPDATE")) {
      return Promise.resolve(this.item<Row>(values));
    }
    if (text.startsWith("UPDATE feedback_review_items")) {
      return Promise.resolve(this.update<Row>(values));
    }
    if (text.startsWith("INSERT INTO feedback_review_idempotency")) {
      this.saveReplay(values);
    }
    if (text.startsWith("DELETE FROM feedback_legal_holds")) {
      this.activeHold = false;
      this.expiredHold = false;
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  release(): void {
    this.released = true;
  }
}

function archive(idempotencyKey = "closed-key-000001"): FeedbackReviewCommand {
  return {
    itemId: ITEM,
    expectedVersion: 1,
    expectedPayloadDigest: DIGEST,
    idempotencyKey,
    actor: {
      issuer: "https://issuer.example",
      subject: "operator-1",
      permissionPolicyVersion: "policy-v1",
    },
    action: "archive",
  };
}

function repository(
  client: ReviewClient,
  policyKeys: readonly string[] = [],
): PostgresFeedbackReviewRepository {
  return new PostgresFeedbackReviewRepository(
    {
      connect: (): Promise<PgClientLike> => Promise.resolve(client),
    },
    5_000,
    policyKeys,
    () => AT,
  );
}

describe("Postgres feedback review repository", () => {
  it("atomically applies a terminal action and returns an identical replay", async (): Promise<void> => {
    const client = new ReviewClient();
    const store = repository(client);
    const first = await store.execute(archive());
    const replay = await store.execute(archive());
    expect(first).toEqual({ itemId: ITEM, state: "archived", version: 2, at: AT, replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(client.calls.some(({ text }) => text.startsWith("UPDATE feedback_payloads"))).toBe(true);
    expect(client.calls.some(({ text }) => text.startsWith("UPDATE feedback_receipts"))).toBe(true);
    expect(
      client.calls.some(({ text }) => text.startsWith("INSERT INTO feedback_review_audit")),
    ).toBe(true);
  });

  it("replays the retained result after its shorter-lived payload is deleted", async (): Promise<void> => {
    const client = new ReviewClient();
    const store = repository(client);
    const first = await store.execute(archive());
    client.itemAvailable = false;
    await expect(store.execute(archive())).resolves.toEqual({ ...first, replayed: true });
    await expect(
      store.execute({ ...archive(), action: "route-private-security" }),
    ).rejects.toMatchObject({ code: "idempotency-mismatch" });
  });

  it("rejects idempotency mismatch and stale CAS without a second mutation", async (): Promise<void> => {
    const client = new ReviewClient();
    const store = repository(client);
    await store.execute(archive());
    await expect(
      store.execute({ ...archive(), action: "route-private-security" }),
    ).rejects.toMatchObject<Partial<FeedbackReviewError>>({ code: "idempotency-mismatch" });
    await expect(store.execute(archive("closed-key-000002"))).rejects.toMatchObject<
      Partial<FeedbackReviewError>
    >({ code: "cas-mismatch" });
  });

  it("never copies an extra payload sentinel into SQL values", async (): Promise<void> => {
    const client = new ReviewClient();
    const store = repository(client);
    const command = { ...archive(), forbiddenPayload: "SENTINEL_REPORT_CONTENT" };
    await store.execute(command);
    expect(client.calls.flatMap(({ values }) => values).map(String)).not.toContain(
      command.forbiddenPayload,
    );
  });

  it.each([
    ["private", { targetPrivate: true }, "not-found"],
    ["expired", { targetExpired: true }, "payload-expired"],
    ["digest drift", { targetDrift: true }, "payload-digest-drift"],
  ])("fully validates a %s duplicate target before any effect", async (_name, patch, code) => {
    const client = new ReviewClient();
    Object.assign(client, patch);
    await expect(
      repository(client).execute({
        ...archive("duplicate-target-key"),
        action: "mark-duplicate",
        targetItemId: TARGET,
      }),
    ).rejects.toMatchObject({ code });
    expect(
      client.calls.some(({ text }) =>
        text.startsWith("INSERT INTO feedback_manual_duplicate_links"),
      ),
    ).toBe(false);
    expect(
      client.calls.some(({ text }) => text.startsWith("INSERT INTO feedback_review_audit")),
    ).toBe(false);
  });

  it("fails closed for unknown hold policies and persists an allowlisted key", async (): Promise<void> => {
    const denied = repository(new ReviewClient());
    const hold = {
      ...archive("legal-hold-key-1"),
      action: "place-legal-hold" as const,
      policyKey: "operator-policy-1",
      reviewAt: new Date(AT.getTime() + 86_400_000),
      expiresAt: new Date(AT.getTime() + 2 * 86_400_000),
    };
    await expect(denied.execute(hold)).rejects.toMatchObject({ code: "invalid-legal-hold" });

    const client = new ReviewClient();
    await expect(repository(client, [hold.policyKey]).execute(hold)).resolves.toMatchObject({
      state: "pending",
      version: 2,
    });
    expect(client.calls.flatMap(({ values }) => values)).toContain(hold.policyKey);
  });

  it.each(["40001", "40P01", "23505"])(
    "uses only trusted time and retries PostgreSQL %s",
    async (code): Promise<void> => {
      const client = new ReviewClient();
      client.failOnceCode = code;
      const future = new Date("2099-01-01T00:00:00.000Z");
      const result = await repository(client).execute({ ...archive(), at: future });
      expect(result.at).toEqual(AT);
      expect(client.calls.flatMap(({ values }) => values).map(String)).not.toContain(
        String(future),
      );
      expect(client.calls.filter(({ text }) => text.startsWith("BEGIN"))).toHaveLength(2);
    },
  );

  it("rejects expired payload holds, actor overflow, and payload digest drift", async (): Promise<void> => {
    const expired = new ReviewClient();
    expired.payloadExpiresAt = AT;
    const hold = {
      ...archive("legal-hold-key-2"),
      action: "place-legal-hold" as const,
      policyKey: "operator-policy-1",
      reviewAt: new Date(AT.getTime() + 86_400_000),
      expiresAt: new Date(AT.getTime() + 2 * 86_400_000),
    };
    await expect(repository(expired, [hold.policyKey]).execute(hold)).rejects.toMatchObject({
      code: "payload-expired",
    });
    await expect(
      repository(new ReviewClient(), [hold.policyKey]).execute({
        ...hold,
        reviewAt: new Date(Number.NaN),
      }),
    ).rejects.toMatchObject({ code: "invalid-legal-hold" });
    await expect(
      repository(new ReviewClient()).execute({
        ...archive(),
        actor: { ...archive().actor, subject: "x".repeat(256) },
      }),
    ).rejects.toMatchObject({ code: "invalid-actor" });
    const drifted = new ReviewClient();
    drifted.canonicalBytes = new TextEncoder().encode("corrupted");
    await expect(repository(drifted).execute(archive())).rejects.toMatchObject({
      code: "payload-digest-drift",
    });
  });

  it("allows an active legal hold as the sole logical-expiry exception", async () => {
    const client = new ReviewClient();
    client.payloadExpiresAt = AT;
    client.activeHold = true;
    await expect(repository(client).execute(archive())).resolves.toMatchObject({
      state: "archived",
      version: 2,
    });
  });

  it("expires a raw stale hold, audits its policy, and permits CAS replacement", async () => {
    const client = new ReviewClient();
    client.expiredHold = true;
    const store = repository(client, ["policy-1"]);
    await expect(
      store.execute({
        ...archive("expire-stale-hold-key"),
        action: "expire-legal-hold",
      }),
    ).resolves.toMatchObject({ state: "pending", version: 2 });
    const audit = client.calls.find(({ text }) =>
      text.startsWith("INSERT INTO feedback_review_audit"),
    );
    expect(audit?.values).toContain("policy-1");
    await expect(
      store.execute({
        ...archive("replace-stale-hold-key"),
        expectedVersion: 2,
        action: "place-legal-hold",
        policyKey: "policy-1",
        reviewAt: new Date(AT.getTime() + 60_000),
        expiresAt: new Date(AT.getTime() + 120_000),
      }),
    ).resolves.toMatchObject({ state: "pending", version: 3 });
  });
});
import { createHash } from "node:crypto";
