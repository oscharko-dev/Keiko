import type { FeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { digestFeedbackTargetPolicyV1 } from "./feedback-publication-projection.js";
import type { FeedbackPublicationWorkerLease } from "./feedback-publication-worker-types.js";
import type { PgClientLike, PgPoolLike } from "./postgres-types.js";

const mocks = vi.hoisted(() => ({
  candidates: [] as Record<string, unknown>[],
  circuits: [] as Record<string, unknown>[],
  dispatchRow: undefined as Record<string, unknown> | undefined,
  advisoryLocked: true,
  lockDispatchCandidate: vi.fn(),
  selectWorkerCandidate: vi.fn(),
  claimWorkerCandidate: vi.fn(),
  leasedProjectionFromRow: vi.fn(),
  persistWorkerSuccess: vi.fn(),
}));

vi.mock("./feedback-publication-dispatch.js", () => ({
  lockDispatchCandidate: mocks.lockDispatchCandidate,
  leasedProjectionFromRow: mocks.leasedProjectionFromRow,
}));

vi.mock("./feedback-publication-worker-sql.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./feedback-publication-worker-sql.js")>()),
  claimWorkerCandidate: mocks.claimWorkerCandidate,
  databaseNow: (): Promise<Date> => Promise.resolve(new Date("2026-07-12T12:00:00.000Z")),
  selectWorkerCandidate: mocks.selectWorkerCandidate,
}));

vi.mock("./feedback-publication-worker-success.js", () => ({
  persistWorkerSuccess: mocks.persistWorkerSuccess,
}));

import { PostgresFeedbackPublicationWorkerStore } from "./feedback-publication-worker-store.js";

const AT = new Date("2026-07-12T12:00:00.000Z");
const LEASE_EXPIRES = new Date("2026-07-12T12:01:00.000Z");
const TARGET: FeedbackPublicationTargetPolicySnapshotV1 = {
  apiOrigin: "https://api.github.com",
  repositoryId: "123",
  owner: "owner",
  repository: "repository",
  installationId: "456",
  labels: ["feedback"],
  targetKey: "public",
  labelPolicyVersion: "labels-v1",
  targetPolicyVersion: "target-v1",
};
const TARGET_DIGEST = digestFeedbackTargetPolicyV1(TARGET);
const IDENTITY = {
  outboxId: "11111111-1111-4111-8111-111111111111",
  preparationId: "22222222-2222-4222-8222-222222222222",
  itemId: "33333333-3333-4333-8333-333333333333",
  targetPolicyDigest: TARGET_DIGEST,
  leaseOwner: "worker-1",
  leaseExpiresAt: LEASE_EXPIRES,
} as const;

class WorkerClient implements PgClientLike {
  readonly calls: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  readonly released: (Error | undefined)[] = [];
  createAttempts = 0;
  exactLeaseStatus = "claimed";

