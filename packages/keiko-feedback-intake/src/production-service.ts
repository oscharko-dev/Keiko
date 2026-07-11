import { randomBytes } from "node:crypto";
import { verifyCanonicalFeedbackReportBodyV1 } from "@oscharko-dev/keiko-security/feedback-report";
import { feedbackSecurityRoutingDecisionV1 } from "@oscharko-dev/keiko-security/feedback-security-routing";
import {
  abuseIdentity,
  capability,
  dedupeIdentity,
  receiptHash,
  receiptHashBytes,
  safeHashEqual,
} from "./crypto.js";
import type {
  PgAdmission,
  PgAdmissionResult,
  PgAttemptReservation,
  PgAttemptResult,
} from "./postgres.js";
import {
  ABUSE_LIFETIME_MS,
  DAY_MS,
  DEDUPE_LIFETIME_MS,
  OPEN_ITEM_LIFETIME_MS,
  RECEIPT_LIFETIME_MS,
  type ContentFreeLogger,
  type ContentFreeMetrics,
  type IntakeLimits,
  type IntakeSecretProvider,
  type ReceiptResult,
  type SubmitResult,
} from "./types.js";

export interface ProductionIntakeRepository {
  reserveAttempt(input: PgAttemptReservation): Promise<PgAttemptResult>;
  admit(input: PgAdmission): Promise<PgAdmissionResult>;
  findReceipt(
    id: string,
  ): Promise<
    | { readonly secretHash: Uint8Array; readonly expiresAt: Date; readonly closed: boolean }
    | undefined
  >;
}

export interface ProductionServiceOptions {
  readonly repository: ProductionIntakeRepository;
  readonly limits: IntakeLimits;
  readonly abuseKeys: IntakeSecretProvider;
  readonly dedupeKeys: IntakeSecretProvider;
  readonly now: () => Date;
  readonly logger: ContentFreeLogger;
  readonly metrics: ContentFreeMetrics;
  readonly onUnavailable?: (() => void) | undefined;
}

type AdmissionWithCapability = PgAdmission & {
  readonly capability: { readonly id: string; readonly secret: string; readonly expiresAt: Date };
};

export interface PostgresFeedbackIntakeService {
  beginAttempt(address: Uint8Array): Promise<AttemptLease>;
  submitReserved(bytes: Uint8Array, digest: string): Promise<SubmitResult>;
  submit(bytes: Uint8Array, digest: string, address: Uint8Array): Promise<SubmitResult>;
  receipt(id: string, secret: string): Promise<ReceiptResult>;
}

interface ConcurrencyState {
  inFlight: number;
}

interface ReceiptConcurrencyState {
  inFlight: number;
}

export type AttemptLease =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly result: SubmitResult };

function failure(
  status: 413 | 422 | 429 | 503,
  error: "payload-too-large" | "report-rejected" | "rate-limited" | "temporarily-unavailable",
  options: ProductionServiceOptions,
): SubmitResult {
  const event = status === 429 ? "rate-limited" : status === 503 ? "unavailable" : "rejected";
  options.logger.event(event);
  options.metrics.increment(event === "rate-limited" ? "rate_limited" : event);
  if (status === 429) {
    const now = options.now().getTime();
    const untilMidnight = DAY_MS - (now % DAY_MS);
    const retryAfterSeconds = Math.min(
      3_600,
      Math.max(300, Math.ceil(untilMidnight / 300_000) * 300),
    );
    return { status, body: { error, message: "Try again later." }, retryAfterSeconds };
  }
  return { status, body: { error } };
}

function admission(
  options: ProductionServiceOptions,
  bytes: Uint8Array,
  digest: string,
): AdmissionWithCapability | SubmitResult {
  if (bytes.byteLength > options.limits.bodyBytes) {
    return failure(413, "payload-too-large", options);
  }
  const verified = verifyCanonicalFeedbackReportBodyV1({ bytes, claimedDigest: digest });
  if (
    !verified.ok ||
    feedbackSecurityRoutingDecisionV1(verified.value.report).route !== "ordinary-feedback"
  ) {
    return failure(422, "report-rejected", options);
  }
  const now = options.now();
  const dedupeSnapshot = options.dedupeKeys.snapshot(now);
  const dedupeKeys = [dedupeSnapshot.active, ...dedupeSnapshot.predecessors.slice(0, 2)];
  const cap = capability();
  const receiptExpiresAt = new Date(now.getTime() + RECEIPT_LIFETIME_MS);
  return admissionRecord(
    options,
    verified.value.report,
    bytes,
    digest,
    now,
    dedupeKeys,
    cap,
    receiptExpiresAt,
  );
}

function admissionRecord(
  options: ProductionServiceOptions,
  report: Parameters<typeof dedupeIdentity>[1],
  bytes: Uint8Array,
  digest: string,
  now: Date,
  dedupeKeys: readonly ReturnType<IntakeSecretProvider["snapshot"]>["active"][],
  cap: ReturnType<typeof capability>,
  receiptExpiresAt: Date,
): AdmissionWithCapability {
  return {
    groupId: randomBytes(16).toString("hex"),
    payloadId: randomBytes(16).toString("hex"),
    receiptId: cap.id,
    dedupeKeyId: dedupeKeys[0]?.id ?? "",
    dedupeHmac: Buffer.from(dedupeIdentity(dedupeKeys[0]?.key ?? new Uint8Array(), report), "hex"),
    dedupeCandidates: dedupeKeys.map((key) => ({
      keyId: key.id,
      hmac: Buffer.from(dedupeIdentity(key.key, report), "hex"),
    })),
    canonicalBytes: Uint8Array.from(bytes),
    exactBodySha256: digest,
    receiptSecretHash: Buffer.from(receiptHash(cap.secret) ?? "", "hex"),
    createdAt: now,
    payloadExpiresAt: new Date(now.getTime() + OPEN_ITEM_LIFETIME_MS),
    receiptExpiresAt,
    dedupeExpiresAt: new Date(now.getTime() + DEDUPE_LIFETIME_MS),
    openPayloadCount: options.limits.openPayloadCount,
    openPayloadBytes: options.limits.openPayloadBytes,
    storageDeadlineMs: options.limits.storageDeadlineMs,
    capability: { id: cap.id, secret: cap.secret, expiresAt: receiptExpiresAt },
  };
}

