// Declaration for the shared #3390 qualification-evidence receipt writer. Kept next to the .mjs
// source (mirrors scripts/lib/package-coverage-gate-scripts.d.mts) so a strict-TypeScript consumer
// outside scripts/ -- currently the coding-issue-journey live Playwright harness under tests/e2e/,
// which is part of the root tsconfig.json program and cannot `allowJs` an untyped .mjs -- can import
// the SAME writer the macOS/Windows platform qualification drivers already use, instead of growing
// a second copy (AGENTS.md §5; issue #3390 audit F8 is exactly the byte-identical-copy defect this
// module was extracted to fix once; a Playwright-side copy would reintroduce it).

export interface QualificationEvidenceReceiptFacts {
  readonly sourceCommitSha: string;
  readonly platformTarget: string;
  readonly result: "passed" | "failed";
  readonly [field: string]: unknown;
}

export interface WriteQualificationEvidenceReceiptInput {
  readonly receiptsDir: string;
  readonly scenarioId: string;
  readonly receipt: QualificationEvidenceReceiptFacts;
  readonly recordedAt: string;
  readonly provenance?: "real-model" | "scripted";
}

/**
 * Writes `<scenarioId>.artifact` (the receipt bytes themselves) and `<scenarioId>.receipt.json`
 * (the content-free `{ scenarioId, commitSha, platform, testStatus, recordedAt, provenance }`
 * pointer `scripts/check-coding-issue-journey-evidence.mjs` reads) into `receiptsDir`. The caller
 * is responsible for `receiptsDir` already existing.
 */
export function writeQualificationEvidenceReceipt(
  input: WriteQualificationEvidenceReceiptInput,
): void;

export interface WriteCodingIssueJourneyFlowEvidenceReceiptInput {
  readonly receiptsDir: string;
  readonly artifact: CodeTaskQualificationFlowArtifactV1;
  readonly platform: CodeTaskEvidencePlatform;
  readonly recordedAt: string;
}

/** Writes the flow artifact plus its independently hash-bound metadata receipt. */
export function writeCodingIssueJourneyFlowEvidenceReceipt(
  input: WriteCodingIssueJourneyFlowEvidenceReceiptInput,
): void;
import type {
  CodeTaskEvidencePlatform,
  CodeTaskQualificationFlowArtifactV1,
} from "@oscharko-dev/keiko-contracts";
