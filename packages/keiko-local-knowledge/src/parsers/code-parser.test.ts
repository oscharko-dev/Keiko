import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { codeParser, codeSymbolLabel } from "./code-parser.js";
import { selectionFromText } from "./parser-test-fixtures.js";
import { createDefaultParserRegistry } from "./index.js";
import { buildParserOptions } from "./registry.js";

function sectionsFor(
  text: string,
  extension: string,
): readonly Extract<ParsedUnit, { kind: "section" }>[] {
  const result = codeParser.parse(
    selectionFromText(text, { extension }),
    buildParserOptions({ now: () => 0 }),
  );
  return result.units.filter(
    (unit): unit is Extract<ParsedUnit, { kind: "section" }> => unit.kind === "section",
  );
}

describe("codeParser", () => {
  it("precedes the permissive text adapter in the shipped registry", () => {
    const resolution = createDefaultParserRegistry().resolve(
      selectionFromText("export const value = 1;", { extension: "ts" }),
    );
    expect(resolution).toMatchObject({
      kind: "matched",
      adapter: { capability: { parserId: "code-text" } },
    });
  });

  it.each([
    ["ts", "export function load(): void {}", "function load"],
    ["py", "def load():\n    return None", "function load"],
    ["go", "func Load() {}", "function Load"],
    ["rs", "pub fn load() {}", "function load"],
    ["kt", "data class Record(val id: String)", "type Record"],
    ["java", "public final class Record {}", "type Record"],
  ])("emits a symbol-anchored section for %s", (extension, text, label) => {
    const sections = sectionsFor(text, extension);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.sectionPath).toEqual([label]);
    expect(sections[0]?.characterStart).toBe(0);
    expect(sections[0]?.characterEnd).toBe(text.length);
  });

  it("preserves a module preamble and splits subsequent symbols at their line starts", () => {
    const text = [
      "// module documentation",
      "export interface Request {}",
      "",
      "export async function execute(): Promise<void> {}",
      "",
    ].join("\n");
    const sections = sectionsFor(text, "ts");
    expect(sections.map((section) => section.sectionPath)).toEqual([
      ["typescript module"],
      ["type Request"],
      ["function execute"],
    ]);
    expect(sections.map((section) => section.characterStart)).toEqual([
      0,
      text.indexOf("export interface"),
      text.indexOf("export async function"),
    ]);
  });

  it("emits one module section for empty, symbol-free, BOM, and hostile long-line inputs", () => {
    expect(sectionsFor("", "py")[0]?.sectionPath).toEqual(["python module"]);
    expect(sectionsFor("value = call()\r\n", "py")[0]?.sectionPath).toEqual(["python module"]);
    expect(sectionsFor(`\uFEFF${"x".repeat(20_000)}`, "ts")[0]?.characterStart).toBe(0);
  });

  it("uses only the seeded definition vocabulary", () => {
    expect(codeSymbolLabel("if (ready) {")).toBeUndefined();
    expect(codeSymbolLabel("const refresh = async () => true;")).toBe("constant refresh");
    expect(codeSymbolLabel("private Result refresh(Input input) {")).toBe("function refresh");
  });

  // The broad method-shaped pattern used to mine call sites, control flow and embedded SQL as
  // definitions: on this package's own repository-pod.ts it produced 73 anchors for ~20 real
  // symbols. Every false anchor becomes a chunk boundary AND a citation sectionPath, so this is
  // a retrieval-precision defect, not cosmetics.
  it.each([
    ["a call site in a return statement", "  return buildSummary(store, capsuleId);"],
    ["a throw site", '    throw new KnowledgeStoreError("repository root failed");'],
    ["an awaited call", "  return await persistRun(deps, record);"],
    ["a for-await header", "  for await (const event of events) {"],
    ["a bare constructor call", "  return new Map(entries);"],
    ["a SQL table header in a template literal", "CREATE TABLE IF NOT EXISTS pod_runs ("],
    ["a SQL CHECK constraint", "  applied INTEGER NOT NULL CHECK (applied IN (0, 1)),"],
    ["a SQL PRIMARY KEY clause", "  PRIMARY KEY (capsule_id, source_id, run_id),"],
    ["a SQL FOREIGN KEY clause", "  FOREIGN KEY (capsule_id) REFERENCES capsules(id),"],
  ])("does not mine %s as a symbol", (_case, line) => {
    expect(codeSymbolLabel(line)).toBeUndefined();
  });

  it("does not mine type members of an unterminated import block", () => {
    const text = [
      "import {",
      "  KnowledgeStoreError,",
      "  type KnowledgeCapsuleId,",
      "  type KnowledgeSourceId,",
      "  type KnowledgeSourceScope,",
      '} from "./types.js";',
      "",
      "export function load(): void {}",
    ].join("\n");
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("type ")) expect(codeSymbolLabel(line)).toBeUndefined();
    }
    expect(sectionsFor(text, "ts").map((section) => section.sectionPath)).toEqual([
      ["typescript module"],
      ["function load"],
    ]);
  });

  it("still recognises declared type aliases and Go struct types", () => {
    expect(codeSymbolLabel("export type SourceScope = { id: string };")).toBe("type SourceScope");
    expect(codeSymbolLabel("type Envelope<T> = readonly T[];")).toBe("type Envelope");
    expect(codeSymbolLabel("type Server struct {")).toBe("type Server");
    expect(codeSymbolLabel("pub struct Fingerprint {")).toBe("type Fingerprint");
  });

  // The old method-shaped pattern held a literal space inside `[\w$<>, ?.[\]]` directly in front
  // of `\s+`, which backtracks quadratically over a run of spaces (~1.0s at 40k spaces, 4x per
  // doubling). The deadline could not stop it either: `shouldStop` was only consulted after the
  // whole per-line scan had already run. A 1.2 MB file took 47.7s despite `timeoutMs: 100`.
  it("stays bounded on a hostile long-space line despite a permissive deadline", () => {
    const hostile = `a${" ".repeat(60_000)}b`;
    const text = `${hostile}\nexport function load(): void {}\n`;
    const startedAt = Date.now();
    const sections = sectionsFor(text, "ts");
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(sections.map((section) => section.sectionPath)).toEqual([
      ["typescript module"],
      ["function load"],
    ]);
  });

  it("honours a short deadline over many hostile lines instead of scanning them all", () => {
    const hostile = `${`a${" ".repeat(3_000)}b\n`.repeat(400)}export function load(): void {}\n`;
    const startedAt = Date.now();
    codeParser.parse(
      selectionFromText(hostile, { extension: "ts" }),
      buildParserOptions({ now: () => Date.now(), timeoutMs: 100 }),
    );
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});
