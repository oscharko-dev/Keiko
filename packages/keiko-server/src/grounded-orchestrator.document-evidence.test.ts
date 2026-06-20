// End-to-end orchestrator coverage for bounded document evidence (Issue #1285): an explicitly
// connected DOCX produces a valid ConnectedContextPack carrying document-extract excerpts, a
// connected legacy .doc is disclosed with a stable unsupported diagnostic, and existing code
// evidence in the same mixed scope is unaffected.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  validateConnectedContextPack,
  type ConnectedContextPack,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import {
  runGroundedExploration,
  type GroundedAnswerer,
  type OrchestratorInput,
} from "./grounded-orchestrator.js";

const DOCX_SIMPLE_BASE64 =
  "UEsDBBQAAAAIAC28xFzXeYTq8QAAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QzU7DMBCE730Ky9cqccoBIZSkB36OwKE8wMreJFb9J69b2rdn00KREOVozXwz62nXB+/EHjPZGDq5qhspMOhobBg7+b55ru6koALBgIsBO3lEkut+0W6OCUkwHKiTUynpXinSE3qgOiYMrAwxeyj8zKNKoLcworppmlulYygYSlXmDNkvhGgfcYCdK+LpwMr5loyOpHg4e+e6TkJKzmoorKt9ML+Kqq+SmsmThyabaMkGqa6VzOL1jh/0lSfK1qB4g1xewLNRfcRslIl65xmu/0/649o4DFbjhZ/TUo4aiXh77+qL4sGG71+06jR8/wlQSwMEFAAAAAgALbzEXCAbhuqyAAAALgEAAAsAAABfcmVscy8ucmVsc43Puw6CMBQG4J2naM4uBQdjDIXFmLAafICmPZRGeklbL7y9HRzEODie23fyN93TzOSOIWpnGdRlBQStcFJbxeAynDZ7IDFxK/nsLDJYMELXFs0ZZ57yTZy0jyQjNjKYUvIHSqOY0PBYOo82T0YXDE+5DIp6Lq5cId1W1Y6GTwPagpAVS3rJIPSyBjIsHv/h3ThqgUcnbgZt+vHlayPLPChMDB4uSCrf7TKzQHNKuorZvgBQSwMEFAAAAAgALbzEXGJ/vc/pAAAA5wEAABEAAAB3b3JkL2RvY3VtZW50LnhtbJWRwU7DMAyG73uKKPc13Q4IVU2mgTRxnAQ8QEjNWimxoySs9O1JWtAmDhOc8lv+f/uT0+4+nWVnCHEglHxT1ZwBGuoGPEn++nJY33MWk8ZOW0KQfILId2rVjk1H5sMBJpYnYGxGyfuUfCNEND04HSvygLn3TsHplMtwEiOFzgcyEGNe4KzY1vWdcHpArlaM5alv1E1FzoVf1KKPQZXnOU0W2NictZX8CXQh3XChWrF4LonZn9SR7GCm0k6z6dsy+682XQJ763vNCkh1nfod+Bva9hbaI2EKZOM/4B4g3WIrYjlhUT9fpL4AUEsBAhQDFAAAAAgALbzEXNd5hOrxAAAAuAEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAAtvMRcIBuG6rIAAAAuAQAACwAAAAAAAAAAAAAAgAEiAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACAAtvMRcYn+9z+kAAADnAQAAEQAAAAAAAAAAAAAAgAH9AQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAFQMAAAAA";
const DOCX_SIMPLE = Uint8Array.from(Buffer.from(DOCX_SIMPLE_BASE64, "base64"));

const XLSX_SIMPLE_BASE64 =
  "UEsDBBQAAAAIAAAAAADBChDqgQAAAKQAAAAPAAAAeGwvd29ya2Jvb2sueG1sNY7BDoMwDEN/pcoHLLDDDohy2S58RgfpWkEblARtnz80jZPtZ1ly/2ZZnsyL+5S1aicektnWIeqUqAS98Eb16CJLCXZEeSHHmCd68LQXqobXprmh0Bosc9WUN4Wh10Rk+ldXQyEPd64mvCq4Hx1nDy046fJhZJxbwKHHc4jns+ELUEsDBBQAAAAIAAAAAAAHfok7RgAAAGgAAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHOzCUrNSSzJzM8rzsgsKLazQeYqeKbYKhV5phgqKYRUFqTaKpXnF2UXZ6SmlgAFEovSU0uQhIr1wZShXkVujpK+nY0+qsEAUEsDBBQAAAAIAAAAAACCf1VtQAAAAGwAAAAUAAAAeGwvc2hhcmVkU3RyaW5ncy54bWyzKS4usbMpzrSzKbHzTq200Qfy9EFciFBYYk5pKrqgc35eSVF+jq6hObqMa15yUWVBiUJSYnJ2aUExQlofZA0AUEsDBBQAAAAIAAAAAAA2I5L5hAAAAPoAAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1ssynPL8ouzkhNLbGzAVMuiSWJdjZF+eUKRbZKhkp2NskghqOhkkKJrVIxkF9mZ2CjX2Zno58MlXNCljOEy+kDzYAbZAQ3yAhJsRGaQchyxqhyzhC5zLyczLzU4JIioJrMYjubErtAEwW1xNwCa4XE0pTMEht9oD/0QTIIJ+gj+Usf4V0AUEsBAhQAFAAAAAgAAAAAAMEKEOqBAAAApAAAAA8AAAAAAAAAAAAAAAAAAAAAAHhsL3dvcmtib29rLnhtbFBLAQIUABQAAAAIAAAAAAAHfok7RgAAAGgAAAAaAAAAAAAAAAAAAAAAAK4AAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc1BLAQIUABQAAAAIAAAAAACCf1VtQAAAAGwAAAAUAAAAAAAAAAAAAAAAACwBAAB4bC9zaGFyZWRTdHJpbmdzLnhtbFBLAQIUABQAAAAIAAAAAAA2I5L5hAAAAPoAAAAYAAAAAAAAAAAAAAAAAJ4BAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAQABAANAQAAWAIAAAAA";
