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

/** Reads exactly the human-selected file through the existing private-file handle checks. */
export function readSupportReportFile(path: string): string {
  const descriptor = openSafeArtifactFile(path, {
    artifactClass: "support-report",
    mode: "read",
    trustedRoot: dirname(path),
  });
  try {
    if (fstatSync(descriptor).size > MAX_SUPPORT_REPORT_BYTES)
      throw new SupportReportError("report-budget-exceeded");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(32 * 1024);
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_SUPPORT_REPORT_BYTES) throw new SupportReportError("report-budget-exceeded");
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = decodeSupportReportTransport(Buffer.concat(chunks));
    const text = bytes.toString("utf8");
    if (!bytes.equals(Buffer.from(text))) throw new SupportReportError("corrupt-report");
    return text;
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
