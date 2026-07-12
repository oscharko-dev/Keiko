import { createHash, randomBytes } from "node:crypto";
import {
  FEEDBACK_PUBLICATION_PROJECTION_VERSION_V1,
  isFeedbackPublicationTargetPolicySnapshotV1,
  type FeedbackPublicationTargetPolicySnapshotV1,
} from "@oscharko-dev/keiko-contracts/feedback-publication";
import type { FeedbackReportV1 } from "@oscharko-dev/keiko-contracts/feedback-report";

export const FEEDBACK_ISSUE_TITLE_MAX_BYTES_V1 = 256;
export const FEEDBACK_ISSUE_BODY_MAX_BYTES_V1 = 65_536;
const PROJECTION_DIGEST_DOMAIN = "keiko-feedback-github-issue-projection-v1";
const TARGET_DIGEST_DOMAIN = "keiko-feedback-github-target-policy-v1";
const MARKER_PREFIX = "<!-- keiko-feedback-reconciliation-v1:";
const ENCODER = new TextEncoder();

export type FeedbackPublicationProjectionErrorCode =
  "invalid-target-policy" | "invalid-marker-entropy" | "title-byte-limit" | "body-byte-limit";

export class FeedbackPublicationProjectionError extends Error {
  constructor(readonly code: FeedbackPublicationProjectionErrorCode) {
    super(`Feedback publication projection failed: ${code}`);
    this.name = "FeedbackPublicationProjectionError";
  }
}

export interface FeedbackIssueProjectionV1 {
  readonly version: typeof FEEDBACK_PUBLICATION_PROJECTION_VERSION_V1;
  readonly title: string;
  readonly body: string;
  readonly reconciliationMarker: string;
  readonly targetPolicyDigest: string;
  readonly projectionDigest: string;
}

function canonicalTarget(target: FeedbackPublicationTargetPolicySnapshotV1): string {
  return JSON.stringify({
    apiOrigin: target.apiOrigin,
    repositoryId: target.repositoryId,
    owner: target.owner,
    repository: target.repository,
    installationId: target.installationId,
    labels: [...target.labels],
    targetKey: target.targetKey,
    labelPolicyVersion: target.labelPolicyVersion,
    targetPolicyVersion: target.targetPolicyVersion,
  });
}

function domainDigest(domain: string, value: string): string {
  return createHash("sha256").update(domain).update("\0").update(value).digest("hex");
}

export function digestFeedbackTargetPolicyV1(
  target: FeedbackPublicationTargetPolicySnapshotV1,
): string {
  if (!isFeedbackPublicationTargetPolicySnapshotV1(target)) {
    throw new FeedbackPublicationProjectionError("invalid-target-policy");
  }
  return domainDigest(TARGET_DIGEST_DOMAIN, canonicalTarget(target));
}

function inertText(value: string): string {
  return value
    .replaceAll("\t", "    ")
    .replaceAll("\\", "＼")
    .replaceAll("@", "＠")
    .replaceAll("#", "＃")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replaceAll("[", "［")
    .replaceAll("]", "］")
    .replaceAll("(", "（")
    .replaceAll(")", "）")
    .replaceAll("!", "！")
    .replaceAll("*", "＊")
    .replaceAll("_", "＿")
    .replaceAll("`", "｀")
    .replaceAll("~", "～")
    .replaceAll("|", "｜")
    .replaceAll("-", "‐")
    .replaceAll(":", "：")
    .replaceAll("/", "／");
}

function section(label: string, value: string): string {
  const inertBlock = inertText(value)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `## ${label}\n\n${inertBlock}`;
}

function evidence(report: FeedbackReportV1): readonly string[] {
  return [
    ...(report.handwrittenEvidence === undefined
      ? []
      : [section("Handwritten evidence", report.handwrittenEvidence)]),
    ...(report.attachments ?? []).map((attachment, index) =>
      section(`Attachment ${String(index + 1)}`, attachment),
    ),
  ];
}

