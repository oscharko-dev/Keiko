import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresFeedbackReviewQuery } from "./feedback-review-query.js";
import { preparedReport } from "./postgres-integration-helpers.js";
import type { PgClientLike, PgPoolLike, PgQueryResult } from "./postgres-types.js";

const AT = new Date("2026-07-12T12:00:00.000Z");
const ITEM = "11111111-1111-4111-8111-111111111111";
const NEXT_ITEM = "22222222-2222-4222-8222-222222222222";
const BEFORE = new Date(AT.getTime() - 1_000);
const prepared = preparedReport("Review query coverage");
const bytes = prepared.canonicalBody.copyBytes();
const digest = createHash("sha256").update(bytes).digest("hex");
const report = prepared.report;

function base(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ITEM,
    opaque_id: "group",
    group_count: "2",
    payload_digest: digest,
    exact_body_sha256: digest,
    canonical_bytes: bytes,
    state: "pending",
    version: 1,
    created_at: AT,
    updated_at: AT,
    category: report.diagnostics.category,
    feature_area: report.diagnostics.featureArea,
    impact: report.impact,
    errors: 1,
    warnings: 2,
    infos: 3,
    ...overrides,
  };
}

interface ObservedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

class QueryClient implements PgClientLike {
  released = false;
  readonly calls: ObservedQuery[] = [];
  constructor(private readonly results: (readonly object[] | Error)[]) {}
  query<Row extends object = Record<string, never>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.calls.push({ text, values });
    const next = this.results.shift() ?? [];
    if (next instanceof Error) return Promise.reject(next);
    const rows = next as readonly Row[];
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  release(): void {
    this.released = true;
  }
}

function query(...results: readonly (readonly object[])[]): {
  readonly subject: PostgresFeedbackReviewQuery;
  readonly client: QueryClient;
} {
  const client = new QueryClient([...results]);
  const pool = {
    connect: (): Promise<PgClientLike> => Promise.resolve(client),
  } satisfies PgPoolLike;
  return { subject: new PostgresFeedbackReviewQuery(pool), client };
}

function queryWithError(...results: readonly (readonly object[] | Error)[]): {
  readonly subject: PostgresFeedbackReviewQuery;
  readonly client: QueryClient;
} {
  const client = new QueryClient([...results]);
  const pool = {
    connect: (): Promise<PgClientLike> => Promise.resolve(client),
  } satisfies PgPoolLike;
  return { subject: new PostgresFeedbackReviewQuery(pool), client };
}

