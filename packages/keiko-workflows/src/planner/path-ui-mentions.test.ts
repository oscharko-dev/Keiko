import { describe, expect, it } from "vitest";
import { extractRetrievalChannels } from "./references.js";

const PATHS = [
  "src/Checker.ts:7",
  "app/users/[id]/page.tsx:8",
  `${Array.from({ length: 72 }, (_value, index) => `d${String(index)}`).join("/")}/Guide.html:9`,
  `src/z${"a".repeat(64)}/Überblick.xhtml:10`,
];

describe("unquoted UI path mentions preserve canonical whole-token identity", () => {
  it.each(PATHS)("removes only the unquoted UI prefix from %s", (path) => {
    const result = extractRetrievalChannels(`Please check @${path}`, 8);
    const [reference] = result.references;
    expect(reference?.path).toBe(path.slice(0, path.lastIndexOf(":")));
    expect(reference?.line).toBe(Number(path.slice(path.lastIndexOf(":") + 1)));
    expect(result.references).toHaveLength(1);
  });

  it.each(["`@src/Checker.ts`", '"@src/Checker.ts"', "./@src/Checker.ts"])(
    "preserves unambiguous literal @ identity in %s",
    (reference) => {
      const result = extractRetrievalChannels(`Explain ${reference}`, 8);
      expect(result.references).toEqual([
        {
          path: reference.startsWith("./") ? "./@src/Checker.ts" : "@src/Checker.ts",
          origin: "query",
        },
      ]);
    },
  );
});
