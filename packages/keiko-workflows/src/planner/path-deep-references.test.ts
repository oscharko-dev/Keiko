import { describe, expect, it } from "vitest";
import { extractAnchors } from "./anchors.js";
import { extractPathReferences, extractRetrievalChannels } from "./references.js";

const DEEP = `${Array.from({ length: 71 }, (_, index) => `s${String(index)}`).join("/")}/atlas-recovery.html`;

describe("complete bounded manual path tokens", () => {
  it.each([
    DEEP,
    `manuals/${"long-section-".repeat(10)}/operating-limits.html`,
    "handbücher/Überhitzungsschutz/prüfungen.html",
  ])("does not shorten a valid unquoted path: %s", (path) => {
    expect(extractPathReferences(`Explain ${path}`)).toEqual([{ path, origin: "query" }]);
    expect(extractAnchors({ text: `Explain ${path}`, maxAnchors: 8 }).anchors).toContainEqual(
      expect.objectContaining({ term: path.toLowerCase(), kind: "path", weight: 0.95 }),
    );
  });

  it("preserves the identical backticked control and physical line hint", () => {
    expect(extractPathReferences(`Explain \`${DEEP}\``)).toEqual([{ path: DEEP, origin: "query" }]);
    expect(extractPathReferences(`Explain ${DEEP}:27:3.`)).toEqual([
      { path: DEEP, line: 27, origin: "query" },
    ]);
  });

  it("keeps traversal and absolute paths for the existing admission boundary", () => {
    for (const path of [`../${DEEP}`, `/${DEEP}`])
      expect(extractPathReferences(`Explain ${path}`)).toEqual([{ path, origin: "query" }]);
  });

  it("retains the six-reference bound without partial suffix references", () => {
    const paths = Array.from({ length: 8 }, (_, index) => `manual-${String(index)}/${DEEP}`);
    expect(extractRetrievalChannels(paths.join(" "), 8).references).toEqual(
      paths.slice(0, 6).map((path) => ({ path, origin: "query" })),
    );
  });
});
