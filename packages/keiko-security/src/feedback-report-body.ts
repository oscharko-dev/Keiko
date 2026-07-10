import type {
  FeedbackDispositionRecordV1,
  FeedbackDispositionSidecarV1,
  FeedbackReportV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

export interface FeedbackCanonicalBodyV1 {
  readonly byteLength: number;
  copyBytes(): Uint8Array;
}

export interface PreparedFeedbackReportV1 {
  readonly report: FeedbackReportV1;
  readonly canonicalJson: string;
  readonly canonicalBody: FeedbackCanonicalBodyV1;
  readonly exactBodySha256: string;
  readonly dispositionSidecar: FeedbackDispositionSidecarV1;
}

function freezeJsonValue(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  if (Array.isArray(value)) {
    for (const child of value) freezeJsonValue(child);
  } else {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
      freezeJsonValue(child);
    }
  }
  Object.freeze(value);
}

function canonicalBodySnapshot(bytes: Uint8Array): FeedbackCanonicalBodyV1 {
  const snapshot = bytes.slice();
  return Object.freeze({
    byteLength: snapshot.length,
    copyBytes: (): Uint8Array => snapshot.slice(),
  });
}

export function immutablePreparedFeedbackReportV1(
  report: FeedbackReportV1,
  canonicalJson: string,
  canonicalBytes: Uint8Array,
  exactBodySha256: string,
  dispositionRecords: readonly FeedbackDispositionRecordV1[] = [],
): PreparedFeedbackReportV1 {
  freezeJsonValue(report);
  const records = dispositionRecords.map((record) => ({ ...record, target: { ...record.target } }));
  freezeJsonValue(records);
  return Object.freeze({
    report,
    canonicalJson,
    canonicalBody: canonicalBodySnapshot(canonicalBytes),
    exactBodySha256,
    dispositionSidecar: Object.freeze({ exactBodySha256, records }),
  });
}
