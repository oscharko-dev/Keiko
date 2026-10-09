import { describe, expect, it } from "vitest";
import { extractPathReferences } from "./references.js";

describe("reference wrappers preserve complete paths without promoting prose extensions", () => {
  it.each(["HTML", "html", "TXT", "txt", "MD", "md"])(
    "does not make the ordinary prose word %s a file reference",
    (term) => {
      expect(extractPathReferences(`Explain the ${term} format.`)).toEqual([]);
    },
  );

  it.each([
    ["[src/Feature/validation.ts]", "src/Feature/validation.ts"],
    ["[src/deep/unseen.ts].", "src/deep/unseen.ts"],
    ["(src/Feature/validation.ts)", "src/Feature/validation.ts"],
  ])("retains the complete declaration wrapper %s without a basename alias", (text, path) => {
    expect(extractPathReferences(`Missing evidence: ${text}`)).toEqual([{ path, origin: "query" }]);
  });

  it.each([
    ["[src/Feature/validation.ts:7]", "src/Feature/validation.ts", 7],
    ["[src/Feature/validation.ts:7-9]", "src/Feature/validation.ts", 7],
    ["app/users/[id]/page.tsx", "app/users/[id]/page.tsx", undefined],
    ["`src/Feature/validation.ts`", "src/Feature/validation.ts", undefined],
    ['"src/Feature/validation.ts:7-9"', "src/Feature/validation.ts", 7],
    ["manual.html", "manual.html", undefined],
    ["README.md", "README.md", undefined],
    ["CMakeLists.txt", "CMakeLists.txt", undefined],
  ] as const)("preserves an actual file reference %s", (text, path, line) => {
    expect(extractPathReferences(`Explain ${text}`)).toEqual([
      { path, ...(line === undefined ? {} : { line }), origin: "query" },
    ]);
  });
});
