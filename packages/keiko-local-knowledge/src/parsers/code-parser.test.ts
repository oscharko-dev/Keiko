import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { codeParser, codeSymbolLabel, isCodeSymbolDefinitionLine } from "./code-parser.js";
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

  // The ECMAScript module/CommonJS TypeScript extensions are TypeScript by definition — `.mts` and
  // `.cts` differ from `.ts` only in module resolution, never in syntax. Their JavaScript siblings
  // `.mjs`/`.cjs` were in the language table from the start, so omitting the TypeScript pair sent
  // every `.mts`/`.cts` file to the permissive text adapter: whole-file chunking with no symbol
  // anchor, which is a citation section path. This repository ships five such files
  // (`tests/e2e/servers/*.mts`), so the gap was reachable on the repository pod for Keiko itself.
  it.each([
    ["mts", "export function load(): void {}", "function load"],
    ["cts", "export function load(): void {}", "function load"],
  ])("routes the %s TypeScript extension to the code parser, not the text adapter", (extension) => {
    const resolution = createDefaultParserRegistry().resolve(
      selectionFromText("export const value = 1;", { extension }),
    );
    expect(resolution).toMatchObject({
      kind: "matched",
      adapter: { capability: { parserId: "code-text" } },
    });
  });

  // Local Knowledge's own file-selection contract (LOCAL_KNOWLEDGE_SCRIPT_FILE_EXTENSIONS /
  // LOCAL_KNOWLEDGE_SOURCE_CODE_FILE_EXTENSIONS) already advertised rb/php/swift/c/cc/cpp/h/hpp as
  // supported source-code formats while CODE_LANGUAGE_BY_EXTENSION omitted them — the same
  // .mts/.cts routing gap fixed above, still open for eight more mainstream extensions (release
  // audit of epic #2554 M2).
  it.each([
    ["rb", "def load; nil; end", "function load"],
    ["php", "function load() {}", "function load"],
    ["swift", "func load() {}", "function load"],
    ["c", "int load() {}", "function load"],
    ["cc", "int load() {}", "function load"],
    ["cpp", "int load() {}", "function load"],
    ["h", "int load();", "function load"],
    ["hpp", "int load();", "function load"],
  ])("routes the %s extension to the code parser, not the text adapter", (extension) => {
    const resolution = createDefaultParserRegistry().resolve(
      selectionFromText("int value = 1;", { extension }),
    );
    expect(resolution).toMatchObject({
      kind: "matched",
      adapter: { capability: { parserId: "code-text" } },
    });
  });

  it.each([
    ["ts", "export function load(): void {}", "function load"],
    ["mts", "export function load(): void {}", "function load"],
    ["cts", "export function load(): void {}", "function load"],
    ["py", "def load():\n    return None", "function load"],
    ["go", "func Load() {}", "function Load"],
    ["rs", "pub fn load() {}", "function load"],
    ["kt", "data class Record(val id: String)", "type Record"],
    ["java", "public final class Record {}", "type Record"],
    ["rb", "def load()\n  nil\nend", "function load"],
    ["php", "function load() {}", "function load"],
    ["swift", "func load() {}", "function load"],
    ["c", "int load() {\n  return 0;\n}", "function load"],
    ["cc", "int load() {\n  return 0;\n}", "function load"],
    ["cpp", "int load() {\n  return 0;\n}", "function load"],
    ["h", "int load();", "function load"],
    ["hpp", "int load();", "function load"],
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

  // Precision must not be bought with recall. Requiring a `{`/`;` terminator immediately after the
  // parameter list excluded the dominant TypeScript method form — a return-type annotation sits
  // between them — which would have silently stopped anchoring most methods in this very codebase.
  it.each([
    ["an async method with a generic return type", "  public async generate(i: I): Promise<S> {"],
    ["a method with a plain return type", "  public toIndexingError(): IndexingJobError {"],
    ["a getter with a return type", "  get pageCount(): number {"],
    [
      "a static method with a union return type",
      "  private static resolve(id: string): F | undefined {",
    ],
    ["an exported function with a return type", "export function withRet(a: string): number {"],
  ])("anchors %s", (_case, line) => {
    expect(codeSymbolLabel(line)).toBeDefined();
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

  // Issue #2636. The strict method pattern blocked `void` at the return-type position because
  // `void expr();` is a legal JS/TS fire-and-forget expression statement. That block also made
  // every Java or C# void method fall through to the surrounding section, giving those files
  // arbitrary chunk boundaries and section paths that did not name the method — a systematic
  // precision loss on any Java or C# repository. The route now switches on the file extension:
  // where `void` at the head of a declaration line is only ever a return type (Java, C#), the
  // pattern accepts it; elsewhere the strict block stays in place.
  it.each([
    ["public static void main(String[] args) {", "function main"],
    ["  public void render() {", "function render"],
    ["  private void render() {", "function render"],
    ["  protected abstract void update();", "function update"],
  ])("anchors the Java void method %s", (line, expected): void => {
    expect(codeSymbolLabel(line, "java")).toBe(expected);
  });

  it.each([
    ["public static void Main(string[] args) {", "function Main"],
    ["  private void Render() {", "function Render"],
    ["  protected override void OnPaint(PaintEventArgs e) {", "function OnPaint"],
    ["  public virtual void Update(TimeSpan dt) {", "function Update"],
    ["  public sealed override void Dispose() {", "function Dispose"],
    ["  internal void Refresh() {", "function Refresh"],
    // `async void` is the C# event-handler idiom, and `public async Task<T>` is the standard
    // shape for asynchronous methods. Both would fall through when `async` was not in the
    // modifier alternation — `async` would take the return-type slot, forcing `void` (rejected
    // as an anchor name) or `Task` (whose `<int>` overflows the pattern) into the name slot.
    ["  private async void Button_Click(object sender, EventArgs e) {", "function Button_Click"],
    ["  public async void OnClick() {", "function OnClick"],
    ["  public async Task<int> ComputeAsync() {", "function ComputeAsync"],
  ])("anchors the C# void method %s", (line, expected): void => {
    expect(codeSymbolLabel(line, "cs")).toBe(expected);
  });

  // Generic and array return neighbours were called out in the acceptance criteria as
  // over-matching probes: the void-allowing pattern must still anchor them, because it must
  // not be a widened net that only lands on the enemy targets.
  it.each([
    ["  public List<String> getItems() {", "java", "function getItems"],
    ["  public int[] slice(int begin) {", "java", "function slice"],
    ["  public T[] toArray() {", "java", "function toArray"],
    ["  public Task<int> LoadAsync() {", "cs", "function LoadAsync"],
    ["  public string[] Slice(int begin) {", "cs", "function Slice"],
  ])(
    "keeps anchoring the generic or array return neighbour %s (%s)",
    (line, ext, expected): void => {
      expect(codeSymbolLabel(line, ext)).toBe(expected);
    },
  );

  // The existing TypeScript form `public async foo(): Promise<S>` keeps anchoring after the
  // C# `async` addition to the modifier alternation, because the greedy `(?:MOD\s+)*` backtracks
  // to a one-modifier consumption when the two-modifier consumption fails to line up the name
  // and parameter list — leaving `async` in the same return-type-slot role it played before.
  it("keeps anchoring the TypeScript `public async` method form after the C# async modifier addition", () => {
    expect(codeSymbolLabel("  public async generate(i: I): Promise<S> {", "ts")).toBe(
      "function generate",
    );
  });

  // The extension gate is the load-bearing property. `void expr();` in a .ts file was the
  // reason the strict block existed at all — the repository has real fire-and-forget lines
  // (`void reload();`, `void handleEntry(entry as yauzl.Entry);`), and mis-anchoring those
  // would be exactly the systematic precision loss the C# fix aims to end, just aimed at
  // TypeScript instead. This test freezes that.
  it.each([
    "  void reload();",
    "  void handleEntry(entry as yauzl.Entry);",
    "  void serveGatewayRequest(req, res, deps, responses);",
  ])("still blocks the TS/JS fire-and-forget expression %s", (line): void => {
    expect(codeSymbolLabel(line, "ts")).toBeUndefined();
    expect(codeSymbolLabel(line, "js")).toBeUndefined();
    expect(codeSymbolLabel(line)).toBeUndefined();
  });

  it("does not anchor `void expr();` inside a TypeScript source that also declares real methods", () => {
    const text = [
      "export async function loop(): Promise<void> {",
      "  void handleEntry(input);",
      "  void reload();",
      "  return;",
      "}",
      "",
    ].join("\n");
    const sections = sectionsFor(text, "ts");
    expect(sections.map((section) => section.sectionPath)).toEqual([["function loop"]]);
  });

  // Every existing adversarial line must still produce no anchor when the extension is switched
  // to Java or C#. The conservative-table promise in the module's own comment stays true: the
  // void allow is a lookahead relaxation, not a widening of what counts as a declaration shape.
  it.each([
    ["a call site in a return statement", "  return buildSummary(store, capsuleId);"],
    ["a throw site", '    throw new KnowledgeStoreError("repository root failed");'],
    ["a bare constructor call", "  return new Map(entries);"],
    ["a SQL table header", "CREATE TABLE IF NOT EXISTS pod_runs ("],
    ["a SQL CHECK constraint", "  applied INTEGER NOT NULL CHECK (applied IN (0, 1)),"],
    ["a SQL PRIMARY KEY clause", "  PRIMARY KEY (capsule_id, source_id, run_id),"],
    ["a SQL FOREIGN KEY clause", "  FOREIGN KEY (capsule_id) REFERENCES capsules(id),"],
  ])("does not mine %s as a symbol even for Java/C# extensions", (_case, line): void => {
    expect(codeSymbolLabel(line, "java")).toBeUndefined();
    expect(codeSymbolLabel(line, "cs")).toBeUndefined();
  });

  // `void` never becomes an anchor name even where it is a valid return type — nothing declares
  // a symbol literally called `void`, so a captured anchor of `void` is always a false positive.
  it("never captures `void` as an anchor name", () => {
    expect(codeSymbolLabel("void void() {", "cs")).toBeUndefined();
    expect(codeSymbolLabel("public void void() {", "java")).toBeUndefined();
  });

  // The exported helpers gained an optional `extension` argument in this PR, which makes them
  // unsafe to pass directly as `Array` callbacks — JavaScript hands the callback
  // `(value, index, array)`, so the numeric index becomes the `extension` and the internal
  // `.toLowerCase()` would throw a TypeError. `symbolPatternsFor` narrows non-string arguments
  // to the strict variant instead, so a caller that reaches around TypeScript with `as unknown as`
  // still gets a clean answer and no crash. Freezing this pins the runtime guarantee that
  // matches the type-level signature.
  it("does not crash when called via Array callback shape", () => {
    const linesArray = ["  void ignore();", "  public void render() {", "  x = 1;"];
    expect(() => linesArray.findIndex((value) => isCodeSymbolDefinitionLine(value))).not.toThrow();
    // `isCodeSymbolDefinitionLine` and `codeSymbolLabel` are also called with their bare
    // reference to freeze the runtime guarantee — a caller that reaches around TypeScript to
    // pass them directly still gets a clean answer, not a `TypeError` from `.toLowerCase()`
    // on the numeric index. The unknown cast documents that the shape is intentionally the
    // Array-callback shape here; the guarantee lives in `symbolPatternsFor`'s runtime narrow.
    const asFinder = isCodeSymbolDefinitionLine as unknown as (
      value: string,
      index: number,
      array: string[],
    ) => boolean;
    expect(() => linesArray.findIndex(asFinder)).not.toThrow();
    const asLabelFinder = codeSymbolLabel as unknown as (
      value: string,
      index: number,
      array: string[],
    ) => string | undefined;
    expect(() =>
      linesArray.findIndex((value, index, array) => asLabelFinder(value, index, array)),
    ).not.toThrow();
  });

  // `ParserSelectionInput.extension` is documented as no-dot ("cs", "java", never ".cs"), and
  // the internal parse path always honours that. But the public helpers are import surface for
  // consumers who may reach them with `path.extname()`-shaped input, and silently reverting to
  // the strict variant on a dotted extension would reintroduce the very recall loss this PR
  // closes. `symbolPatternsFor` strips the leading dot so both shapes take the same route.
  it.each([
    ["  public void render() {", "java"],
    ["  public void render() {", ".java"],
    ["  public void Render() {", "cs"],
    ["  public void Render() {", ".cs"],
    ["  protected override void OnPaint() {", ".cs"],
  ])("anchors %s equivalently for extension %s (with and without the leading dot)", (line, ext) => {
    expect(codeSymbolLabel(line, ext)).toBeDefined();
  });

  it("emits chunk boundaries and section paths for a Java void-methods fixture", () => {
    const text = [
      "// Widget class demonstrating void methods.",
      "public final class Widget {",
      "  public static void main(String[] args) {",
      "    render();",
      "  }",
      "",
      "  private void render() {",
      '    System.out.println("draw");',
      "  }",
      "",
      "  protected abstract void update();",
      "",
      "  public List<String> getItems() {",
      "    return items;",
      "  }",
      "",
      "  public int[] slice(int begin) {",
      "    return new int[]{ begin };",
      "  }",
      "}",
      "",
    ].join("\n");
    const sections = sectionsFor(text, "java");
    expect(sections.map((section) => section.sectionPath)).toEqual([
      ["java module"],
      ["type Widget"],
      ["function main"],
      ["function render"],
      ["function update"],
      ["function getItems"],
      ["function slice"],
    ]);
    expect(sections.map((section) => section.characterStart)).toEqual([
      0,
      text.indexOf("public final class Widget"),
      text.indexOf("  public static void main"),
      text.indexOf("  private void render"),
      text.indexOf("  protected abstract void update"),
      text.indexOf("  public List<String> getItems"),
      text.indexOf("  public int[] slice"),
    ]);
    expect(sections[sections.length - 1]?.characterEnd).toBe(text.length);
  });

  it("emits chunk boundaries and section paths for a C# void-methods fixture", () => {
    // The method bodies deliberately avoid `var name = ...` so the constant pattern does not
    // fold a body-local variable into the section path. The exception cases in the issue —
    // modifier combinations — are the load-bearing ones; body content is incidental.
    const text = [
      "// Widget class demonstrating void methods.",
      "public sealed class Widget {",
      "  public static void Main(string[] args) {",
      "    Console.WriteLine(args.Length);",
      "  }",
      "",
      "  private void Render() {",
      '    Console.WriteLine("draw");',
      "  }",
      "",
      "  protected override void OnPaint(PaintEventArgs e) {",
      "    base.OnPaint(e);",
      "  }",
      "",
      "  public virtual void Update(TimeSpan dt) {",
      "    lastUpdate = dt;",
      "  }",
      "",
      "  public List<string> GetItems() {",
      "    return items;",
      "  }",
      "",
      "  public int[] Slice(int begin) {",
      "    return new int[]{ begin };",
      "  }",
      "}",
      "",
    ].join("\n");
    const sections = sectionsFor(text, "cs");
    expect(sections.map((section) => section.sectionPath)).toEqual([
      ["csharp module"],
      ["type Widget"],
      ["function Main"],
      ["function Render"],
      ["function OnPaint"],
      ["function Update"],
      ["function GetItems"],
      ["function Slice"],
    ]);
    expect(sections.map((section) => section.characterStart)).toEqual([
      0,
      text.indexOf("public sealed class Widget"),
      text.indexOf("  public static void Main"),
      text.indexOf("  private void Render"),
      text.indexOf("  protected override void OnPaint"),
      text.indexOf("  public virtual void Update"),
      text.indexOf("  public List<string> GetItems"),
      text.indexOf("  public int[] Slice"),
    ]);
    expect(sections[sections.length - 1]?.characterEnd).toBe(text.length);
  });

  // The added modifier alternatives (`override|virtual|sealed|internal`) are literal tokens
  // with no whitespace character in them, so the alternation is still deterministic per
  // position: the engine can only advance one modifier at a time, and there is no
  // cross-alternative backtracking. A hostile dense run of modifiers followed by a line
  // that never legally terminates must therefore parse in linear time, just like the
  // pre-existing hostile-long-space case.
  it("stays bounded on a hostile C# modifier-heavy line", () => {
    const hostileLine = `${"public override sealed ".repeat(150)}xxxx`;
    const text = `${hostileLine}\npublic void execute() {\n}\n`;
    const startedAt = Date.now();
    const sections = sectionsFor(text, "cs");
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(sections.map((section) => section.sectionPath)).toContainEqual(["function execute"]);
  });
});
