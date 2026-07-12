import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  EDITOR_LANGUAGE_MODE_IDS,
  LANGUAGE_SERVICE_OPERATIONS,
  type LanguageServiceLimits,
  type LanguageServiceRequest,
} from "@oscharko-dev/keiko-contracts";
import {
  describeLanguageCapabilities,
  NO_PROVIDER_UNAVAILABLE_REASON,
  runLanguageOperation,
  type RunLanguageOperationOptions,
} from "./languageService.js";
import { createLanguageProviderRegistry, type LanguageProvider } from "./languageProvider.js";

let root: string;

const TYPESCRIPT_OPERATIONS = [
  "diagnostics",
  "completion",
  "hover",
  "symbols",
  "formatting",
  "definition",
  "typeDefinition",
  "implementation",
  "references",
  "callHierarchy",
  "inlayHints",
  "renamePrepare",
  "renameApply",
  "codeActions",
  "signatureHelp",
] as const;

const NAVIGATION_REFACTORING_OPERATIONS = [
  "definition",
  "references",
  "renamePrepare",
  "renameApply",
  "codeActions",
  "signatureHelp",
] as const;
const NAVIGATION_REFACTORING_OPERATION_SET = new Set<string>(NAVIGATION_REFACTORING_OPERATIONS);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-ls-")));
  mkdirSync(join(root, "src"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function options(
  relativePath: string,
  overrides: Partial<RunLanguageOperationOptions> = {},
): RunLanguageOperationOptions {
  return {
    fs: nodeWorkspaceFs,
    realRoot: root,
    overlayAbsolutePath: join(root, relativePath),
    now: () => 0,
    ...overrides,
  };
}

function tsDocument(path: string, text: string): LanguageServiceRequest["document"] {
  return { path, languageId: "typescript", text };
}

describe("describeLanguageCapabilities", () => {
  it("advertises the TypeScript/JavaScript provider and its operations", () => {
    const capabilities = describeLanguageCapabilities();
    expect(capabilities.schemaVersion).toBe("1");
    const provider = capabilities.providers.find((entry) => entry.id === "typescript");
    expect(provider?.id).toBe("typescript");
    expect(provider?.availability).toBe("available");
    expect(provider?.languages).toEqual([
      "typescript",
      "typescriptreact",
      "javascript",
      "javascriptreact",
    ]);
    expect(provider?.operations).toEqual(TYPESCRIPT_OPERATIONS);
    expect(capabilities.providers.find((entry) => entry.id === "json")?.availability).toBe(
      "available",
    );
    const pythonProvider = capabilities.providers.find((entry) => entry.id === "python-lsp");
    expect(pythonProvider?.availability).toBe("unavailable");
    expect(typeof pythonProvider?.unavailableReason).toBe("string");
  });

  it("keeps the TypeScript operation descriptor aligned with the contract operation table", () => {
    const capabilities = describeLanguageCapabilities();
    const provider = capabilities.providers.find((entry) => entry.id === "typescript");

    expect(provider?.operations).toEqual(LANGUAGE_SERVICE_OPERATIONS);
  });
});

describe("completion (model-free)", () => {
  it("offers member completions for TypeScript without a model call", () => {
    const text = "const value = { alpha: 1, beta: 2 };\nvalue.\n";
    const outcome = runLanguageOperation(
      {
        operation: "completion",
        root,
        document: tsDocument("src/a.ts", text),
        position: { line: 1, character: 6 },
      },
      options("src/a.ts"),
    );
    expect(outcome.kind).toBe("completion");
    if (outcome.kind === "completion") {
      const labels = outcome.result.items.map((item) => item.label);
      expect(labels).toContain("alpha");
      expect(labels).toContain("beta");
      // Pin the kind mapping so a regression to a flat "text" kind is caught.
      expect(outcome.result.items.find((item) => item.label === "alpha")?.kind).toBe("property");
    }
  });

  it("offers completions for a TSX (typescriptreact) overlay", () => {
    const text = "const obj = { delta: 1 };\nconst el = <div>{obj.}</div>;\n";
    const outcome = runLanguageOperation(
      {
        operation: "completion",
        root,
        // Cursor immediately after the dot in `obj.` (the `.` is at index 20).
        document: { path: "src/c.tsx", languageId: "typescriptreact", text },
        position: { line: 1, character: 21 },
      },
      options("src/c.tsx"),
    );
    expect(outcome.kind).toBe("completion");
    if (outcome.kind === "completion") {
      expect(outcome.result.items.map((item) => item.label)).toContain("delta");
    }
  });

  it("offers completions for JavaScript too", () => {
    const text = "const obj = { gamma: 1 };\nobj.\n";
    const outcome = runLanguageOperation(
      {
        operation: "completion",
        root,
        document: { path: "src/b.js", languageId: "javascript", text },
        position: { line: 1, character: 4 },
      },
      options("src/b.js"),
    );
    expect(outcome.kind).toBe("completion");
    if (outcome.kind === "completion") {
      expect(outcome.result.items.map((item) => item.label)).toContain("gamma");
    }
  });

  it("keeps JavaScript overlays analyzable even when tsconfig disables allowJs", () => {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { allowJs: false } }),
      "utf8",
    );
    const text = "const obj = { gamma: 1 };\nobj.\n";
    const outcome = runLanguageOperation(
      {
        operation: "completion",
        root,
        document: { path: "src/b.js", languageId: "javascript", text },
        position: { line: 1, character: 4 },
      },
      options("src/b.js"),
    );
    expect(outcome.kind).toBe("completion");
    if (outcome.kind === "completion") {
      expect(outcome.result.items.map((item) => item.label)).toContain("gamma");
    }
  });
});

