import type {
  FeedbackDispositionRecordV1,
  FeedbackReportV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";
import { vi } from "vitest";

import type { PreparedFeedbackSnapshotV1 } from "@/lib/feedback-api";

export function preparedSnapshot(): PreparedFeedbackSnapshotV1 {
  const report: FeedbackReportV1 = {
    schemaVersion: "1",
    privacyContractVersion: "1",
    redactionProvenance: { engineVersion: "1", rules: [] },
    productVersion: "0.2.14",
    platform: "Linux",
    summary: { title: "Bearer", description: "The login button remained disabled" },
    steps: "Open Settings and select Continue.",
    expectedResult: "The login flow continues.",
    actualResult: "The login button remained disabled.",
    impact: "Degrades core workflow",
    diagnostics: { category: "defect", featureArea: "model-configuration" },
  };
  const exactBodySha256 = "a".repeat(64);
  return Object.freeze({
    report: Object.freeze(report),
    canonicalJson: JSON.stringify(report),
    exactBodySha256,
    dispositionSidecar: Object.freeze({ exactBodySha256, records: Object.freeze([]) }),
  });
}

export function preparedSnapshotWithOptionalDispositions(): PreparedFeedbackSnapshotV1 {
  const base = preparedSnapshot();
  const target = { kind: "draft-field", field: "browserDescription" } as const;
  const records: readonly FeedbackDispositionRecordV1[] = [
    {
      action: "redacted",
      reason: "complete-sensitive-span",
      unitKind: "structured-value",
      target,
    },
    {
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "quoted-segment",
      target,
    },
    {
      action: "omitted",
      reason: "no-safe-optional-content",
      unitKind: "optional-field",
      target,
    },
  ];
  return Object.freeze({
    ...base,
    dispositionSidecar: Object.freeze({
      exactBodySha256: base.exactBodySha256,
      records: Object.freeze(records),
    }),
  });
}

export function preparedSnapshotWithBrowserRemainder(): PreparedFeedbackSnapshotV1 {
  const base = preparedSnapshot();
  const report = Object.freeze({
    ...base.report,
    browserDescription: "Firefox safe remainder.",
  });
  const target = { kind: "draft-field", field: "browserDescription" } as const;
  const records: readonly FeedbackDispositionRecordV1[] = [
    {
      action: "redacted",
      reason: "complete-sensitive-span",
      unitKind: "structured-value",
      target,
    },
    {
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "line-remainder",
      target,
    },
  ];
  return Object.freeze({
    ...base,
    report,
    canonicalJson: JSON.stringify(report),
    dispositionSidecar: Object.freeze({
      exactBodySha256: base.exactBodySha256,
      records: Object.freeze(records),
    }),
  });
}

export function preparedSnapshotWithAttachmentDispositions(): PreparedFeedbackSnapshotV1 {
  const base = preparedSnapshot();
  const report = Object.freeze({
    ...base.report,
    attachments: Object.freeze(["Safe attachment remainder."]),
  });
  const records: readonly FeedbackDispositionRecordV1[] = [
    {
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "line-remainder",
      target: { kind: "attachment", ordinal: 0 },
    },
    {
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "quoted-segment",
      target: { kind: "attachment", ordinal: 1 },
    },
    {
      action: "omitted",
      reason: "no-safe-optional-content",
      unitKind: "attachment",
      target: { kind: "attachment", ordinal: 1 },
    },
  ];
  return Object.freeze({
    ...base,
    report,
    canonicalJson: JSON.stringify(report),
    dispositionSidecar: Object.freeze({
      exactBodySha256: base.exactBodySha256,
      records: Object.freeze(records),
    }),
  });
}

export function preparedSnapshotWithLeadingAttachmentOmission(): PreparedFeedbackSnapshotV1 {
  const base = preparedSnapshot();
  const report = Object.freeze({
    ...base.report,
    attachments: Object.freeze(["Safe second attachment remainder."]),
  });
  const target = { kind: "attachment", ordinal: 0 } as const;
  const records: readonly FeedbackDispositionRecordV1[] = [
    {
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "quoted-segment",
      target,
    },
    {
      action: "omitted",
      reason: "no-safe-optional-content",
      unitKind: "attachment",
      target,
    },
  ];
  return Object.freeze({
    ...base,
    report,
    canonicalJson: JSON.stringify(report),
    dispositionSidecar: Object.freeze({
      exactBodySha256: base.exactBodySha256,
      records: Object.freeze(records),
    }),
  });
}

export function preparedSnapshotWithSafeAttachment(): PreparedFeedbackSnapshotV1 {
  const base = preparedSnapshot();
  const report = Object.freeze({
    ...base.report,
    attachments: Object.freeze(["Safe attachment remainder."]),
  });
  return Object.freeze({
    ...base,
    report,
    canonicalJson: JSON.stringify(report),
  });
}

export function unreadFile(
  name: string,
  declaredSize: number,
): { readonly file: File; readonly readBytes: ReturnType<typeof vi.fn> } {
  const readBytes = vi.fn().mockResolvedValue(new ArrayBuffer(0));
  const file = new File(["x"], name, { type: "text/plain" });
  Object.defineProperty(file, "size", { value: declaredSize });
  Object.defineProperty(file, "arrayBuffer", { value: readBytes });
  return { file, readBytes };
}
