import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";

import {
  CODING_SIDECAR_DOCUMENT_REJECTION_MESSAGES,
  CODING_SIDECAR_DOCUMENT_REJECTIONS,
  countDocumentContentParts,
  isFileContentPartCandidate,
  parseFileContentPart,
} from "./coding-sidecar-document-parts.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n", "latin1").toString("base64");
const filePart = (fileData: string, filename: unknown = "spec.pdf"): Record<string, unknown> => ({
  type: "file",
  file: { filename, file_data: fileData },
});

describe("PDF document parts for a native coding run (#3906)", () => {
  it("admits an inline PDF and rebuilds it with the normalized media type", () => {
    expect(parseFileContentPart(filePart(`data:Application/PDF;base64,${PDF}`))).toEqual({
      kind: "ok",
      part: {
        type: "file",
        file: { filename: "spec.pdf", file_data: `data:application/pdf;base64,${PDF}` },
      },
    });
  });

  it("keeps only a plain file name and otherwise uses the producer's own default", () => {
    const data = `data:application/pdf;base64,${PDF}`;
    const parts = [
      ...["../../etc/passwd", "a/b.pdf", "x\u0000.pdf", 7, "é".repeat(300)].map((name) =>
        filePart(data, name),
      ),
      { type: "file", file: { file_data: data } },
    ];
    for (const part of parts) {
      const parsed = parseFileContentPart(part);
      expect(parsed.kind === "ok" ? parsed.part.file.filename : undefined).toBe("document.pdf");
    }
    const kept = parseFileContentPart(
      filePart(`data:application/pdf;base64,${PDF}`, "Bericht (v2).pdf"),
    );
    expect(kept.kind === "ok" ? kept.part.file.filename : undefined).toBe("Bericht (v2).pdf");
  });

  it("leaves a remote or file reference unsupported: nothing is ever fetched", () => {
    expect(parseFileContentPart(filePart("https://example.invalid/a.pdf"))).toEqual({
      kind: "unsupported",
    });
    expect(parseFileContentPart(filePart("file:///etc/passwd"))).toEqual({ kind: "unsupported" });
    expect(parseFileContentPart({ type: "file", file: { file_id: "file_1" } })).toEqual({
      kind: "unsupported",
    });
    expect(parseFileContentPart({ type: "file", file: { file_data: 7 } })).toEqual({
      kind: "unsupported",
    });
  });

  it.each([
    ["another media type", `data:image/png;base64,${PDF}`, "document-mime-unsupported"],
    ["non-canonical base64", "data:application/pdf;base64,JVBERi0", "document-part-invalid"],
    ["an empty payload", "data:application/pdf;base64,", "document-part-invalid"],
    [
      "a payload without the PDF signature",
      `data:application/pdf;base64,${Buffer.from("hello world!").toString("base64")}`,
      "document-part-invalid",
    ],
    ["a non-base64 URL", "data:application/pdf,%PDF-1.4", "document-part-invalid"],
  ] as const)("refuses %s", (_label, url, reason) => {
    expect(parseFileContentPart(filePart(url))).toEqual({ kind: "rejected", reason });
  });

  it("refuses a document above the attachment bound", () => {
    const oversized = Buffer.concat([
      Buffer.from("%PDF-1.4\n", "latin1"),
      Buffer.alloc(MAX_ATTACHMENT_BYTES),
    ]).toString("base64");
    expect(parseFileContentPart(filePart(`data:application/pdf;base64,${oversized}`))).toEqual({
      kind: "rejected",
      reason: "document-part-too-large",
    });
  });

  it("recognizes file candidates and counts admitted documents across messages", () => {
    expect(isFileContentPartCandidate(filePart("x"))).toBe(true);
    expect(isFileContentPartCandidate({ type: "image_url" })).toBe(false);
    expect(
      countDocumentContentParts([
        { contentParts: [{ type: "text" }, { type: "file" }] },
        {},
        { contentParts: [{ type: "file" }, { type: "image_url" }] },
      ]),
    ).toBe(2);
  });

  it("names every refusal with one fixed message", () => {
    for (const reason of CODING_SIDECAR_DOCUMENT_REJECTIONS) {
      expect(CODING_SIDECAR_DOCUMENT_REJECTION_MESSAGES[reason]).toMatch(/^Request body/u);
    }
  });
});