describe("diagnostics reflect the unsaved overlay, not disk", () => {
  it("reports a type error present only in the overlay", () => {
    // Disk holds VALID content; the overlay holds the error. The diagnostic must come from the overlay.
    writeFileSync(join(root, "src/a.ts"), "export const x: number = 1;\n", "utf8");
    const overlayText = "export const x: number = 'a string';\n";
    const outcome = runLanguageOperation(
      { operation: "diagnostics", root, document: tsDocument("src/a.ts", overlayText) },
      options("src/a.ts"),
    );
    expect(outcome.kind).toBe("diagnostics");
    if (outcome.kind === "diagnostics") {
      expect(outcome.result.diagnostics.length).toBeGreaterThan(0);
      const [first] = outcome.result.diagnostics;
      expect(first?.severity).toBe("error");
      expect(first?.source).toBe("typescript");
      expect(first?.message.toLowerCase()).toContain("not assignable");
      // The error is the string literal on line 0; pin the range so a zero-range mapping regression
      // (in spanToRange/computeLineStarts) is caught.
      expect(first?.range.start.line).toBe(0);
      expect(first?.range.start.character).toBeGreaterThan(0);
      expect(first?.range.end.character).toBeGreaterThan(first?.range.start.character ?? 0);
    }
  });

  it("reports a diagnostic for a TSX (typescriptreact) overlay", () => {
    const overlayText = "export const n: number = 'tsx';\n";
    const outcome = runLanguageOperation(
      {
        operation: "diagnostics",
        root,
        document: { path: "src/d.tsx", languageId: "typescriptreact", text: overlayText },
      },
      options("src/d.tsx"),
    );
    expect(outcome.kind).toBe("diagnostics");
    if (outcome.kind === "diagnostics") {
      const messages = outcome.result.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n");
      expect(messages.toLowerCase()).toContain("not assignable");
    }
  });

  it("reports no diagnostics for a clean overlay", () => {
    const outcome = runLanguageOperation(
      {
        operation: "diagnostics",
        root,
        document: tsDocument("src/clean.ts", "export const ok = 1;\n"),
      },
      options("src/clean.ts"),
    );
    expect(outcome.kind).toBe("diagnostics");
    if (outcome.kind === "diagnostics") {
      expect(outcome.result.diagnostics).toEqual([]);
    }
  });
});

