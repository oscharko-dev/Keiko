import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  type LanguageServiceLimits,
  type LanguageServiceRequest,
} from "@oscharko-dev/keiko-contracts";
import {
  describeLanguageCapabilities,
  runLanguageOperation,
  type RunLanguageOperationOptions,
} from "./languageService.js";
import { createLanguageProviderRegistry, type LanguageProvider } from "./languageProvider.js";

let root: string;

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
    expect(capabilities.providers).toHaveLength(1);
    const [provider] = capabilities.providers;
    expect(provider?.id).toBe("typescript");
    expect(provider?.languages).toEqual([
      "typescript",
      "typescriptreact",
      "javascript",
      "javascriptreact",
    ]);
    expect(provider?.operations).toEqual(["diagnostics", "completion", "hover", "symbols"]);
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
      descriptor: { id: "stub", languages: ["fictional"], operations: ["diagnostics"] },
      supports: (languageId: string): boolean => languageId === "fictional",
      getDiagnostics: () => ({
        diagnostics: [{ range, severity: "warning", message: "stub diagnostic", source: "stub" }],
        truncated: false,
      }),
      getCompletions: () => ({ items: [], isIncomplete: false, truncated: false }),
      getHover: () => ({ contents: null }),
      getSymbols: () => ({ symbols: [], truncated: false }),
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
});
