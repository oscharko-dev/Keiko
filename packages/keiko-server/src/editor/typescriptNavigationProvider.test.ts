import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  type LanguagePosition,
  type LanguageServiceLimits,
} from "@oscharko-dev/keiko-contracts";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import ts from "typescript";
import { createDeadlineCancellation } from "./languageCancellation.js";
import type { LanguageProviderContext } from "./languageProvider.js";
import {
  resolveTypescriptCallHierarchy,
  resolveTypescriptDefinition,
  resolveTypescriptImplementation,
  resolveTypescriptReferences,
  resolveTypescriptTypeDefinition,
} from "./typescriptNavigationProvider.js";
import {
  createTypescriptProjectService,
  type TypescriptProjectHandle,
} from "./typescriptProjectService.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-ts-nav-")));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
    "utf8",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function positionOf(text: string, needle: string, offset = 0): LanguagePosition {
  const index = text.indexOf(needle, offset);
  if (index < 0) throw new Error(`needle not found: ${needle}`);
  const prefix = text.slice(0, index);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function ctx(
  relativePath: string,
  overlayText: string,
  limits: LanguageServiceLimits = DEFAULT_LANGUAGE_SERVICE_LIMITS,
): LanguageProviderContext {
  return {
    fs: nodeWorkspaceFs,
    root,
    overlayPath: join(root, relativePath),
    overlayText,
    languageId: "typescript",
    limits,
    cancellation: createDeadlineCancellation({ deadlineMs: limits.deadlineMs, now: () => 0 }),
  };
}

function project(
  relativePath: string,
  overlayText: string,
  limits: LanguageServiceLimits = DEFAULT_LANGUAGE_SERVICE_LIMITS,
): TypescriptProjectHandle {
  const result = createTypescriptProjectService().resolveProject(
    ctx(relativePath, overlayText, limits),
  );
  expect(result.kind).toBe("project");
  if (result.kind !== "project") throw new Error("expected project");
  return result.project;
}

function fakeProject(
  service: Partial<ts.LanguageService>,
  options: {
    readonly truncated?: boolean;
    readonly limits?: LanguageServiceLimits;
    readonly cancellation?: TypescriptProjectHandle["cancellation"];
    readonly sourceText?: TypescriptProjectHandle["sourceText"];
  } = {},
): TypescriptProjectHandle {
  const overlayPath = join(root, "src", "main.ts");
  const limits = options.limits ?? DEFAULT_LANGUAGE_SERVICE_LIMITS;
  return {
    service: service as ts.LanguageService,
    configPath: join(root, "tsconfig.json"),
    projectKey: "fake",
    rootFileNames: [overlayPath],
    limits,
    cancellation:
      options.cancellation ??
      createDeadlineCancellation({ deadlineMs: limits.deadlineMs, now: () => 0 }),
    overlayPath,
    overlayText: "target",
    wasReused: false,
    truncated: options.truncated ?? false,
    sourceText: options.sourceText ?? ((): string => "target"),
    workspaceRelativePath: (fileName: string): string | undefined =>
      fileName.startsWith(`${root}/`) ? fileName.slice(root.length + 1) : undefined,
  };
}

function referencedSymbol(referenceCount: number): {
  readonly accesses: { count: number };
  readonly symbol: ts.ReferencedSymbol;
} {
  const accesses = { count: 0 };
  const fileName = join(root, "src", "main.ts");
  const references = new Proxy(
    Array.from({ length: referenceCount }, (): ts.ReferencedSymbolEntry => ({
      fileName,
      textSpan: { start: 0, length: 6 },
      isWriteAccess: false,
    })),
    {
      get: (target, property, receiver): unknown => {
        if (typeof property === "string" && /^\d+$/u.test(property)) accesses.count += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    },
  );
  return {
    accesses,
    symbol: {
      definition: {
        fileName,
        textSpan: { start: 0, length: 6 },
        kind: ts.ScriptElementKind.constElement,
        name: "target",
        containerKind: ts.ScriptElementKind.unknown,
        containerName: "",
        displayParts: [],
      },
      references,
    },
  };
}

describe("typescript navigation provider", () => {
  it.each([false, true])(
    "preserves project truncation for empty definition and reference results (%s)",
    (truncated) => {
      const handle = fakeProject(
        { getDefinitionAtPosition: () => undefined, findReferences: () => undefined },
        { truncated },
      );

      const definition = resolveTypescriptDefinition(handle, { line: 0, character: 0 });
      const references = resolveTypescriptReferences(handle, { line: 0, character: 0 });

      expect(definition).toEqual({ locations: [], truncated });
      expect(references).toEqual({
        locations: [],
        includesDeclaration: false,
        truncated,
      });
    },
  );

  it("resolves type definitions separately from value definitions", () => {
    const text =
      "interface Service { run(): string; }\n" +
      "const service: Service = { run: () => 'ok' };\n" +
      "export const result = service.run();\n";
    writeFileSync(join(root, "src", "types.ts"), text, "utf8");
    const result = resolveTypescriptTypeDefinition(
      project("src/types.ts", text),
      positionOf(text, "service", text.indexOf("result")),
    );

    expect(result.locations).toContainEqual(
      expect.objectContaining({
        path: "src/types.ts",
        range: { start: { line: 0, character: 10 }, end: { line: 0, character: 17 } },
      }),
    );
  });

  it("resolves an interface to its concrete implementation, not its declaration", () => {
    const text =
      "interface Worker { run(): string; }\n" +
      "class ConcreteWorker implements Worker { run(): string { return 'done'; } }\n" +
      "export const worker: Worker = new ConcreteWorker();\n";
    writeFileSync(join(root, "src", "implementation.ts"), text, "utf8");
    const result = resolveTypescriptImplementation(
      project("src/implementation.ts", text),
      positionOf(text, "Worker"),
    );

    expect(result.locations).toContainEqual(
      expect.objectContaining({
        path: "src/implementation.ts",
        range: { start: { line: 1, character: 6 }, end: { line: 1, character: 20 } },
      }),
    );
    expect(result.locations).not.toContainEqual(
      expect.objectContaining({
        range: { start: { line: 0, character: 10 }, end: { line: 0, character: 16 } },
      }),
    );
  });

  it("preserves every incoming call site in a multi-call-site fixture", () => {
    const text =
      "function target(): void {}\n" +
      "function caller(): void { target(); target(); }\n" +
      "target();\n";
    writeFileSync(join(root, "src", "hierarchy.ts"), text, "utf8");
    const result = resolveTypescriptCallHierarchy(
      project("src/hierarchy.ts", text),
      positionOf(text, "target"),
    );
    const callSites = result.roots.flatMap((rootItem) =>
      rootItem.incomingCalls.flatMap((call) => call.fromRanges),
    );

    expect(callSites).toHaveLength(3);
    expect(callSites.map((site) => site.start.line)).toEqual([1, 1, 2]);
  });

  it("returns no call hierarchy roots when preparation finds no callable symbol", () => {
    const handle = fakeProject({ prepareCallHierarchy: () => undefined });

    const result = resolveTypescriptCallHierarchy(handle, { line: 0, character: 0 });

    expect(result).toEqual({ roots: [], truncated: false });
  });

  it("preserves every item when call hierarchy preparation returns an ambiguous array", () => {
    const overlayPath = join(root, "src", "main.ts");
    const itemNamed = (name: string): ts.CallHierarchyItem => ({
      name,
      kind: ts.ScriptElementKind.functionElement,
      file: overlayPath,
      span: { start: 0, length: 6 },
      selectionSpan: { start: 0, length: 6 },
    });
    const handle = fakeProject({
      prepareCallHierarchy: () => [itemNamed("first"), itemNamed("second")],
      provideCallHierarchyIncomingCalls: () => [],
      provideCallHierarchyOutgoingCalls: () => [],
    });

    const result = resolveTypescriptCallHierarchy(handle, { line: 0, character: 0 });

    expect(result.roots.map((rootItem) => rootItem.item.name)).toEqual(["first", "second"]);
  });

  it("resolves a cross-file definition", () => {
    writeFileSync(join(root, "src", "decl.ts"), "export const sharedValue = 1;\n", "utf8");
    const main = "import { sharedValue } from './decl.js';\nexport const use = sharedValue;\n";
    const result = resolveTypescriptDefinition(
      project("src/main.ts", main),
      positionOf(main, "sharedValue", main.indexOf("use")),
    );

    expect(result.truncated).toBe(false);
    expect(result.locations).toContainEqual(
      expect.objectContaining({
        path: "src/decl.ts",
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 24 } },
      }),
    );
  });

  it("returns cross-file references without collapsing result order", () => {
    writeFileSync(join(root, "src", "decl.ts"), "export const sharedValue = 1;\n", "utf8");
    writeFileSync(
      join(root, "src", "other.ts"),
      "import { sharedValue } from './decl.js';\nexport const other = sharedValue;\n",
      "utf8",
    );
    const main = "import { sharedValue } from './decl.js';\nexport const use = sharedValue;\n";
    writeFileSync(join(root, "src", "main.ts"), main, "utf8");
    const result = resolveTypescriptReferences(
      project("src/decl.ts", "export const sharedValue = 1;\n"),
      positionOf("export const sharedValue = 1;\n", "sharedValue"),
    );

    expect(result.includesDeclaration).toBe(true);
    expect(result.locations.length).toBeGreaterThan(1);
    expect(new Set(result.locations.map((location) => location.path))).toEqual(
      new Set(["src/decl.ts", "src/main.ts", "src/other.ts"]),
    );
    expect(result.locations[0]?.path).toBe("src/decl.ts");
    expect(main).toContain("sharedValue");
  });

  it("handles same-file and not-found positions", () => {
    const text = "// detached comment\nconst localValue = 1;\nexport const use = localValue;\n";
    writeFileSync(join(root, "src", "local.ts"), text, "utf8");
    const handle = project("src/local.ts", text);
    const sameFile = resolveTypescriptDefinition(
      handle,
      positionOf(text, "localValue", text.indexOf("use")),
    );
    const missing = resolveTypescriptReferences(handle, { line: 0, character: 3 });
    const missingDefinition = resolveTypescriptDefinition(handle, { line: 0, character: 3 });

    expect(sameFile.locations[0]?.path).toBe("src/local.ts");
    expect(missing.locations).toEqual([]);
    expect(missing.includesDeclaration).toBe(false);
    // The definition resolver must also return a well-formed empty result (not throw) for a
    // position with no symbol (Issue #2101 acceptance: both resolvers).
    expect(missingDefinition.locations).toEqual([]);
    expect(missingDefinition.truncated).toBe(false);
  });

  it("reports includesDeclaration false when the declaration is outside the workspace", () => {
    // Referencing a lib symbol (Array.prototype.map): its declaration lives in a lib .d.ts outside
    // the workspace root and is filtered out, so includesDeclaration must be false even though the
    // in-workspace usage is returned. Regression guard: the flag is derived from what actually
    // survived into the returned locations, not from the raw referenced-symbol count (Issue #2101).
    const text = "const values: string[] = [];\nvalues.map((value) => value);\n";
    writeFileSync(join(root, "src", "libref.ts"), text, "utf8");
    const result = resolveTypescriptReferences(
      project("src/libref.ts", text),
      positionOf(text, "map"),
    );

    expect(result.locations.length).toBeGreaterThan(0);
    expect(result.locations.every((location) => location.path === "src/libref.ts")).toBe(true);
    expect(result.includesDeclaration).toBe(false);
  });

  it("filters definitions outside the workspace root", () => {
    const text = "const values: string[] = [];\nvalues.map((value) => value);\n";
    writeFileSync(join(root, "src", "lib.ts"), text, "utf8");
    const result = resolveTypescriptDefinition(
      project("src/lib.ts", text),
      positionOf(text, "map"),
    );

    expect(result.locations).toEqual([]);
  });

  it("caps reference results and signals truncation", () => {
    writeFileSync(join(root, "src", "decl.ts"), "export const sharedValue = 1;\n", "utf8");
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(
        join(root, "src", `use-${String(index)}.ts`),
        "import { sharedValue } from './decl.js';\nexport const use = sharedValue;\n",
        "utf8",
      );
    }
    const result = resolveTypescriptReferences(
      project("src/decl.ts", "export const sharedValue = 1;\n", {
        ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
        maxReferenceLocations: 2,
      }),
      positionOf("export const sharedValue = 1;\n", "sharedValue"),
    );

    expect(result.locations).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("backfills the reference cap after invalid, outside, and unreadable candidates", () => {
    const paths = {
      unreadable: join(root, "src", "unreadable.ts"),
      first: join(root, "src", "first.ts"),
      second: join(root, "src", "second.ts"),
      beyondCap: join(root, "src", "beyond-cap.ts"),
    };
    const entry = (fileName: string): ts.ReferencedSymbolEntry => ({
      fileName,
      textSpan: { start: 0, length: 6 },
      isWriteAccess: false,
    });
    const base = referencedSymbol(0).symbol;
    const symbol: ts.ReferencedSymbol = {
      ...base,
      definition: { ...base.definition, fileName: "" },
      references: [
        entry("/outside/reference.ts"),
        entry(paths.unreadable),
        entry(paths.first),
        entry(paths.second),
        entry(paths.beyondCap),
      ],
    };
    const sourceByFile: Readonly<Record<string, string>> = {
      [paths.first]: "target",
      [paths.second]: "target",
      [paths.beyondCap]: "target",
    };
    const sourceText = vi.fn((fileName: string): string | undefined => sourceByFile[fileName]);
    const handle = fakeProject(
      { findReferences: () => [symbol] },
      {
        limits: { ...DEFAULT_LANGUAGE_SERVICE_LIMITS, maxReferenceLocations: 2 },
        sourceText,
      },
    );

    const result = resolveTypescriptReferences(handle, { line: 0, character: 0 });

    expect(result).toMatchObject({
      locations: [{ path: "src/first.ts" }, { path: "src/second.ts" }],
      includesDeclaration: false,
      truncated: true,
    });
    expect(sourceText.mock.calls.map(([fileName]) => fileName)).toEqual([
      paths.unreadable,
      paths.first,
      paths.second,
    ]);
  });

  it("bounds high-fan-out reference traversal before source and range materialization", () => {
    const { accesses, symbol } = referencedSymbol(1_000);
    const sourceText = vi.fn(() => "target");
    const handle = fakeProject(
      { findReferences: () => [symbol] },
      {
        limits: { ...DEFAULT_LANGUAGE_SERVICE_LIMITS, maxReferenceLocations: 3 },
        sourceText,
      },
    );

    const result = resolveTypescriptReferences(handle, { line: 0, character: 0 });

    expect(result.locations).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(accesses.count).toBeLessThanOrEqual(2);
    expect(sourceText).toHaveBeenCalledTimes(3);
  });

  it("polls cancellation after reference fan-out before reading source text", () => {
    const { symbol } = referencedSymbol(10);
    let tick = 0;
    const cancellation = createDeadlineCancellation({ deadlineMs: 2, now: () => tick++ });
    const sourceText = vi.fn(() => "target");
    const handle = fakeProject({ findReferences: () => [symbol] }, { cancellation, sourceText });

    expect(() => resolveTypescriptReferences(handle, { line: 0, character: 0 })).toThrow(
      "language operation cancelled",
    );
    expect(sourceText).not.toHaveBeenCalled();
  });
});