describe("cross-file resolution and tsconfig discovery", () => {
  it("resolves a relative import read from within the workspace root", () => {
    // The imported module lives on disk inside the root; the host must read it through the
    // contained fs port for the type error to reference it.
    writeFileSync(
      join(root, "src/helper.ts"),
      "export function helper(value: number): number {\n  return value;\n}\n",
      "utf8",
    );
    const overlay =
      "import { helper } from './helper.js';\nexport const r = helper('not a number');\n";
    const outcome = runLanguageOperation(
      { operation: "diagnostics", root, document: tsDocument("src/main.ts", overlay) },
      options("src/main.ts"),
    );
    expect(outcome.kind).toBe("diagnostics");
    if (outcome.kind === "diagnostics") {
      const messages = outcome.result.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n");
      // The import resolved (no "cannot find module") and the argument is type-checked against it.
      expect(messages).not.toContain("Cannot find module");
      expect(messages.toLowerCase()).toContain("not assignable");
    }
  });

  it("does not read a denied file reached through an allowed-looking symlink import", () => {
    writeFileSync(
      join(root, ".env"),
      "export const PASSWORD = 'bank-super-secret' as const;\n",
      "utf8",
    );
    try {
      symlinkSync(join(root, ".env"), join(root, "src", "config.ts"));
    } catch {
      return;
    }
    const overlay = "import { PASSWORD } from './config.js';\nexport const n: 1 = PASSWORD;\n";
    const outcome = runLanguageOperation(
      { operation: "diagnostics", root, document: tsDocument("src/main.ts", overlay) },
      options("src/main.ts"),
    );
    expect(outcome.kind).toBe("diagnostics");
    if (outcome.kind === "diagnostics") {
      const messages = outcome.result.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n");
      expect(messages).not.toContain("bank-super-secret");
      expect(messages).toContain("Cannot find module");
    }
  });

  it("applies a discovered tsconfig.json (strict noImplicitAny)", () => {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
      "utf8",
    );
    const outcome = runLanguageOperation(
      {
        operation: "diagnostics",
        root,
        document: tsDocument("src/p.ts", "export function f(x) {\n  return x;\n}\n"),
      },
      options("src/p.ts"),
    );
    expect(outcome.kind).toBe("diagnostics");
    if (outcome.kind === "diagnostics") {
      const messages = outcome.result.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n");
      expect(messages).toContain("implicitly has an 'any' type");
    }
  });

  it("does not flag implicit any without a strict tsconfig", () => {
    const outcome = runLanguageOperation(
      {
        operation: "diagnostics",
        root,
        document: tsDocument("src/p.ts", "export function f(x) {\n  return x;\n}\n"),
      },
      options("src/p.ts"),
    );
    expect(outcome.kind).toBe("diagnostics");
    if (outcome.kind === "diagnostics") {
      expect(outcome.result.diagnostics).toEqual([]);
    }
  });
});

describe("hover", () => {
  it("returns quick info for a symbol", () => {
    const text = "const greeting: string = 'hi';\ngreeting;\n";
    const outcome = runLanguageOperation(
      {
        operation: "hover",
        root,
        document: tsDocument("src/h.ts", text),
        position: { line: 1, character: 0 },
      },
      options("src/h.ts"),
    );
    expect(outcome.kind).toBe("hover");
    if (outcome.kind === "hover") {
      expect(outcome.result.contents).toContain("greeting");
      expect(outcome.result.contents).toContain("string");
    }
  });

  it("returns null contents when the position has no quick info", () => {
    const outcome = runLanguageOperation(
      {
        operation: "hover",
        root,
        document: tsDocument("src/h.ts", "const a = 1;\n      \n"),
        position: { line: 1, character: 3 },
      },
      options("src/h.ts"),
    );
    expect(outcome.kind).toBe("hover");
    if (outcome.kind === "hover") {
      expect(outcome.result.contents).toBeNull();
    }
  });
});

describe("standard navigation, hierarchy, and inlay dispatch", () => {
  it("routes all four additive operations through the advertised provider", () => {
    const text =
      "interface Worker { run(): string; }\n" +
      "class ConcreteWorker implements Worker { run(): string { return 'done'; } }\n" +
      "function invoke(worker: Worker): string { return worker.run(); }\n" +
      "const worker = new ConcreteWorker();\n" +
      "export const result = invoke(worker);\n";
    const document = tsDocument("src/new-navigation.ts", text);
    const run = (request: LanguageServiceRequest): ReturnType<typeof runLanguageOperation> =>
      runLanguageOperation(request, options("src/new-navigation.ts"));
    const typeDefinition = run({
      operation: "typeDefinition",
      root,
      document,
      position: { line: 4, character: 29 },
    });
    const implementation = run({
      operation: "implementation",
      root,
      document,
      position: { line: 0, character: 11 },
    });
    const hierarchy = run({
      operation: "callHierarchy",
      root,
      document,
      position: { line: 2, character: 10 },
    });
    const hints = run({
      operation: "inlayHints",
      root,
      document,
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 37 } },
    });

    expect(typeDefinition.kind).toBe("typeDefinition");
    expect(implementation.kind).toBe("implementation");
    expect(hierarchy.kind).toBe("callHierarchy");
    expect(hints.kind).toBe("inlayHints");
  });
});