  query: PgClientLike["query"] = (text: string, values: readonly unknown[] = []) => {
    this.calls.push({ text, values });
    if (text.startsWith("SELECT pg_try_advisory_lock")) {
      return Promise.resolve({ rows: [{ locked: mocks.advisoryLocked } as never], rowCount: 1 });
    }
    if (text.startsWith("SELECT pg_advisory_unlock")) {
      return Promise.resolve({ rows: [{ unlocked: true } as never], rowCount: 1 });
    }
    if (text.startsWith("SELECT consecutive_failures")) {
      return Promise.resolve({ rows: mocks.circuits as never[], rowCount: mocks.circuits.length });
    }
    if (text.startsWith("SELECT outbox.status,outbox.create_attempt_count")) {
      const exact = [
        IDENTITY.outboxId,
        IDENTITY.preparationId,
        IDENTITY.itemId,
        IDENTITY.targetPolicyDigest,
        IDENTITY.leaseOwner,
        IDENTITY.leaseExpiresAt,
      ].every((value, index) => values[index] === value);
      return Promise.resolve({
        rows: exact
          ? ([
              { status: this.exactLeaseStatus, create_attempt_count: this.createAttempts },
            ] as never[])
          : [],
        rowCount: exact ? 1 : 0,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  };

  release(error?: Error): void {
    this.released.push(error);
  }
}

function workerLease(
  mode: "create-eligible" | "reconcile-only" = "create-eligible",
): FeedbackPublicationWorkerLease {
  return {
    ...IDENTITY,
    title: "governed title",
    body: "governed body",
    projectionDigest: "a".repeat(64),
    reconciliationMarker: `<!-- keiko-feedback-reconciliation-v1:${"a".repeat(43)} -->`,
    target: TARGET,
    mode,
    createAttemptCount: 0,
  };
}

function store(
  primary = new WorkerClient(),
  sessions = new WorkerClient(),
): {
  readonly store: PostgresFeedbackPublicationWorkerStore;
  readonly primary: WorkerClient;
  readonly sessions: WorkerClient;
} {
  const pool = {
    connect: (): Promise<PgClientLike> => Promise.resolve(primary),
  } satisfies PgPoolLike;
  const installationPool = {
    connect: (): Promise<PgClientLike> => Promise.resolve(sessions),
  } satisfies PgPoolLike;
  return {
    store: new PostgresFeedbackPublicationWorkerStore(pool, installationPool, () => TARGET),
    primary,
    sessions,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.candidates = [];
  mocks.circuits = [];
  mocks.dispatchRow = {
    id: IDENTITY.preparationId,
    item_id: IDENTITY.itemId,
    target_key: TARGET.targetKey,
    target_policy_digest: TARGET_DIGEST,
    target_installation_id: TARGET.installationId,
    outbox_status: "claimed",
    create_armed_at: AT,
    create_attempt_count: 1,
  };
  mocks.advisoryLocked = true;
  mocks.selectWorkerCandidate.mockImplementation(() => Promise.resolve(mocks.candidates.shift()));
  mocks.claimWorkerCandidate.mockResolvedValue(LEASE_EXPIRES);
  mocks.lockDispatchCandidate.mockImplementation(() => Promise.resolve(mocks.dispatchRow));
  mocks.leasedProjectionFromRow.mockImplementation(() => workerLease());
  mocks.persistWorkerSuccess.mockResolvedValue(undefined);
});

describe("Postgres feedback publication worker store coordination", () => {
  it("rejects invalid worker options before querying PostgreSQL", async () => {
    const fixture = store();
    await expect(
      fixture.store.withCandidate({ workerId: "!invalid", leaseDurationMs: 999 }, () =>
        Promise.resolve("never"),
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(fixture.primary.calls).toEqual([]);
  });

  it("returns no candidate after bounded empty candidate selection", async () => {
    const fixture = store();
    await expect(
      fixture.store.withCandidate({ workerId: "worker-1", leaseDurationMs: 60_000 }, () =>
        Promise.resolve("never"),
      ),
    ).resolves.toBeUndefined();
    expect(mocks.selectWorkerCandidate).toHaveBeenCalledTimes(3);
    expect(fixture.primary.calls.filter(({ text }) => text === "COMMIT")).toHaveLength(1);
  });

  it("restores a claim when the per-installation advisory lock is busy", async () => {
    mocks.candidates = [
      {
        id: IDENTITY.outboxId,
        status: "unclaimed",
        target_installation_id: TARGET.installationId,
        create_attempt_count: 0,
      },
    ];
    mocks.advisoryLocked = false;
    const fixture = store();

    await expect(
      fixture.store.withCandidate(
        { workerId: "worker-1", leaseDurationMs: 60_000, candidateLimit: 1 },
        () => Promise.resolve("never"),
      ),
    ).resolves.toBeUndefined();
    expect(
      fixture.sessions.calls.some(({ text }) =>
        text.startsWith("UPDATE feedback_publication_outbox SET status"),
      ),
    ).toBe(true);
  });

  it("holds an installation lock only while delivering the validated exact lease", async () => {
    mocks.candidates = [
      {
        id: IDENTITY.outboxId,
        status: "unclaimed",
        target_installation_id: TARGET.installationId,
        create_attempt_count: 0,
      },
    ];
    const fixture = store();

    await expect(
      fixture.store.withCandidate({ workerId: "worker-1", leaseDurationMs: 60_000 }, (lease) =>
        Promise.resolve({ mode: lease.mode, owner: lease.leaseOwner }),
      ),
    ).resolves.toEqual({ mode: "create-eligible", owner: "worker-1" });
    expect(
      fixture.sessions.calls.some(({ text }) => text.startsWith("SELECT pg_advisory_unlock")),
    ).toBe(true);
  });

  it("enforces circuit cooldowns and permits one expired half-open probe", async () => {
    const fixture = store();
    const lease = workerLease("reconcile-only");

    await expect(fixture.store.enterProviderCircuit(lease)).resolves.toEqual({
      allowed: true,
      probe: false,
    });
    mocks.circuits = [
      {
        consecutive_failures: 3,
        open_until: new Date(AT.getTime() + 2_000),
        probe_expires_at: null,
      },
    ];
    await expect(fixture.store.enterProviderCircuit(lease)).resolves.toEqual({
      allowed: false,
      delayMs: 2_000,
    });
    mocks.circuits = [{ consecutive_failures: 3, open_until: AT, probe_expires_at: null }];
    await expect(fixture.store.enterProviderCircuit(lease)).resolves.toEqual({
      allowed: true,
      probe: true,
    });
  });

  it("bounds durable retry and circuit transitions, including exhausted attempts", async () => {
    const fixture = store();
    await expect(fixture.store.scheduleRetry(IDENTITY, "rate-limited", 1)).resolves.toBe(
      "retryable-failure",
    );
    fixture.primary.createAttempts = 3;
    await expect(
      fixture.store.scheduleRetry(IDENTITY, "provider-unavailable", 99_999_999),
    ).resolves.toBe("manual-reconciliation");
    await expect(fixture.store.scheduleCircuitDeferral(workerLease(), 1)).resolves.toBeUndefined();
    await expect(
      fixture.store.scheduleCircuitDeferral(workerLease("reconcile-only"), 99_999_999),
    ).resolves.toBeUndefined();
    expect(
      fixture.primary.calls.filter(({ text }) =>
        text.startsWith("UPDATE feedback_publication_outbox"),
      ),
    ).not.toHaveLength(0);
  });

  it.each([
    ["preparationId", "not-the-preparation"],
    ["itemId", "not-the-item"],
    ["targetPolicyDigest", "d".repeat(64)],
    ["leaseOwner", "other-worker"],
    ["leaseExpiresAt", new Date(LEASE_EXPIRES.getTime() + 1)],
  ] as const)(
    "rejects an exact-lease %s mismatch before scheduling a transition",
    async (key, value) => {
      const fixture = store();
      const lease = { ...IDENTITY, [key]: value };

      await expect(fixture.store.scheduleRetry(lease, "rate-limited", 1_000)).rejects.toMatchObject(
        {
          code: "claim-unavailable",
        },
      );
      expect(
        fixture.primary.calls.some(({ text }) =>
          text.startsWith("UPDATE feedback_publication_outbox"),
        ),
      ).toBe(false);
    },
  );

  it("records provider outcomes, manual reconciliation, and successful linkage under a transaction", async () => {
    const fixture = store();
    const lease = workerLease("reconcile-only");

    await expect(fixture.store.recordProviderFailure(lease, 1, true)).resolves.toBeUndefined();
    fixture.primary.exactLeaseStatus = "may-have-committed";
    await expect(fixture.store.recordProviderProbeSuccess(lease)).resolves.toBeUndefined();
    fixture.primary.exactLeaseStatus = "claimed";
    await expect(
      fixture.store.recordManual(IDENTITY, "permission-denied"),
    ).resolves.toBeUndefined();
    await expect(
      fixture.store.recordSuccess(IDENTITY, {
        repositoryId: "123",
        issueNodeId: "node",
        issueNumber: 7,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.persistWorkerSuccess).toHaveBeenCalledTimes(1);
    expect(fixture.primary.released.every((error) => error === undefined)).toBe(true);
  });
});
