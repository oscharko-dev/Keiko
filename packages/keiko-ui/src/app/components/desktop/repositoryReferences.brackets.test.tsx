import { describe, expect, it } from "vitest";
import {
  repositoryReferenceTextParts,
  sanitizeRepositoryEvidenceText,
} from "./repositoryReferences";

describe("bracketed reference prose and lists", () => {
  it("keeps an actual source path through the markdown evidence sanitization pass", () => {
    const source = "See [Source: src/a.ts:10-20].";
    const cleaned = sanitizeRepositoryEvidenceText(source);
    expect(cleaned).toBe(source);
    expect(repositoryReferenceTextParts(cleaned)).toContainEqual({
      kind: "reference",
      reference: { label: "src/a.ts:10-20", path: "src/a.ts", lineStart: 10, lineEnd: 20 },
    });
  });
  it.each([
    ["see [defined in src/app.ts:12]", ["src/app.ts"], "defined in "],
    ["[see src/a.ts]", ["src/a.ts"], "see "],
    ["[a.ts, b.ts]", ["a.ts", "b.ts"], ""],
    ["[src/a.ts and src/b.ts]", ["src/a.ts", "src/b.ts"], " and "],
    ["[Source: src/a.ts:10-20]", ["src/a.ts"], "Source: "],
    ["[src/a.ts:1-4, src/b.ts]", ["src/a.ts", "src/b.ts"], ""],
    ["[[src/a.ts:1-4]]", ["src/a.ts"], ""],
    ["(indices start at [0; see [src/a.ts:12])", ["src/a.ts"], "0; see "],
    ["[a.ts:1,\n b.ts:2]", ["a.ts", "b.ts"], ""],
  ] as const)("preserves individually valid references in %s", (source, paths, prose) => {
    const parts = repositoryReferenceTextParts(source);
    expect(
      parts.flatMap((part) => (part.reference === undefined ? [] : [part.reference.path])),
    ).toEqual(paths);
    expect(parts.map((part) => part.text ?? "").join("")).toContain(prose);
  });

  it.each(["[", "[ ", "[a", "[source: "])(
    "handles an unterminated %j run without repeated bracket scans",
    (start) => {
      const source = start.repeat(start === "[source: " ? 20_000 : 150_000);
      const began = performance.now();
      expect(repositoryReferenceTextParts(source)).toEqual([{ kind: "text", text: source }]);
      expect(sanitizeRepositoryEvidenceText(source)).toBe(source);
      expect(performance.now() - began).toBeLessThan(600);
    },
  );
});