describe("empty completion positions", () => {
  it("returns no items inside a comment", () => {
    const outcome = runLanguageOperation(
      {
        operation: "completion",
        root,
        document: tsDocument("src/c.ts", "// a plain comment line\n"),
        position: { line: 0, character: 10 },
      },
      options("src/c.ts"),
    );
    expect(outcome.kind).toBe("completion");
    if (outcome.kind === "completion") {
      expect(outcome.result.items).toEqual([]);
      expect(outcome.result.truncated).toBe(false);
    }
  });
});

describe("symbols", () => {
  it("returns flattened document symbols", () => {
    const text = "export function foo() {}\nexport class Bar {}\n";
    const outcome = runLanguageOperation(
      { operation: "symbols", root, document: tsDocument("src/s.ts", text) },
      options("src/s.ts"),
    );
    expect(outcome.kind).toBe("symbols");
    if (outcome.kind === "symbols") {
      const byName = new Map(outcome.result.symbols.map((symbol) => [symbol.name, symbol.kind]));
      expect(byName.get("foo")).toBe("function");
      expect(byName.get("Bar")).toBe("class");
    }
  });
});

describe("formatting (deterministic, explicit)", () => {
  it("returns reformatting edits for a poorly spaced document", () => {
    const outcome = runLanguageOperation(
      { operation: "formatting", root, document: tsDocument("src/f.ts", "const x   =   1;\n") },
      options("src/f.ts"),
    );
    expect(outcome.kind).toBe("formatting");
    if (outcome.kind === "formatting") {
      expect(outcome.result.edits.length).toBeGreaterThan(0);
      // The collapsed whitespace must not survive in any replacement text.
      expect(outcome.result.edits.every((edit) => !edit.newText.includes("   "))).toBe(true);
    }
  });

  it("returns no edits for an already well-formatted document", () => {
    const outcome = runLanguageOperation(
      { operation: "formatting", root, document: tsDocument("src/f.ts", "const x = 1;\n") },
      options("src/f.ts"),
    );
    expect(outcome.kind).toBe("formatting");
    if (outcome.kind === "formatting") {
      expect(outcome.result.edits).toEqual([]);
      expect(outcome.result.truncated).toBe(false);
    }
  });

  it("honours insertSpaces:false by indenting with a tab", () => {
    const text = "function f() {\nreturn 1;\n}\n";
    const tabbed = runLanguageOperation(
      {
        operation: "formatting",
        root,
        document: tsDocument("src/f.ts", text),
        options: { tabSize: 2, insertSpaces: false },
      },
      options("src/f.ts"),
    );
    const spaced = runLanguageOperation(
      {
        operation: "formatting",
        root,
        document: tsDocument("src/f.ts", text),
        options: { tabSize: 2, insertSpaces: true },
      },
      options("src/f.ts"),
    );
    expect(tabbed.kind).toBe("formatting");
    expect(spaced.kind).toBe("formatting");
    if (tabbed.kind === "formatting" && spaced.kind === "formatting") {
      expect(tabbed.result.edits.some((edit) => edit.newText.includes("\t"))).toBe(true);
      expect(spaced.result.edits.some((edit) => edit.newText.includes("\t"))).toBe(false);
    }
  });

  it("caps formatting edits and sets truncated", () => {
    const limits: LanguageServiceLimits = {
      ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
      maxFormattingEdits: 1,
    };
    const text = "const a   =1;\nconst b   =2;\nconst c   =3;\n";
    const outcome = runLanguageOperation(
      { operation: "formatting", root, document: tsDocument("src/f.ts", text) },
      options("src/f.ts", { limits }),
    );
    expect(outcome.kind).toBe("formatting");
    if (outcome.kind === "formatting") {
      expect(outcome.result.edits).toHaveLength(1);
      expect(outcome.result.truncated).toBe(true);
    }
  });

  it("rejects formatting for an unsupported language", () => {
    const outcome = runLanguageOperation(
      {
        operation: "formatting",
        root,
        document: { path: "src/a.py", languageId: "python", text: "x = 1" },
      },
      options("src/a.py"),
    );
    expect(outcome).toMatchObject({ kind: "error", code: "UNSUPPORTED_LANGUAGE" });
  });
});

