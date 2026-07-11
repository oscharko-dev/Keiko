import { randomBytes } from "node:crypto";
import type { PreparedFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";
import { verifyCanonicalFeedbackReportBodyV1 } from "@oscharko-dev/keiko-security/feedback-report";
import { feedbackSecurityRoutingDecisionV1 } from "@oscharko-dev/keiko-security/feedback-security-routing";
import { DEFAULT_TEST_LIMITS, validateIntakeLimits } from "./config.js";
import {
  abuseIdentity,
  capability,
  dedupeIdentity,
  receiptHash,
  receiptHashBytes,
  safeHashEqual,
} from "./crypto.js";
import { InMemorySecretRing } from "./keys.js";
import { InMemoryIntakeStore } from "./memory-store.js";
import {
  ABUSE_LIFETIME_MS,
  DAY_MS,
  OPEN_ITEM_LIFETIME_MS,
  RECEIPT_LIFETIME_MS,
  type ContentFreeLogger,
  type ContentFreeMetrics,
  type IntakeInspection,
  type IntakeLimits,
  type IntakeSecretProvider,
  type ReceiptResult,
  type SubmitResult,
} from "./types.js";

const NOOP_LOGGER: ContentFreeLogger = { event: () => undefined };
const NOOP_METRICS: ContentFreeMetrics = { increment: () => undefined };

export interface InMemoryIntakeOptions {
  readonly now?: (() => Date) | undefined;
  readonly limits?: IntakeLimits | undefined;
  readonly logger?: ContentFreeLogger | undefined;
  readonly metrics?: ContentFreeMetrics | undefined;
  readonly abuseKeys?: IntakeSecretProvider | undefined;
  readonly dedupeKeys?: IntakeSecretProvider | undefined;
}

export interface InMemoryFeedbackIntake {
  submit(bytes: Uint8Array, digest: string, address: Uint8Array): Promise<SubmitResult>;
  receipt(id: string, secret: string): Promise<ReceiptResult>;
  inspect(): IntakeInspection;
  purge(): ReturnType<InMemoryIntakeStore["purge"]>;
}

interface Runtime {
  readonly now: () => Date;
  readonly limits: IntakeLimits;
  readonly logger: ContentFreeLogger;
  readonly metrics: ContentFreeMetrics;
  readonly abuseKeys: IntakeSecretProvider;
  readonly dedupeKeys: IntakeSecretProvider;
  readonly store: InMemoryIntakeStore;
}

function ephemeralProvider(prefix: "abuse" | "dedupe"): IntakeSecretProvider {
  return new InMemorySecretRing(
    { id: `${prefix}:ephemeral`, key: randomBytes(32), activatedAt: new Date(0) },
    prefix === "dedupe" ? 2 : 1,
  );
}

function runtime(options: InMemoryIntakeOptions): Runtime {
  return {
    now: options.now ?? ((): Date => new Date()),
    limits: validateIntakeLimits(options.limits ?? DEFAULT_TEST_LIMITS),
    logger: options.logger ?? NOOP_LOGGER,
    metrics: options.metrics ?? NOOP_METRICS,
    abuseKeys: options.abuseKeys ?? ephemeralProvider("abuse"),
    dedupeKeys: options.dedupeKeys ?? ephemeralProvider("dedupe"),
    store: new InMemoryIntakeStore(),
  };
}

function hasCapacity(state: Runtime, bytes: Uint8Array): boolean {
  if (state.store.inspect().payloadCount >= state.limits.openPayloadCount) return false;
  const openBytes = [...state.store.payloads.values()].reduce(
    (sum, item) => sum + item.bytes.byteLength,
    0,
  );
  return openBytes + bytes.byteLength <= state.limits.openPayloadBytes;
}

function verifiedReport(bytes: Uint8Array, digest: string): PreparedFeedbackReportV1 | undefined {
  const verified = verifyCanonicalFeedbackReportBodyV1({ bytes, claimedDigest: digest });
  if (!verified.ok) return undefined;
  return feedbackSecurityRoutingDecisionV1(verified.value.report).route === "ordinary-feedback"
    ? verified.value
    : undefined;
}

function consumeAbuse(state: Runtime, at: Date, address: Uint8Array): boolean {
  const bucketStart = Math.floor(at.getTime() / DAY_MS) * DAY_MS;
  const identity = abuseIdentity(state.abuseKeys.snapshot(at).active.key, address);
  const id = `${String(bucketStart)}:${identity}`;
  const bucket = state.store.abuse.get(id) ?? {
    count: 0,
    expiresAt: new Date(bucketStart + ABUSE_LIFETIME_MS),
  };
  if (bucket.count >= state.limits.perIdentity) return false;
  bucket.count += 1;
  state.store.abuse.set(id, bucket);
  return true;
}

function accept(
  state: Runtime,
  at: Date,
  bytes: Uint8Array,
  prepared: PreparedFeedbackReportV1,
): SubmitResult {
  const cap = capability();
  const expiresAt = new Date(at.getTime() + RECEIPT_LIFETIME_MS);
  const payloadId = randomBytes(16).toString("hex");
  const keys = state.dedupeKeys.snapshot(at);
  const active = dedupeIdentity(keys.active.key, prepared.report);
  const lookups = [
    active,
    ...keys.predecessors.slice(0, 2).map((key) => dedupeIdentity(key.key, prepared.report)),
  ];
  state.store.admit(
    active,
    lookups,
    {
      id: payloadId,
      groupId: randomBytes(16).toString("hex"),
      bytes: Uint8Array.from(bytes),
      report: prepared.report,
      createdAt: at,
      expiresAt: new Date(at.getTime() + OPEN_ITEM_LIFETIME_MS),
    },
    {
      id: cap.id,
      payloadId,
      secretHash: receiptHash(cap.secret) ?? "",
      expiresAt,
      closed: false,
    },
    at,
  );
  state.logger.event("accepted");
  state.metrics.increment("accepted");
  return {
    status: 202,
    body: { receiptId: cap.id, receiptSecret: cap.secret, expiresAt: expiresAt.toISOString() },
  };
}

function submitSync(
  state: Runtime,
  bytes: Uint8Array,
  digest: string,
  address: Uint8Array,
): SubmitResult {
  const at = state.now();
  if (bytes.byteLength > state.limits.bodyBytes) {
    return reject(413, "payload-too-large", state);
  }
  const prepared = verifiedReport(bytes, digest);
  if (prepared === undefined) return reject(422, "report-rejected", state);
  if (!hasCapacity(state, bytes)) return reject(503, "temporarily-unavailable", state);
  if (!consumeAbuse(state, at, address)) return reject(429, "rate-limited", state);
  return accept(state, at, bytes, prepared);
}

function receiptSync(state: Runtime, id: string, secret: string): ReceiptResult {
  const record = state.store.receipts.get(id);
  const expected = receiptHash(secret) ?? receiptHashBytes(new Uint8Array(32));
  const actual = record?.secretHash ?? receiptHashBytes(new Uint8Array(32));
  if (
    record === undefined ||
    record.expiresAt.getTime() <= state.now().getTime() ||
    !safeHashEqual(expected, actual)
  ) {
    return { status: 404, body: { error: "invalid-request" } };
  }
  return {
    status: 200,
    body: {
      receiptId: record.id,
      status: record.closed ? "closed" : "received",
      expiresAt: record.expiresAt.toISOString(),
    },
  };
}

export function createInMemoryFeedbackIntake(
  options: InMemoryIntakeOptions = {},
): InMemoryFeedbackIntake {
  const state = runtime(options);
  return {
    submit: (bytes, digest, address) => Promise.resolve(submitSync(state, bytes, digest, address)),
    receipt: (id, secret) => Promise.resolve(receiptSync(state, id, secret)),
    inspect: () => state.store.inspect(),
    purge: () => state.store.purge(state.now()),
  };
}

function reject(
  status: 413 | 422 | 429 | 503,
  error: "payload-too-large" | "report-rejected" | "rate-limited" | "temporarily-unavailable",
  state: Runtime,
): SubmitResult {
  state.logger.event(status === 429 ? "rate-limited" : status === 503 ? "unavailable" : "rejected");
  state.metrics.increment(
    status === 429 ? "rate_limited" : status === 503 ? "unavailable" : "rejected",
  );
  if (status === 429) {
    return {
      status,
      body: { error: "rate-limited", message: "Try again later." },
      retryAfterSeconds: 300,
    };
  }
  return { status, body: { error } };
}