function diagnostics(report: FeedbackReportV1): string {
  const counts = report.diagnostics.severityCounts;
  return [
    `Category: ${report.diagnostics.category}`,
    `Feature area: ${report.diagnostics.featureArea}`,
    ...(counts === undefined
      ? []
      : [
          `Errors: ${String(counts.errors)}`,
          `Warnings: ${String(counts.warnings)}`,
          `Infos: ${String(counts.infos)}`,
        ]),
  ].join("\n");
}

function issueBody(report: FeedbackReportV1, marker: string): string {
  return [
    section("Summary", `${report.summary.title}\n\n${report.summary.description}`),
    section("Keiko version", report.productVersion),
    section("Platform", report.platform),
    ...(report.browserDescription === undefined
      ? []
      : [section("Browser", report.browserDescription)]),
    section("Steps to reproduce", report.steps),
    section("Expected result", report.expectedResult),
    section("Actual result", report.actualResult),
    ...evidence(report),
    section("Diagnostics", diagnostics(report)),
    section("User impact", report.impact),
    marker,
  ].join("\n\n");
}

function markerFromEntropy(entropy: Uint8Array): string {
  if (!(entropy instanceof Uint8Array) || entropy.length !== 32) {
    throw new FeedbackPublicationProjectionError("invalid-marker-entropy");
  }
  return `${MARKER_PREFIX}${Buffer.from(entropy).toString("base64url")} -->`;
}

function markerEntropy(marker: string): Uint8Array {
  const pattern = /^<!-- keiko-feedback-reconciliation-v1:([A-Za-z0-9_-]{43}) -->$/u.exec(marker);
  if (pattern?.[1] === undefined) {
    throw new FeedbackPublicationProjectionError("invalid-marker-entropy");
  }
  const entropy = new Uint8Array(Buffer.from(pattern[1], "base64url"));
  if (entropy.length !== 32 || markerFromEntropy(entropy) !== marker) {
    throw new FeedbackPublicationProjectionError("invalid-marker-entropy");
  }
  return entropy;
}

function assertByteLimit(
  value: string,
  limit: number,
  code: FeedbackPublicationProjectionErrorCode,
): void {
  if (ENCODER.encode(value).length > limit) throw new FeedbackPublicationProjectionError(code);
}

export function createFeedbackIssueProjectionV1(
  report: FeedbackReportV1,
  target: FeedbackPublicationTargetPolicySnapshotV1,
  entropy: () => Uint8Array = () => randomBytes(32),
): FeedbackIssueProjectionV1 {
  const targetPolicyDigest = digestFeedbackTargetPolicyV1(target);
  const reconciliationMarker = markerFromEntropy(entropy());
  const title = `[User Finding]: ${inertText(report.summary.title)}`;
  const body = issueBody(report, reconciliationMarker);
  assertByteLimit(title, FEEDBACK_ISSUE_TITLE_MAX_BYTES_V1, "title-byte-limit");
  assertByteLimit(body, FEEDBACK_ISSUE_BODY_MAX_BYTES_V1, "body-byte-limit");
  const canonicalProjection = JSON.stringify({
    version: FEEDBACK_PUBLICATION_PROJECTION_VERSION_V1,
    title,
    body,
    targetPolicyDigest,
  });
  return Object.freeze({
    version: FEEDBACK_PUBLICATION_PROJECTION_VERSION_V1,
    title,
    body,
    reconciliationMarker,
    targetPolicyDigest,
    projectionDigest: domainDigest(PROJECTION_DIGEST_DOMAIN, canonicalProjection),
  });
}

export function recomputeFeedbackIssueProjectionV1(
  report: FeedbackReportV1,
  target: FeedbackPublicationTargetPolicySnapshotV1,
  reconciliationMarker: string,
): FeedbackIssueProjectionV1 {
  const entropy = markerEntropy(reconciliationMarker);
  return createFeedbackIssueProjectionV1(report, target, () => entropy);
}