describe("bounds and result caps", () => {
  it("rejects an oversized document", () => {
    const limits: LanguageServiceLimits = {
      ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
      maxDocumentBytes: 4,
    };
    const outcome = runLanguageOperation(
      { operation: "diagnostics", root, document: tsDocument("src/a.ts", "const x = 1;\n") },
      options("src/a.ts", { limits }),
    );
    expect(outcome).toMatchObject({ kind: "error", code: "DOCUMENT_TOO_LARGE" });
  });

  it("fails closed when project discovery exceeds workspace caps", () => {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
      "utf8",
    );
    const text = "export const value = 1;\n";
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(root, "src", `many-${String(index)}.ts`), text, "utf8");
    }

    const outcome = runLanguageOperation(
      { operation: "diagnostics", root, document: tsDocument("src/many-0.ts", text) },
      options("src/many-0.ts", {
        limits: { ...DEFAULT_LANGUAGE_SERVICE_LIMITS, maxWorkspaceReadFiles: 2 },
      }),
    );

    expect(outcome).toMatchObject({ kind: "error", code: "DOCUMENT_TOO_LARGE" });
  });

  it("caps completion items and sets truncated", () => {
    const limits: LanguageServiceLimits = {
      ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
      maxCompletionItems: 1,
    };
    const text = "const value = { alpha: 1, beta: 2, gamma: 3 };\nvalue.\n";
    const outcome = runLanguageOperation(
      {
        operation: "completion",
        root,
        document: tsDocument("src/a.ts", text),
        position: { line: 1, character: 6 },
      },
      options("src/a.ts", { limits }),
    );
    expect(outcome.kind).toBe("completion");
    if (outcome.kind === "completion") {
      expect(outcome.result.items).toHaveLength(1);
      expect(outcome.result.truncated).toBe(true);
    }
  });

  it("caps diagnostics and sets truncated", () => {
    const limits: LanguageServiceLimits = { ...DEFAULT_LANGUAGE_SERVICE_LIMITS, maxDiagnostics: 1 };
    const text = "export const a: number = 'x';\nexport const b: number = 'y';\n";
    const outcome = runLanguageOperation(
      { operation: "diagnostics", root, document: tsDocument("src/a.ts", text) },
      options("src/a.ts", { limits }),
    );
    expect(outcome.kind).toBe("diagnostics");
    if (outcome.kind === "diagnostics") {
      expect(outcome.result.diagnostics).toHaveLength(1);
      expect(outcome.result.truncated).toBe(true);
    }
  });

  it("caps document symbols and sets truncated", () => {
    const limits: LanguageServiceLimits = { ...DEFAULT_LANGUAGE_SERVICE_LIMITS, maxSymbols: 1 };
    const text = "export function one() {}\nexport function two() {}\nexport function three() {}\n";
    const outcome = runLanguageOperation(
      { operation: "symbols", root, document: tsDocument("src/s.ts", text) },
      options("src/s.ts", { limits }),
    );
    expect(outcome.kind).toBe("symbols");
    if (outcome.kind === "symbols") {
      expect(outcome.result.symbols).toHaveLength(1);
      expect(outcome.result.truncated).toBe(true);
    }
  });

  it("rejects an unsupported language", () => {
    const outcome = runLanguageOperation(
      {
        operation: "diagnostics",
        root,
        document: { path: "src/a.py", languageId: "python", text: "x = 1" },
      },
      options("src/a.py"),
    );
    expect(outcome).toMatchObject({ kind: "error", code: "UNSUPPORTED_LANGUAGE" });
  });
});

