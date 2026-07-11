import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { settleMaintainerEvidence } from "./maintainer-review-2075-reporter.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keiko-2075-evidence-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  for (const name of ["a11y", "fidelity"]) {
    writeFileSync(join(root, `${name}-results.json`), JSON.stringify({ issue: 2075 }));
    writeFileSync(join(root, `${name}-proof.json`), JSON.stringify({ result: "STALE" }));
  }
  return root;
}

describe("maintainer evidence receipt", () => {
  it("cannot emit or retain PASS when the browser run fails", async () => {
    const root = await fixture();
    settleMaintainerEvidence(root, false);
    expect(existsSync(join(root, "a11y-proof.json"))).toBe(false);
    expect(existsSync(join(root, "fidelity-proof.json"))).toBe(false);
  });

  it("promotes result drafts only after a successful run", async () => {
    const root = await fixture();
    settleMaintainerEvidence(root, true);
    const proof = JSON.parse(readFileSync(join(root, "a11y-proof.json"), "utf8")) as {
      readonly result: string;
    };
    expect(proof.result).toBe("PASS");
  });
});
