import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("Issue #1207 performance budget documentation", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const doc = readFileSync(
    resolve(repoRoot, "docs", "keiko-editor", "1207-performance-budgets.md"),
    "utf8",
  );

  it("keeps the Monaco worker/model memory ceiling explicit", () => {
    expect(doc).toContain("≤ 128 MiB per simultaneously open editor card");
    expect(doc).toContain("≤ 16 MiB");
    expect(doc).toContain("#1209");
  });
});
