import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkAdrRegistry } from "../check-adr-index.mjs";

// GEN-DOC-ADR-002 / GEN-DOC-ADR-005 (Step 10): the ADR registry integrity gate must FAIL on the two
// defect classes it exists to catch — a duplicate ADR number (the 0058-0069 editor/voice collision)
// and an on-disk ADR missing from the decision index — and PASS on a clean registry. These fixture
// cases pin that behaviour so the gate cannot silently degrade into an always-green no-op. The final
// case asserts the REAL docs/adr registry is clean (the collision is resolved + index complete).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

let dir;

function adr(name, body = "# " + name) {
  writeFileSync(join(dir, name), body + "\n");
}

function readme(lines) {
  writeFileSync(join(dir, "README.md"), "# Decision Summary\n\n" + lines.join("\n") + "\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adr-index-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkAdrRegistry", () => {
  it("passes a clean registry with unique numbers all indexed", () => {
    adr("ADR-0001-first.md");
    adr("ADR-0002-second.md");
    readme(["[ADR-0001](ADR-0001-first.md)", "[ADR-0002](ADR-0002-second.md)"]);
    expect(checkAdrRegistry(dir)).toEqual([]);
  });

  it("fails when one ADR number is claimed by two files (the 0058-0069 collision class)", () => {
    adr("ADR-0058-safe-apply-edits.md");
    adr("ADR-0058-voice-digital-twin.md");
    readme([
      "[ADR-0058](ADR-0058-safe-apply-edits.md)",
      "[ADR-0058](ADR-0058-voice-digital-twin.md)",
    ]);
    const problems = checkAdrRegistry(dir);
    expect(problems.some((p) => p.includes("ADR-0058 is claimed by 2 files"))).toBe(true);
  });

  it("fails when an on-disk ADR is missing from the README index", () => {
    adr("ADR-0001-first.md");
    adr("ADR-0031-relationship-storage.md");
    readme(["[ADR-0001](ADR-0001-first.md)"]); // 0031 unindexed
    const problems = checkAdrRegistry(dir);
    expect(problems.some((p) => p.includes("not indexed") && p.includes("0031"))).toBe(true);
  });

  it("fails when the README links a non-existent ADR file (orphan link)", () => {
    adr("ADR-0001-first.md");
    readme(["[ADR-0001](ADR-0001-first.md)", "[ADR-0099](ADR-0099-ghost.md)"]);
    const problems = checkAdrRegistry(dir);
    expect(problems.some((p) => p.includes("missing ADR file") && p.includes("0099"))).toBe(true);
  });

  it("the real docs/adr registry is clean (collision resolved + index complete)", () => {
    expect(checkAdrRegistry(join(repoRoot, "docs", "adr"))).toEqual([]);
  });
});
