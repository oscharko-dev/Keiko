import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EVIDENCE_ROOT = "docs/design-system/evidence";
const SPEC_ROOT = "tests/e2e";
const FICTIONAL_TOKENS = [
  ".keiko-scripts/ui-verify-receipt.sh",
  ".keiko-scripts/verify.sh",
] as const;

function walk(dir: string, matcher: (name: string) => boolean): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      results.push(...walk(full, matcher));
    } else if (matcher(entry)) {
      results.push(full);
    }
  }
  return results;
}

function hitsIn(paths: readonly string[]): { path: string; token: string }[] {
  const hits: { path: string; token: string }[] = [];
  for (const path of paths) {
    const body = readFileSync(path, "utf8");
    for (const token of FICTIONAL_TOKENS) {
      if (body.includes(token)) {
        hits.push({ path, token });
      }
    }
  }
  return hits;
}

describe("design-system evidence must not cite the fictional .keiko-scripts receipt tool (KEIKO-1036)", () => {
  it("evidence README files do not reference .keiko-scripts", () => {
    const readmeFiles = walk(EVIDENCE_ROOT, (name) => name === "README.md");
    expect(readmeFiles.length).toBeGreaterThan(0);
    const hits = hitsIn(readmeFiles);
    expect(
      hits,
      `Fictional receipt tool referenced in evidence READMEs: ${hits
        .map((h) => `${h.path} -> ${h.token}`)
        .join(", ")}`,
    ).toEqual([]);
  });

  it("evidence manifest.json files do not reference .keiko-scripts", () => {
    const manifestFiles = walk(EVIDENCE_ROOT, (name) => name === "manifest.json");
    const hits = hitsIn(manifestFiles);
    expect(
      hits,
      `Fictional receipt tool referenced in evidence manifests: ${hits
        .map((h) => `${h.path} -> ${h.token}`)
        .join(", ")}`,
    ).toEqual([]);
  });

  it("e2e specs do not construct a .keiko-scripts receipt-command constant", () => {
    const specFiles = walk(SPEC_ROOT, (name) => name.endsWith(".spec.ts"));
    const hits = hitsIn(specFiles);
    expect(
      hits,
      `Fictional receipt tool referenced in e2e specs: ${hits
        .map((h) => `${h.path} -> ${h.token}`)
        .join(", ")}`,
    ).toEqual([]);
  });
});
