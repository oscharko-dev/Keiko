import { describe, expect, it } from "vitest";
import { extractPathReferences, extractRetrievalChannels } from "./references.js";

describe("complete located reference identity", () => {
  it.each([
    "src/Delta/guard.mjs:178-182",
    "`src/Delta/guard.mjs:178-182`",
    '"src/Delta/guard.mjs:178-182"',
    "[src/Delta/guard.mjs:178-182]",
    "(src/Delta/guard.mjs:178-182)",
    "app/[id]/guard.mjs:178-182",
  ])("retains the complete path and first physical line for %s", (token) => {
    const path = token.includes("app/") ? "app/[id]/guard.mjs" : "src/Delta/guard.mjs";
    expect(extractPathReferences(`Read ${token} and explain its value.`)).toEqual([
      { path, line: 178, origin: "query" },
    ]);
  });

  it.each(["0-3", "182-178", "178-0", "178-1000000000", "178-x"])(
    "does not certify an invalid range %s",
    (suffix) => {
      const references = extractPathReferences(`Read \`src/Delta/guard.mjs:${suffix}\`.`);
      expect(references.some((reference) => reference.line !== undefined)).toBe(false);
    },
  );

  it.each([
    { token: "src/Delta/guard.mjs:180:9", line: 180 },
    { token: "src/Delta/guard.mjs:180", line: 180 },
    { token: "src/Delta/guard.mjs", line: undefined },
  ])("preserves the historical location $token", ({ token, line }) => {
    const references = extractPathReferences(`Read \`${token}\`.`);
    expect(references).toEqual([
      { path: "src/Delta/guard.mjs", ...(line === undefined ? {} : { line }), origin: "query" },
    ]);
  });

  it("retains occurrence order and the existing six-reference cap", () => {
    const paths = Array.from({ length: 8 }, (_value, index) => `src/${String(index)}/guard.mjs`);
    const result = extractRetrievalChannels(
      paths.map((path) => `\`${path}:178-182\``).join(" "),
      8,
    );
    expect(result.references).toEqual(
      paths.slice(0, 6).map((path) => ({ path, line: 178, origin: "query" })),
    );
  });
});
