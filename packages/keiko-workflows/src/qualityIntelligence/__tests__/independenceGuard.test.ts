import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function* walk(dir: string): Generator<string> {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (entry === "__tests__" || entry === "dist" || entry === "node_modules") continue;
      yield* walk(fullPath);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      yield fullPath;
    }
  }
}

const FORBIDDEN_SUBSTRINGS = [
  "@oscharko-dev/test-intelligence",
  "@oscharko-dev/ti-",
];

describe("QI workflow source independence from Test Intelligence", () => {
  it("no production source under qualityIntelligence/ references forbidden TI namespaces", () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const content = readFileSync(file, "utf-8");
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        if (content.includes(forbidden)) {
          offenders.push(`${file}: contains ${forbidden}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
