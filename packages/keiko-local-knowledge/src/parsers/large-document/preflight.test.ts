import { DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY } from "@oscharko-dev/keiko-contracts";
import type { DocumentId } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import {
  classifyLargeDocument,
  isLegacyBinaryOfficeFormat,
  legacyFormatDiagnostic,
  legacyFormatGuidance,
  usesProgressivePath,
} from "./index.js";

const POLICY = DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY;

describe("classifyLargeDocument", () => {
  it("rejects a file above the raw byte ceiling before any work", () => {
    const result = classifyLargeDocument(
      { extension: "pdf", mediaType: "application/pdf", sizeBytes: POLICY.maxRawFileBytes + 1 },
      POLICY,
    );
    expect(result.strategy).toBe("oversized");
    expect(result.decision).toBe("reject-oversized");
    expect(usesProgressivePath(result)).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("routes a large PDF to the progressive path", () => {
    const result = classifyLargeDocument(
      { extension: "pdf", mediaType: "application/pdf", sizeBytes: POLICY.largeFileThresholdBytes },
      POLICY,
    );
    expect(result.strategy).toBe("progressive-pdf");
    expect(result.decision).toBe("accept-progressive");
    expect(usesProgressivePath(result)).toBe(true);
    expect(result.estimatedWindows).toBeGreaterThan(0);
  });

  it("keeps a small PDF on the standard buffer path (backward compatible)", () => {
    const result = classifyLargeDocument(
      { extension: "pdf", mediaType: "application/pdf", sizeBytes: 4096 },
      POLICY,
    );
    expect(result.strategy).toBe("standard-buffer");
    expect(result.decision).toBe("accept-standard");
    expect(usesProgressivePath(result)).toBe(false);
  });

  it("classifies legacy binary office formats as unsupported on the standard path", () => {
    const result = classifyLargeDocument(
      { extension: "doc", mediaType: "application/msword", sizeBytes: 5_000 },
      POLICY,
    );
    expect(result.strategy).toBe("unsupported");
    expect(result.decision).toBe("accept-standard");
  });

  it("keeps a large non-PDF document on the standard path", () => {
    const result = classifyLargeDocument(
      { extension: "txt", mediaType: "text/plain", sizeBytes: POLICY.largeFileThresholdBytes + 1 },
      POLICY,
    );
    expect(result.strategy).toBe("standard-buffer");
  });
});

describe("legacy-format guidance", () => {
  it("recognizes .doc / .ppt / .xls and ignores modern formats", () => {
    expect(isLegacyBinaryOfficeFormat("doc")).toBe(true);
    expect(isLegacyBinaryOfficeFormat("PPT")).toBe(true);
    expect(isLegacyBinaryOfficeFormat("xls")).toBe(true);
    expect(isLegacyBinaryOfficeFormat("docx")).toBe(false);
    expect(isLegacyBinaryOfficeFormat("pdf")).toBe(false);
  });

  it("emits a CONVERTER_UNAVAILABLE warning with content-free guidance", () => {
    const diag = legacyFormatDiagnostic("doc", "doc-1" as DocumentId);
    expect(diag).toBeDefined();
    expect(diag?.code).toBe("CONVERTER_UNAVAILABLE");
    expect(diag?.severity).toBe("warning");
    expect(diag?.message).not.toContain("/");
    expect(legacyFormatGuidance("doc")).toContain(".docx");
  });

  it("returns undefined for a non-legacy format", () => {
    expect(legacyFormatDiagnostic("pdf", "doc-1" as DocumentId)).toBeUndefined();
    expect(legacyFormatGuidance("pdf")).toBeUndefined();
  });
});