describe("feedback review query projections", () => {
  it("lists summary projections with cursor pagination and validated severity counts", async () => {
    const next = base({ id: NEXT_ITEM, updated_at: BEFORE });
    const fixture = query([base(), next], [next]);
    const page = await fixture.subject.list({ limit: 1, includePrivate: false });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ itemId: ITEM, severityCounts: { errors: 1 } });
    expect(page.nextCursor).toEqual(expect.any(String));
    await expect(
      fixture.subject.list({ limit: 1, includePrivate: false, cursor: page.nextCursor }),
    ).resolves.toEqual({ items: [expect.objectContaining({ itemId: NEXT_ITEM })] });
    expect(fixture.client.calls.map((call) => call.values)).toEqual([
      [null, false, null, null, 2],
      [null, false, AT, ITEM, 2],
    ]);
    expect(fixture.client.calls[0]?.text).toContain("i.state <> 'private-security'");
    expect(fixture.client.calls[0]?.text).toContain("private.semantic_group_id IS NULL");
    expect(fixture.client.released).toBe(true);
  });

  it("returns exact detail, hold governance, audit evidence, and safe empty states", async () => {
    const held = {
      ...base(),
      hold_policy_key: "hold-v1",
      hold_review_at: AT,
      hold_expires_at: new Date(AT.getTime() + 60_000),
      hold_active: true,
    };
    const audit = {
      event_id: "event",
      item_id: ITEM,
      payload_digest: digest,
      prior_version: 1,
      result_version: 2,
      action: "archive",
      prior_state: "pending",
      result_state: "archived",
      result: "applied",
      event_at: AT,
      actor_issuer: "https://issuer.example",
      actor_sub: "operator",
      permission_policy_version: "policy-v1",
      policy_key: "hold-v1",
    };
    const fixture = query([held], [held], [audit], []);
    const detail = await fixture.subject.detail(ITEM, false);
    expect(detail?.canonicalPayload).toEqual(expect.any(String));
    expect(detail?.legalHold).toEqual({
      status: "active",
      policyKey: "hold-v1",
      reviewAt: AT.toISOString(),
      expiresAt: new Date(AT.getTime() + 60_000).toISOString(),
    });
    await expect(fixture.subject.hold(ITEM, false)).resolves.toMatchObject({
      legalHold: { status: "active" },
    });
    await expect(fixture.subject.audit(1, false)).resolves.toEqual([
      expect.objectContaining({ eventId: "event", policyKey: "hold-v1" }),
    ]);
    await expect(fixture.subject.detail(ITEM, false)).resolves.toBeUndefined();
    expect(fixture.client.calls.map((call) => call.values)).toEqual([
      [ITEM, false],
      [ITEM, false],
      [1, false],
      [ITEM, false],
    ]);
    expect(fixture.client.calls[0]?.text).toContain("i.state <> 'private-security'");
    expect(fixture.client.calls[1]?.text).toContain("i.state <> 'private-security'");
    expect(fixture.client.calls[2]?.text).toContain("audit.prior_state <> 'private-security'");
    expect(fixture.client.calls[2]?.text).toContain("audit.result_state <> 'private-security'");
  });

  it("fails closed for malformed cursors, invalid limits, and payload summary drift", async () => {
    const fixture = query([{ ...base(), exact_body_sha256: "0".repeat(64) }]);
    await expect(
      fixture.subject.list({ limit: 1, includePrivate: false, cursor: "bad" }),
    ).rejects.toMatchObject({
      code: "invalid-request",
    });
    await expect(fixture.subject.audit(0, false)).rejects.toMatchObject({
      code: "invalid-request",
    });
    await expect(fixture.subject.list({ limit: 1, includePrivate: false })).rejects.toMatchObject({
      code: "payload-digest-drift",
    });
  });

  it("keeps no-hold, null-policy audit, and unpaginated list projections minimal", async () => {
    const audit = {
      event_id: "event",
      item_id: ITEM,
      payload_digest: digest,
      prior_version: 1,
      result_version: 2,
      action: "archive",
      prior_state: "pending",
      result_state: "archived",
      result: "applied",
      event_at: AT,
      actor_issuer: "https://issuer.example",
      actor_sub: "operator",
      permission_policy_version: "policy-v1",
      policy_key: null,
    };
    const fixture = query([base()], [{ ...base(), hold_policy_key: null }], [audit]);
    await expect(fixture.subject.list({ limit: 1, includePrivate: false })).resolves.toEqual({
      items: [expect.objectContaining({ itemId: ITEM })],
    });
    await expect(fixture.subject.detail(ITEM, false)).resolves.toMatchObject({
      legalHold: { status: "none" },
    });
    const events = await fixture.subject.audit(1, false);
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("policyKey");
  });

  it("rejects invalid detail and hold IDs before checkout and releases on malformed or failed reads", async () => {
    const invalid = query();
    await expect(invalid.subject.detail("not-a-uuid", false)).rejects.toMatchObject({
      code: "invalid-request",
    });
    await expect(invalid.subject.hold("not-a-uuid", false)).rejects.toMatchObject({
      code: "invalid-request",
    });
    expect(invalid.client.released).toBe(false);

    const malformedBytes = Uint8Array.from([0xff]);
    const malformedDigest = createHash("sha256").update(malformedBytes).digest("hex");
    const malformed = queryWithError([
      {
        ...base(),
        canonical_bytes: malformedBytes,
        payload_digest: malformedDigest,
        exact_body_sha256: malformedDigest,
      },
    ]);
    await expect(malformed.subject.detail(ITEM, false)).rejects.toMatchObject({
      code: "payload-digest-drift",
    });
    expect(malformed.client.released).toBe(true);

    const failed = queryWithError(new Error("database unavailable"));
    await expect(failed.subject.list({ limit: 1, includePrivate: false })).rejects.toThrow(
      "database unavailable",
    );
    expect(failed.client.released).toBe(true);
  });
});