const XLSX_SIMPLE = Uint8Array.from(Buffer.from(XLSX_SIMPLE_BASE64, "base64"));

// A minimal single-page text-layer PDF whose content stream draws "Hello PDF".
const PDF_TEXT_LAYER = new TextEncoder().encode(
  `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 24 Tf 72 72 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f
0000000010 00000 n
0000000063 00000 n
0000000122 00000 n
0000000248 00000 n
0000000342 00000 n
trailer << /Root 1 0 R /Size 6 >>
startxref
412
%%EOF`,
);

let ROOT = "";

const recordingAnswerer: { pack: ConnectedContextPack | null } & GroundedAnswerer = {
  pack: null,
  answer(question, pack) {
    this.pack = pack;
    return Promise.resolve(`Answered "${question}" over ${String(pack.files.length)} file(s).`);
  },
};

function fakeWorkspace(): WorkspaceInfo {
  return {
    root: ROOT,
    name: "demo",
    version: "0.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function scope(): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "scope-docs",
    workspaceRoot: ROOT,
    kind: "files",
    relativePaths: [
      "docs/report.docx",
      "docs/budget.xlsx",
      "docs/manual.pdf",
      "docs/legacy.doc",
      "src/foo.ts",
    ],
    conversationId: undefined,
    connectedAtMs: 1,
    explicitConnection: true,
  };
}

function query(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "What does the connected report say about policy?",
    caseSensitive: false,
    maxResults: 25,
    emittedAtMs: 1,
  };
}

function input(): OrchestratorInput {
  return { scope: scope(), query: query(), workspaceRoot: ROOT };
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "keiko-grounded-doc-"));
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  mkdirSync(join(ROOT, "src"), { recursive: true });
  writeFileSync(join(ROOT, "docs/report.docx"), DOCX_SIMPLE);
  writeFileSync(join(ROOT, "docs/budget.xlsx"), XLSX_SIMPLE);
  writeFileSync(join(ROOT, "docs/manual.pdf"), PDF_TEXT_LAYER);
  writeFileSync(join(ROOT, "docs/legacy.doc"), Buffer.from("legacy binary word doc"));
  writeFileSync(join(ROOT, "src/foo.ts"), "export const policy = 'documented';\n");
  recordingAnswerer.pack = null;
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("grounded exploration with connected documents", () => {
  it("includes bounded DOCX evidence and discloses an unsupported legacy .doc", async () => {
    const output = await runGroundedExploration(input(), {
      answerer: recordingAnswerer,
      nowMs: () => 1_000,
      detectWorkspace: () => fakeWorkspace(),
    });
    const pack = output.pack;

    // The pack is a valid ConnectedContextPack (additive contract changes hold end-to-end).
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });

    // DOCX, XLSX, and text-layer PDF all surface as document-extract evidence with extracted text.
    const docFile = pack.files.find((file) => file.scopePath === "docs/report.docx");
    expect(docFile).toBeDefined();
    expect(docFile?.excerpts.length).toBeGreaterThan(0);
    expect(docFile?.excerpts.every((e) => e.atom.provenance.kind === "document-extract")).toBe(
      true,
    );
    expect(docFile?.excerpts.map((e) => e.content).join("\n")).toContain("Policy");

    const xlsxFile = pack.files.find((file) => file.scopePath === "docs/budget.xlsx");
    expect(xlsxFile?.excerpts.every((e) => e.atom.provenance.kind === "document-extract")).toBe(
      true,
    );
    expect(xlsxFile?.excerpts.map((e) => e.content).join("\n")).toContain("Controls");

    const pdfFile = pack.files.find((file) => file.scopePath === "docs/manual.pdf");
    expect(pdfFile?.excerpts.every((e) => e.atom.provenance.kind === "document-extract")).toBe(
      true,
    );
    expect(pdfFile?.excerpts.map((e) => e.content).join("\n")).toContain("Hello PDF");

    // The legacy .doc is disclosed as unsupported, not silently dropped.
    expect(pack.omitted).toContainEqual({
      scopePath: "docs/legacy.doc",
      reason: "unsupported-format",
      omittedAtMs: 1_000,
    });
    expect(pack.uncertainty.some((u) => u.kind === "scope-incomplete")).toBe(true);

    // Existing code evidence in the same mixed scope is unaffected.
    const codeFile = pack.files.find((file) => file.scopePath === "src/foo.ts");
    expect(codeFile?.excerpts.every((e) => e.atom.provenance.kind !== "document-extract")).toBe(
      true,
    );
  });
});