async function submit(
  options: ProductionServiceOptions,
  state: ConcurrencyState,
  bytes: Uint8Array,
  digest: string,
  address: Uint8Array,
): Promise<SubmitResult> {
  const lease = await beginAttempt(options, state, address);
  if (!lease.ok) return lease.result;
  try {
    return await submitReserved(options, bytes, digest);
  } finally {
    lease.release();
  }
}

async function beginAttempt(
  options: ProductionServiceOptions,
  state: ConcurrencyState,
  address: Uint8Array,
): Promise<AttemptLease> {
  if (state.inFlight >= options.limits.concurrency) {
    return { ok: false, result: failure(503, "temporarily-unavailable", options) };
  }
  state.inFlight += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    state.inFlight -= 1;
  };
  try {
    const now = options.now();
    const bucketStart = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
    const abuseSnapshot = options.abuseKeys.snapshot(now);
    const abuseKeys = [abuseSnapshot.active, ...abuseSnapshot.predecessors.slice(0, 1)];
    const reserved = await options.repository.reserveAttempt({
      abuseKeyId: abuseKeys[0]?.id ?? "",
      abuseHmac: Buffer.from(abuseIdentity(abuseKeys[0]?.key ?? new Uint8Array(), address), "hex"),
      abuseCandidates: abuseKeys.map((key) => ({
        keyId: key.id,
        hmac: Buffer.from(abuseIdentity(key.key, address), "hex"),
      })),
      at: now,
      bucketStart,
      expiresAt: new Date(bucketStart.getTime() + ABUSE_LIFETIME_MS),
      perIdentityLimit: options.limits.perIdentity,
      globalLimit: options.limits.global,
      storageDeadlineMs: options.limits.storageDeadlineMs,
    });
    if (reserved.reserved) return { ok: true, release };
    release();
    return { ok: false, result: failure(429, "rate-limited", options) };
  } catch {
    options.onUnavailable?.();
    release();
    return { ok: false, result: failure(503, "temporarily-unavailable", options) };
  }
}

async function submitReserved(
  options: ProductionServiceOptions,
  bytes: Uint8Array,
  digest: string,
): Promise<SubmitResult> {
  try {
    const candidate = admission(options, bytes, digest);
    if (!("receiptId" in candidate)) return candidate;
    const stored = await options.repository.admit(candidate);
    if (!stored.accepted) return failure(503, "temporarily-unavailable", options);
    options.logger.event("accepted");
    options.metrics.increment("accepted");
    return {
      status: 202,
      body: {
        receiptId: candidate.capability.id,
        receiptSecret: candidate.capability.secret,
        expiresAt: candidate.capability.expiresAt.toISOString(),
      },
    };
  } catch {
    options.onUnavailable?.();
    return failure(503, "temporarily-unavailable", options);
  }
}

async function receipt(
  options: ProductionServiceOptions,
  state: ReceiptConcurrencyState,
  id: string,
  secret: string,
): Promise<ReceiptResult> {
  if (state.inFlight >= options.limits.receiptConcurrency) {
    return { status: 404, body: { error: "invalid-request" } };
  }
  state.inFlight += 1;
  try {
    return await findReceipt(options, id, secret);
  } finally {
    state.inFlight -= 1;
  }
}

async function findReceipt(
  options: ProductionServiceOptions,
  id: string,
  secret: string,
): Promise<ReceiptResult> {
  let found: Awaited<ReturnType<ProductionIntakeRepository["findReceipt"]>>;
  try {
    found = await options.repository.findReceipt(id);
  } catch {
    options.onUnavailable?.();
    found = undefined;
  }
  const expected = receiptHash(secret) ?? receiptHashBytes(new Uint8Array(32));
  const actual =
    found?.secretHash === undefined
      ? receiptHashBytes(new Uint8Array(32))
      : Buffer.from(found.secretHash).toString("hex");
  if (
    found === undefined ||
    found.expiresAt.getTime() <= options.now().getTime() ||
    !safeHashEqual(expected, actual)
  )
    return { status: 404, body: { error: "invalid-request" } };
  return {
    status: 200,
    body: {
      receiptId: id,
      status: found.closed ? "closed" : "received",
      expiresAt: found.expiresAt.toISOString(),
    },
  };
}

export function createPostgresFeedbackIntake(
  options: ProductionServiceOptions,
): PostgresFeedbackIntakeService {
  const state: ConcurrencyState = { inFlight: 0 };
  const receiptState: ReceiptConcurrencyState = { inFlight: 0 };
  return {
    beginAttempt: (address) => beginAttempt(options, state, address),
    submitReserved: (bytes, digest) => submitReserved(options, bytes, digest),
    submit: (bytes, digest, address) => submit(options, state, bytes, digest, address),
    receipt: (id, secret) => receipt(options, receiptState, id, secret),
  };
}