describe("cancellation and timeout are bounded and distinguishable", () => {
  it("returns CANCELLED for a pre-aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = runLanguageOperation(
      { operation: "diagnostics", root, document: tsDocument("src/a.ts", "const x = 1;\n") },
      options("src/a.ts", { signal: controller.signal }),
    );
    expect(outcome).toMatchObject({ kind: "error", code: "CANCELLED" });
  });

  it("returns TIMED_OUT when the deadline has already elapsed", () => {
    const limits: LanguageServiceLimits = { ...DEFAULT_LANGUAGE_SERVICE_LIMITS, deadlineMs: 0 };
    // Every clock read jumps far past the deadline so the first cancellation check always fires
    // timeout, regardless of the deadlineMs default.
    let tick = 0;
    const now = (): number => {
      tick += 10_000;
      return tick;
    };
    const outcome = runLanguageOperation(
      { operation: "diagnostics", root, document: tsDocument("src/a.ts", "const x = 1;\n") },
      options("src/a.ts", { limits, now }),
    );
    expect(outcome).toMatchObject({ kind: "error", code: "TIMED_OUT" });
  });
});

describe("provider pluggability (AC7)", () => {
  function stubProvider(): LanguageProvider {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    return {
      descriptor: {
        id: "stub",
        languages: ["fictional"],
        operations: ["diagnostics"],
        availability: "available",
      },
      supports: (languageId: string): boolean => languageId === "fictional",
      getDiagnostics: () => ({
        diagnostics: [{ range, severity: "warning", message: "stub diagnostic", source: "stub" }],
        truncated: false,
      }),
      getCompletions: () => ({ items: [], isIncomplete: false, truncated: false }),
      getHover: () => ({ contents: null }),
      getSymbols: () => ({ symbols: [], truncated: false }),
      getFormatting: () => ({ edits: [], truncated: false }),
    };
  }

  it("resolves a custom-registry provider for a new languageId without a contract change", () => {
    const registry = createLanguageProviderRegistry([stubProvider()]);
    const outcome = runLanguageOperation(
      {
        operation: "diagnostics",
        root,
        document: { path: "src/x.fic", languageId: "fictional", text: "anything" },
      },
      options("src/x.fic", { registry }),
    );
    expect(outcome.kind).toBe("diagnostics");
    if (outcome.kind === "diagnostics") {
      expect(outcome.result.diagnostics[0]?.message).toBe("stub diagnostic");
      expect(outcome.result.diagnostics[0]?.source).toBe("stub");
    }
  });

  it("rejects operations a provider descriptor does not advertise", () => {
    const registry = createLanguageProviderRegistry([stubProvider()]);
    const outcome = runLanguageOperation(
      {
        operation: "completion",
        root,
        document: { path: "src/x.fic", languageId: "fictional", text: "anything" },
        position: { line: 0, character: 0 },
      },
      options("src/x.fic", { registry }),
    );
    expect(outcome).toMatchObject({ kind: "error", code: "UNSUPPORTED_OPERATION" });
  });

  it("rejects formatting for a provider that advertises only diagnostics", () => {
    const registry = createLanguageProviderRegistry([stubProvider()]);
    const outcome = runLanguageOperation(
      {
        operation: "formatting",
        root,
        document: { path: "src/x.fic", languageId: "fictional", text: "anything" },
      },
      options("src/x.fic", { registry }),
    );
    expect(outcome).toMatchObject({ kind: "error", code: "UNSUPPORTED_OPERATION" });
  });
});
// Issue #1379 AC2 (ADR-0067 D3) — describeLanguageCapabilities is exhaustive over the canonical
// mode map: every known language id resolves to a descriptor, never null.
describe("describeLanguageCapabilities exhaustiveness (Issue #1379 AC2)", () => {
  it("returns at least one descriptor whose languages include every known mode-map id", () => {
    const capabilities = describeLanguageCapabilities();
    for (const languageId of EDITOR_LANGUAGE_MODE_IDS) {
      const descriptor = capabilities.providers.find((entry) =>
        entry.languages.includes(languageId),
      );
      expect(descriptor, `no descriptor covers ${languageId}`).toBeDefined();
    }
  });

  it("preserves the real available + unavailable-LSP descriptors unchanged (default registry)", () => {
    const capabilities = describeLanguageCapabilities();
    // The TypeScript/JS provider stays available with its full operation set.
    const ts = capabilities.providers.find((entry) => entry.id === "typescript");
    expect(ts?.availability).toBe("available");
    expect(ts?.operations).toEqual(TYPESCRIPT_OPERATIONS);
    // JSON + builtin-text remain available; the external LSPs remain unavailable.
    expect(capabilities.providers.find((entry) => entry.id === "json")?.availability).toBe(
      "available",
    );
    for (const provider of capabilities.providers.filter((entry) => entry.id !== "typescript")) {
      expect(
        provider.operations.some((operation) =>
          NAVIGATION_REFACTORING_OPERATION_SET.has(operation),
        ),
      ).toBe(false);
    }
    expect(capabilities.providers.find((entry) => entry.id === "python-lsp")?.availability).toBe(
      "unavailable",
    );
    // With the default registry every mode-map id is already covered by a real or LSP descriptor,
    // so no synthetic "none" descriptor is appended.
    expect(capabilities.providers.some((entry) => entry.id === "none")).toBe(false);
  });

  it("synthesizes an unavailable descriptor for a known language no provider covers", () => {
    // A sparse registry that serves ONLY a fictional language, so every canonical mode-map id is
    // uncovered and must be synthesized as unavailable.
    const stub: LanguageProvider = {
      descriptor: {
        id: "stub",
        languages: ["fictional"],
        operations: ["diagnostics"],
        availability: "available",
      },
      supports: (languageId: string): boolean => languageId === "fictional",
      getDiagnostics: () => ({ diagnostics: [], truncated: false }),
      getCompletions: () => ({ items: [], isIncomplete: false, truncated: false }),
      getHover: () => ({ contents: null }),
      getSymbols: () => ({ symbols: [], truncated: false }),
      getFormatting: () => ({ edits: [], truncated: false }),
    };
    const registry = createLanguageProviderRegistry([stub]);
    const capabilities = describeLanguageCapabilities(registry);

    for (const languageId of EDITOR_LANGUAGE_MODE_IDS) {
      const descriptor = capabilities.providers.find((entry) =>
        entry.languages.includes(languageId),
      );
      expect(descriptor, `no descriptor covers ${languageId}`).toBeDefined();
      expect(descriptor?.id).toBe("none");
      expect(descriptor?.availability).toBe("unavailable");
      expect(descriptor?.operations).toEqual([]);
      expect(descriptor?.unavailableReason).toBe(NO_PROVIDER_UNAVAILABLE_REASON);
      expect(descriptor?.languages).toEqual([languageId]);
    }
    // The real stub descriptor is still present and untouched.
    expect(capabilities.providers.find((entry) => entry.id === "stub")?.availability).toBe(
      "available",
    );
  });
});

