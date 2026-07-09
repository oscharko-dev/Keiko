import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CodingWorkbenchAuthorityEnvelope } from "@oscharko-dev/keiko-contracts";
import type { AutonomousDeliveryConfirmation } from "./autonomousDeliveryPolicy.js";

export interface AutonomousDeliveryApprovalStore {
  issue(
    envelope: CodingWorkbenchAuthorityEnvelope,
    confirmedAt: string,
  ): AutonomousDeliveryConfirmation;
  consume(
    envelope: CodingWorkbenchAuthorityEnvelope,
    confirmation: AutonomousDeliveryConfirmation,
    nowIso: string,
  ): boolean;
}

interface ApprovalRecord {
  readonly envelopeDigest: string;
  readonly expiresAt: string;
}

export function createAutonomousDeliveryApprovalStore(
  secret: Buffer = randomBytes(32),
): AutonomousDeliveryApprovalStore {
  const proofs = new Map<string, ApprovalRecord>();
  return {
    issue(envelope, confirmedAt): AutonomousDeliveryConfirmation {
      const envelopeDigest = digestEnvelope(envelope);
      const nonce = randomBytes(32).toString("hex");
      const approvalProofDigest = createHmac("sha256", secret)
        .update([envelopeDigest, confirmedAt, nonce].join("\n"))
        .digest("hex");
      proofs.set(approvalProofDigest, { envelopeDigest, expiresAt: envelope.expiresAt });
      return { confirmed: true, approvalProofDigest, confirmedAt };
    },
    consume(envelope, confirmation, nowIso): boolean {
      if (!confirmation.confirmed) return false;
      const record = proofs.get(confirmation.approvalProofDigest);
      if (record === undefined) return false;
      proofs.delete(confirmation.approvalProofDigest);
      if (expired(nowIso, record.expiresAt)) return false;
      return timingSafeStringEqual(record.envelopeDigest, digestEnvelope(envelope));
    },
  };
}

function expired(nowIso: string, expiresAt: string): boolean {
  const nowMs = Date.parse(nowIso);
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isNaN(nowMs) || Number.isNaN(expiresAtMs) || nowMs >= expiresAtMs;
}

function digestEnvelope(envelope: CodingWorkbenchAuthorityEnvelope): string {
  return createHmac("sha256", "keiko-autonomous-delivery-envelope-v1")
    .update(canonicalJson(envelope))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
