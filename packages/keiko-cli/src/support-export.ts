// Canonical support report file I/O. The former JSONL bundle serializer was retired by #3534.
import { closeSync, fstatSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { MAX_SUPPORT_REPORT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  openSafeArtifactFile,
  publishSafeArtifactFileSet,
  type SafeArtifactDurabilityAssurance,
  type SafeArtifactPermissionAssurance,
} from "@oscharko-dev/keiko-security/fs-hardening";
import { SupportReportError } from "@oscharko-dev/keiko-activity-log/reader";

/** Gzip is only a bounded transport wrapper around the unchanged canonical report bytes. */
function decodeSupportReportTransport(bytes: Buffer): Buffer {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_SUPPORT_REPORT_BYTES });
  } catch (error) {
    const exceeded =
      error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE";
    throw new SupportReportError(exceeded ? "report-budget-exceeded" : "corrupt-report");
  }
}

/** Known transport facts only; a failure before header inspection leaves transport absent. */
export interface SupportReportInputFacts {
  readonly inputBytes: number;
  readonly inputTransport?: "raw" | "gzip";
}

function readBoundedReportBytes(descriptor: number, size: number): Buffer {
  if (size > MAX_SUPPORT_REPORT_BYTES) throw new SupportReportError("report-budget-exceeded");
  // One extra byte detects growth without retaining unbounded chunks or trusting a stale stat.
  const bytes = Buffer.allocUnsafe(size + 1);
  let total = 0;
  while (total < bytes.length) {
    const count = readSync(descriptor, bytes, {
      offset: total,
      length: bytes.length - total,
      position: null,
    });
    if (count === 0) break;
    total += count;
  }
  const finalSize = fstatSync(descriptor).size;
  if (total > MAX_SUPPORT_REPORT_BYTES || finalSize > MAX_SUPPORT_REPORT_BYTES)
    throw new SupportReportError("report-budget-exceeded");
  if (total !== size || finalSize !== size) throw new SupportReportError("corrupt-report");
  return bytes.subarray(0, total);
}

function decodeStrictUtf8(bytes: Buffer): string {
  try {
    // Preserve BOM bytes so strict canonical parsing, rather than decoding, decides validity.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SupportReportError("corrupt-report");
  }
}

/** Reads exactly the human-selected file through the existing private-file handle checks. */
export function readSupportReportFile(
  path: string,
  recordInput?: (facts: SupportReportInputFacts) => void,
): string {
  const descriptor = openSafeArtifactFile(path, {
    artifactClass: "support-report",
    mode: "read",
    trustedRoot: dirname(path),
  });
  try {
    const inputBytes = fstatSync(descriptor).size;
    recordInput?.({ inputBytes });
    const bytes = readBoundedReportBytes(descriptor, inputBytes);
    const inputTransport = bytes[0] === 0x1f && bytes[1] === 0x8b ? "gzip" : "raw";
    recordInput?.({ inputBytes, inputTransport });
    return decodeStrictUtf8(decodeSupportReportTransport(bytes));
  } finally {
    closeSync(descriptor);
  }
}

/** What one publication committed, with the assurances the platform could give it. */
export interface SupportReportPublication {
  readonly path: string;
  // `recovered` when an identical interrupted publication of the same bytes was completed.
  readonly status: "published" | "recovered";
  readonly reportBytes: number;
  readonly permissionAssurance: SafeArtifactPermissionAssurance;
  readonly durabilityAssurance: SafeArtifactDurabilityAssurance;
}

/** Atomic, exclusive one-file publication. Intermediate stages cannot be mistaken for reports. */
export function publishSupportReportFile(path: string, contents: string): SupportReportPublication {
  const reportBytes = Buffer.byteLength(contents);
  if (reportBytes > MAX_SUPPORT_REPORT_BYTES)
    throw new SupportReportError("report-budget-exceeded");
  const result = publishSafeArtifactFileSet([{ path, contents, artifactClass: "support-report" }], {
    commitPath: path,
    trustedRoot: dirname(path),
  });
  return {
    path,
    status: result.status,
    reportBytes,
    permissionAssurance: result.permissionAssurance,
    durabilityAssurance: result.durabilityAssurance,
  };
}

export { describeErrorKind } from "@oscharko-dev/keiko-activity-log/reader";
