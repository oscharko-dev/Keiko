import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

describe("editor local-history boundary", () => {
  it("does not depend on Code-task, chat, transcript, prompt, tool, or memory stores", () => {
    const productionSources = readdirSync(MODULE_DIR)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(join(MODULE_DIR, name), "utf8"))
      .join("\n");

    expect(productionSources).not.toMatch(
      /from\s+["'][^"']*(?:coding-runtime|chat|transcript|prompt|memory)[^"']*["']/u,
    );
    expect(productionSources).not.toMatch(
      /readonly\s+(?:transcript|prompt|modelOutput|toolActivity)\s*:/u,
    );
  });
});
