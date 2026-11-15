import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { portableSha256Hex } from "./sha256-portable.js";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));

function nodeSha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Relative imports of one contract source file (static `from "./x.js"` forms only). */
function relativeImports(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+"(\.\.?\/[^"]+)\.js"/gu)].map((match) =>
    resolve(dirname(file), `${match[1] ?? ""}.ts`),
  );
}

/** Every contract source file reachable from `entry` through relative imports. */
function importClosure(entry: string): readonly string[] {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const next of relativeImports(file)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

describe("portableSha256Hex", () => {
  it("equals node's SHA-256 for the standard vectors", () => {
    expect(portableSha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(portableSha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("equals node's SHA-256 at every length around the block and padding boundaries", () => {
    for (let length = 0; length <= 200; length += 1) {
      const text = "a".repeat(length);
      expect(portableSha256Hex(text), `length ${String(length)}`).toBe(nodeSha256Hex(text));
    }
  });

  it("equals node's SHA-256 for multi-byte text and a long input", () => {
    const samples = [
      "Übergeordnet → 親 🙂",
      JSON.stringify(["keiko-jira-template-binding", 2, "instance", "aufgabe", null, ["10002"]]),
      "Vorgang ".repeat(5000),
    ];
    for (const text of samples) expect(portableSha256Hex(text)).toBe(nodeSha256Hex(text));
  });
});

describe("contract modules the browser bundle loads", () => {
  // The UI imports `atlassian-connectors.ts`. A Node built-in anywhere in its import closure makes
  // the browser build fail ("Reading from node:crypto is not handled"), even if nothing calls it.
  it("import no Node built-in anywhere below atlassian-connectors.ts", () => {
    const closure = importClosure(join(SOURCE_DIR, "atlassian-connectors.ts"));
    expect(closure.length).toBeGreaterThan(5);
    const offenders = closure.filter((file) => /from\s+"node:/u.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => file.slice(SOURCE_DIR.length + 1))).toEqual([]);
  });
});
