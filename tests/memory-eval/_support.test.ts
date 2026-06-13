import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFixture } from "./_support.js";
import { looksLikeSecretShape } from "@oscharko-dev/keiko-contracts/memory";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FORBIDDEN_EVIDENCE_MARKERS = [
  "api key",
  "credential",
  "customer data",
  "private log",
  "runtime log",
  "secret",
] as const;

function collectStrings(value: unknown, out: string[] = []): readonly string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

describe("memory-eval fixture validation", () => {
  it("rejects fixture scopes that omit the coordinate required by their kind", () => {
    expect(() => loadFixture("invalid-scope.json")).toThrow(
      "fixture invalid-scope.json contains a malformed entry",
    );
  });

  it("keeps synthetic fixtures free of obvious secrets, customer data, and private logs", () => {
    const fixtureFiles = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith(".json") && name !== "invalid-scope.json")
      .sort();
    const unsafe: string[] = [];
    for (const file of fixtureFiles) {
      const parsed: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
      for (const value of collectStrings(parsed)) {
        const lower = value.toLowerCase();
        const marker = FORBIDDEN_EVIDENCE_MARKERS.find((entry) => lower.includes(entry));
        if (marker !== undefined || looksLikeSecretShape(value)) {
          unsafe.push(`${file}: ${value}`);
        }
      }
    }
    expect(unsafe).toEqual([]);
  });
});