// Issue #1379 AC3 (ADR-0067 D5) — an unsupported language degrades safely: UNSUPPORTED_LANGUAGE,
// never an exception.
describe("unsupported language degrades without throwing (Issue #1379 AC3)", () => {
  it("returns UNSUPPORTED_LANGUAGE for an unknown languageId", () => {
    let outcome: ReturnType<typeof runLanguageOperation> | undefined;
    expect(() => {
      outcome = runLanguageOperation(
        {
          operation: "diagnostics",
          root,
          document: { path: "notes.txt", languageId: "totally-unknown", text: "hello" },
        },
        options("notes.txt"),
      );
    }).not.toThrow();
    expect(outcome).toMatchObject({ kind: "error", code: "UNSUPPORTED_LANGUAGE" });
  });

  it("returns UNSUPPORTED_LANGUAGE for the plaintext fallback (not a registry language)", () => {
    let outcome: ReturnType<typeof runLanguageOperation> | undefined;
    expect(() => {
      outcome = runLanguageOperation(
        {
          operation: "completion",
          root,
          document: { path: "notes.txt", languageId: "plaintext", text: "hello" },
          position: { line: 0, character: 0 },
        },
        options("notes.txt"),
      );
    }).not.toThrow();
    expect(outcome).toMatchObject({ kind: "error", code: "UNSUPPORTED_LANGUAGE" });
  });
});
