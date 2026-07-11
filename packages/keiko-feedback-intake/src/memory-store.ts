import type { FeedbackReportV1 } from "@oscharko-dev/keiko-contracts/feedback-report";
import { DEDUPE_LIFETIME_MS, type IntakeInspection } from "./types.js";

export interface PayloadRecord {
  readonly id: string;
  readonly groupId: string;
  readonly bytes: Uint8Array;
  readonly report: FeedbackReportV1;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface ReceiptRecord {
  readonly id: string;
  readonly payloadId: string;
  readonly secretHash: string;
  readonly expiresAt: Date;
  readonly closed: boolean;
}

interface DedupeRecord {
  readonly identity: string;
  readonly groupId: string;
  readonly payloadIds: string[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
  count: number;
}

export class InMemoryIntakeStore {
  readonly payloads = new Map<string, PayloadRecord>();
  readonly receipts = new Map<string, ReceiptRecord>();
  readonly dedupe = new Map<string, DedupeRecord>();
  readonly abuse = new Map<string, { count: number; expiresAt: Date }>();

  inspect(): IntakeInspection {
    return {
      payloadCount: this.payloads.size,
      receiptCount: this.receipts.size,
      dedupeCount: this.dedupe.size,
      abuseBucketCount: this.abuse.size,
    };
  }

  admit(
    identity: string,
    lookupIdentities: readonly string[],
    payload: PayloadRecord,
    receipt: ReceiptRecord,
    now: Date,
  ): void {
    const matched = lookupIdentities
      .map((candidate) => this.dedupe.get(candidate))
      .find((candidate) => candidate !== undefined);
    const reusable = matched?.payloadIds
      .map((id) => this.payloads.get(id))
      .find(
        (item) => item !== undefined && item.expiresAt.getTime() >= receipt.expiresAt.getTime(),
      );
    const selected = reusable ?? payload;
    if (reusable === undefined) this.payloads.set(payload.id, payload);
    if (matched === undefined) {
      this.dedupe.set(identity, {
        identity,
        groupId: payload.groupId,
        payloadIds: [payload.id],
        createdAt: now,
        expiresAt: new Date(now.getTime() + DEDUPE_LIFETIME_MS),
        count: 1,
      });
    } else {
      matched.count = Math.min(matched.count + 1, Number.MAX_SAFE_INTEGER);
      if (reusable === undefined) matched.payloadIds.push(payload.id);
    }
    this.receipts.set(receipt.id, { ...receipt, payloadId: selected.id });
  }

  purge(now: Date): {
    readonly payloads: number;
    readonly receipts: number;
    readonly dedupe: number;
    readonly abuse: number;
  } {
    return {
      payloads: purgeMap(this.payloads, now),
      receipts: purgeMap(this.receipts, now),
      dedupe: purgeMap(this.dedupe, now),
      abuse: purgeMap(this.abuse, now),
    };
  }
}

function purgeMap<T extends { readonly expiresAt: Date }>(map: Map<string, T>, now: Date): number {
  let count = 0;
  for (const [key, value] of map)
    if (value.expiresAt.getTime() <= now.getTime()) {
      map.delete(key);
      count += 1;
    }
  return count;
}
