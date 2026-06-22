// Preflight large-file classification (Epic #1160, Issue #1286).
//
// Runs before parser execution. Decides the extraction strategy from the file's size, extension,
// and media type against the resource policy, so a file above the policy ceiling is rejected
// before any unsafe work begins, and a large supported PDF is routed to the progressive path.
// Pure function — no IO, no clock.

import type {
  LargeDocumentPreflight,
  LargeDocumentResourcePolicy,
} from "@oscharko-dev/keiko-contracts";

import { isLegacyBinaryOfficeFormat } from "./legacy-format.js";

export interface PreflightInput {
  readonly extension: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

function isPdf(input: PreflightInput): boolean {
  return (
    input.extension.toLowerCase() === "pdf" || input.mediaType.toLowerCase() === "application/pdf"
  );
}

export function classifyLargeDocument(
  input: PreflightInput,
  policy: LargeDocumentResourcePolicy,
): LargeDocumentPreflight {
  if (input.sizeBytes > policy.maxRawFileBytes) {
    return {
      strategy: "oversized",
      decision: "reject-oversized",
      sizeBytes: input.sizeBytes,
      reason: `file size exceeds the configured ${String(policy.maxRawFileBytes)}-byte raw ceiling`,
    };
  }
  if (isLegacyBinaryOfficeFormat(input.extension)) {
    return {
      strategy: "unsupported",
      decision: "accept-standard",
      sizeBytes: input.sizeBytes,
      reason: "legacy binary office format has no bundled converter",
    };
  }
  if (isPdf(input) && input.sizeBytes >= policy.largeFileThresholdBytes) {
    const estimatedWindows = Math.max(
      1,
      Math.ceil(input.sizeBytes / (policy.largeFileThresholdBytes / 4)),
    );
    return {
      strategy: "progressive-pdf",
      decision: "accept-progressive",
      sizeBytes: input.sizeBytes,
      estimatedWindows,
    };
  }
  return { strategy: "standard-buffer", decision: "accept-standard", sizeBytes: input.sizeBytes };
}

// True when the preflight decision means the discovery layer should run the progressive,
// page-windowed extraction path instead of the existing full-buffer path.
export function usesProgressivePath(preflight: LargeDocumentPreflight): boolean {
  return preflight.decision === "accept-progressive";
}
