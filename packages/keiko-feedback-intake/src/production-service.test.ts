import { prepareFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";
import { describe, expect, it } from "vitest";
import { DEFAULT_TEST_LIMITS, validateIntakeLimits } from "./config.js";
import type { PgAdmission, PgAttemptReservation } from "./postgres.js";
import {
  createPostgresFeedbackIntake,
  type ProductionIntakeRepository,
  type ProductionServiceOptions,
} from "./production-service.js";
import type { IntakeSecretProvider, IntakeSecretSnapshot } from "./types.js";

const DAY_MS = 86_400_000;
const FIXED_RECEIPT_LIFETIME_MS = 30 * DAY_MS;
const FIXED_OPEN_PAYLOAD_LIFETIME_MS = 90 * DAY_MS;
const FIXED_DEDUPE_LIFETIME_MS = 180 * DAY_MS;

interface StoredPayload {
  readonly id: string;
  readonly groupId: string;
  readonly bytes: Uint8Array;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

interface StoredDedupe {
  readonly groupId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  count: number;
}

class ReceiptOracleRepository implements ProductionIntakeRepository {
  readonly payloads: StoredPayload[] = [];
  readonly dedupe = new Map<string, StoredDedupe>();
  readonly receipts = new Map<
    string,
    { readonly secretHash: Uint8Array; readonly expiresAt: Date; readonly closed: boolean }
  >();

  reserveAttempt(): Promise<{ readonly reserved: true }> {
    return Promise.resolve({ reserved: true });
  }

  admit(input: PgAdmission): Promise<{ readonly accepted: true; readonly payloadId: string }> {
    const matched = this.matchingDedupe(input);
    const groupId = matched?.groupId ?? input.groupId;
    if (matched === undefined) this.storeDedupe(input, groupId);
    else matched.count += 1;
    const reusable = this.reusablePayload(groupId, input.receiptExpiresAt);
    const payloadId = reusable?.id ?? this.storePayload(input, groupId);
    this.receipts.set(input.receiptId, {
      secretHash: input.receiptSecretHash,
      expiresAt: input.receiptExpiresAt,
      closed: false,
    });
    return Promise.resolve({ accepted: true, payloadId });
  }

  findReceipt(
    id: string,
  ): Promise<
    | { readonly secretHash: Uint8Array; readonly expiresAt: Date; readonly closed: boolean }
    | undefined
  > {
    return Promise.resolve(this.receipts.get(id));
  }

  private matchingDedupe(input: PgAdmission): StoredDedupe | undefined {
    return input.dedupeCandidates
      .map((candidate) =>
        this.dedupe.get(`${candidate.keyId}:${Buffer.from(candidate.hmac).toString("hex")}`),
      )
      .find((entry) => entry !== undefined && entry.expiresAt > input.createdAt);
  }

  private storeDedupe(input: PgAdmission, groupId: string): void {
    this.dedupe.set(`${input.dedupeKeyId}:${Buffer.from(input.dedupeHmac).toString("hex")}`, {
      groupId,
      createdAt: input.createdAt,
      expiresAt: input.dedupeExpiresAt,
      count: 1,
    });
  }

  private reusablePayload(groupId: string, receiptExpiresAt: Date): StoredPayload | undefined {
    return this.payloads.find(
      (payload) => payload.groupId === groupId && payload.expiresAt >= receiptExpiresAt,
    );
  }

  private storePayload(input: PgAdmission, groupId: string): string {
    this.payloads.push({
      id: input.payloadId,
      groupId,
      bytes: Uint8Array.from(input.canonicalBytes),
      createdAt: input.createdAt,
      expiresAt: input.payloadExpiresAt,
    });
    return input.payloadId;
  }
}

function report(title = "PostgreSQL receipt oracle"): ReturnType<typeof prepareFeedbackReportV1> {
  return prepareFeedbackReportV1({
    schemaVersion: "1",
    category: "defect",
    title,
    description: "Production receipt behavior is verified.",
    reproductionSteps: "Submit a canonical report.",
    expectedBehavior: "Receipt expiry does not reveal semantic grouping.",
    actualBehavior: "The PostgreSQL service path is exercised.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
  });
}

function provider(currentFill: number, previousFill: number): IntakeSecretProvider {
  return {
    snapshot: () => ({
      active: {
        id: `key-${String(currentFill)}`,
        key: new Uint8Array(32).fill(currentFill),
        activatedAt: new Date(1),
      },
      predecessors: [
        {
          id: `key-${String(previousFill)}`,
          key: new Uint8Array(32).fill(previousFill),
          activatedAt: new Date(0),
        },
      ],
    }),
  };
}

function changingProvider(prefix: string, generation: { value: number }): IntakeSecretProvider {
  return {
    snapshot: (): IntakeSecretSnapshot => {
      generation.value += 1;
      const suffix = String(generation.value);
      return {
        active: {
          id: `${prefix}-current-${suffix}`,
          key: new Uint8Array(32).fill(generation.value),
          activatedAt: new Date(1),
        },
        predecessors: [
          {
            id: `${prefix}-previous-${suffix}`,
            key: new Uint8Array(32).fill(generation.value + 10),
            activatedAt: new Date(0),
          },
        ],
      };
    },
  };
}

function options(
  repository: ProductionIntakeRepository,
  laneLimits: { readonly concurrency: number; readonly receiptConcurrency: number } = {
    concurrency: 1,
    receiptConcurrency: 1,
  },
): ProductionServiceOptions {
  return {
    repository,
    limits: validateIntakeLimits({
      ...DEFAULT_TEST_LIMITS,
      ...laneLimits,
    }),
    abuseKeys: provider(1, 2),
    dedupeKeys: provider(3, 4),
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    logger: { event: () => undefined },
    metrics: { increment: () => undefined },
  };
}

describe("production feedback intake service", () => {
  it("uses current and previous abuse custody material for one durable reservation", async () => {
    let captured: PgAttemptReservation | undefined;
    const repository: ProductionIntakeRepository = {
      reserveAttempt: (input) => {
        captured = input;
        return Promise.resolve({ reserved: true });
      },
      admit: () => Promise.resolve({ accepted: false, reason: "capacity" }),
      findReceipt: () => Promise.resolve(undefined),
    };
    const lease = await createPostgresFeedbackIntake(options(repository)).beginAttempt(
      new Uint8Array([127, 0, 0, 1]),
    );

    expect(lease.ok).toBe(true);
    expect(captured?.abuseKeyId).toBe("key-1");
    expect(captured?.abuseCandidates.map((candidate) => candidate.keyId)).toEqual([
      "key-1",
      "key-2",
    ]);
    if (lease.ok) lease.release();
  });

  it("never mixes current and predecessor keys from different custody generations", async () => {
    const abuseGeneration = { value: 0 };
    const dedupeGeneration = { value: 0 };
    let reserved: PgAttemptReservation | undefined;
    let admitted: PgAdmission | undefined;
    const repository: ProductionIntakeRepository = {
      reserveAttempt: (input) => {
        reserved = input;
        return Promise.resolve({ reserved: true });
      },
      admit: (input) => {
        admitted = input;
        return Promise.resolve({ accepted: true, payloadId: input.payloadId });
      },
      findReceipt: () => Promise.resolve(undefined),
    };
    const service = createPostgresFeedbackIntake({
      ...options(repository),
      abuseKeys: changingProvider("abuse", abuseGeneration),
      dedupeKeys: changingProvider("dedupe", dedupeGeneration),
    });
    const prepared = report("Atomic custody snapshots");
    if (!prepared.ok) throw new Error("fixture failed");

    const result = await service.submit(
      prepared.value.canonicalBody.copyBytes(),
      prepared.value.exactBodySha256,
      new Uint8Array([127, 0, 0, 1]),
    );

    expect(result.status).toBe(202);
    expect(reserved?.abuseCandidates.map((candidate) => candidate.keyId)).toEqual([
      "abuse-current-1",
      "abuse-previous-1",
    ]);
    expect(admitted?.dedupeCandidates.map((candidate) => candidate.keyId)).toEqual([
      "dedupe-current-1",
      "dedupe-previous-1",
    ]);
    expect({ abuse: abuseGeneration.value, dedupe: dedupeGeneration.value }).toEqual({
      abuse: 1,
      dedupe: 1,
    });
  });

  it("caps receipt lookups with a separate semaphore and uniform denial", async () => {
    let resolveLookup: ((value: undefined) => void) | undefined;
    const pending = new Promise<undefined>((resolve) => {
      resolveLookup = resolve;
    });
    let lookups = 0;
    let attempts = 0;
    const repository: ProductionIntakeRepository = {
      reserveAttempt: () => {
        attempts += 1;
        return Promise.resolve({ reserved: true });
      },
      admit: () => Promise.resolve({ accepted: false, reason: "capacity" }),
      findReceipt: () => {
        lookups += 1;
        return pending;
      },
    };
    const service = createPostgresFeedbackIntake(options(repository));
    const first = service.receipt("A".repeat(22), "A".repeat(43));
    await Promise.resolve();

    await expect(service.receipt("B".repeat(22), "A".repeat(43))).resolves.toEqual({
      status: 404,
      body: { error: "invalid-request" },
    });
    expect(lookups).toBe(1);
    const submissionLease = await service.beginAttempt(new Uint8Array([127, 0, 0, 1]));
    expect(submissionLease.ok).toBe(true);
    expect(attempts).toBe(1);
    if (submissionLease.ok) submissionLease.release();
    resolveLookup?.(undefined);
    await expect(first).resolves.toEqual({ status: 404, body: { error: "invalid-request" } });
  });

  it("applies unequal limits to their own submission and receipt lanes", async () => {
    let releaseAttempts: (() => void) | undefined;
    const heldAttempts = new Promise<void>((resolve) => {
      releaseAttempts = resolve;
    });
    let attempts = 0;
    let releaseReceipts: (() => void) | undefined;
    const heldReceipts = new Promise<undefined>((resolve) => {
      releaseReceipts = (): void => {
        resolve(undefined);
      };
    });
    let receipts = 0;
    const repository: ProductionIntakeRepository = {
      reserveAttempt: async () => {
        attempts += 1;
        await heldAttempts;
        return { reserved: true };
      },
      admit: () => Promise.resolve({ accepted: false, reason: "capacity" }),
      findReceipt: () => {
        receipts += 1;
        return heldReceipts;
      },
    };
    const service = createPostgresFeedbackIntake(
      options(repository, { concurrency: 2, receiptConcurrency: 1 }),
    );
    const firstAttempt = service.beginAttempt(new Uint8Array([1]));
    const secondAttempt = service.beginAttempt(new Uint8Array([2]));
    await Promise.resolve();

    expect(attempts).toBe(2);
    await expect(service.beginAttempt(new Uint8Array([3]))).resolves.toMatchObject({ ok: false });
    const firstReceipt = service.receipt("A".repeat(22), "A".repeat(43));
    await Promise.resolve();
    await expect(service.receipt("B".repeat(22), "A".repeat(43))).resolves.toMatchObject({
      status: 404,
    });
    expect(receipts).toBe(1);

    releaseAttempts?.();
    for (const lease of await Promise.all([firstAttempt, secondAttempt])) {
      if (lease.ok) lease.release();
    }
    releaseReceipts?.();
    await firstReceipt;
  });

  it("keeps a late duplicate receipt indistinguishable from a unique PostgreSQL receipt", async () => {
    let time = new Date("2026-01-01T00:00:00.000Z");
    const repository = new ReceiptOracleRepository();
    const service = createPostgresFeedbackIntake({ ...options(repository), now: () => time });
    const duplicate = report();
    const unique = report("Distinct PostgreSQL receipt oracle");
    if (!duplicate.ok || !unique.ok) throw new Error("fixture failed");

    const first = await service.submit(
      duplicate.value.canonicalBody.copyBytes(),
      duplicate.value.exactBodySha256,
      new Uint8Array([127, 0, 0, 1]),
    );
    if (first.status !== 202) throw new Error("first submission failed");
    expect(first.body.expiresAt).toBe(
      new Date(time.getTime() + FIXED_RECEIPT_LIFETIME_MS).toISOString(),
    );
    await expect(service.receipt(first.body.receiptId, first.body.receiptSecret)).resolves.toEqual({
      status: 200,
      body: {
        receiptId: first.body.receiptId,
        status: "received",
        expiresAt: first.body.expiresAt,
      },
    });
    const firstPayload = repository.payloads[0];
    const firstDedupe = [...repository.dedupe.values()][0];
    if (firstPayload === undefined || firstDedupe === undefined)
      throw new Error("first state missing");

    time = new Date("2026-03-03T00:00:00.000Z");
    expect(firstPayload.expiresAt.getTime() - time.getTime()).toBeLessThan(
      FIXED_RECEIPT_LIFETIME_MS,
    );
    const late = await service.submit(
      duplicate.value.canonicalBody.copyBytes(),
      duplicate.value.exactBodySha256,
      new Uint8Array([127, 0, 0, 2]),
    );
    const other = await service.submit(
      unique.value.canonicalBody.copyBytes(),
      unique.value.exactBodySha256,
      new Uint8Array([127, 0, 0, 3]),
    );
    if (late.status !== 202 || other.status !== 202) throw new Error("follow-up submission failed");

    expect(late.body.expiresAt).toBe(other.body.expiresAt);
    expect(late.body.expiresAt).toBe(
      new Date(time.getTime() + FIXED_RECEIPT_LIFETIME_MS).toISOString(),
    );
    expect(repository.payloads).toHaveLength(3);
    expect(repository.payloads[1]).toMatchObject({ groupId: firstPayload.groupId });
    expect(repository.payloads[0]).toEqual(firstPayload);
    expect(repository.payloads[0]?.expiresAt.getTime()).toBe(
      new Date("2026-01-01T00:00:00.000Z").getTime() + FIXED_OPEN_PAYLOAD_LIFETIME_MS,
    );
    expect(firstDedupe).toMatchObject({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      count: 2,
    });
    expect(firstDedupe.expiresAt.getTime()).toBe(
      new Date("2026-01-01T00:00:00.000Z").getTime() + FIXED_DEDUPE_LIFETIME_MS,
    );
  });
});
