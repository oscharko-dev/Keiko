import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  type LanguageDiagnostic,
  type LanguagePosition,
  type LanguageRange,
  type LanguageServiceLimits,
  type LanguageTextEdit,
} from "@oscharko-dev/keiko-contracts";
import { computeLineStarts, positionToOffset } from "@oscharko-dev/keiko-contracts/line-offsets";
import type { WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import ts from "typescript";
import { createDeadlineCancellation } from "./languageCancellation.js";
import type { LanguageProviderContext } from "./languageProvider.js";
import {
  resolveTypescriptCodeActions,
  resolveTypescriptInlayHints,
  resolveTypescriptRenameApply,
  resolveTypescriptRenamePrepare,
  resolveTypescriptSignatureHelp,
} from "./typescriptRefactoringProvider.js";
import {
  createTypescriptProjectService,
  getProjectDiagnostics,
  type TypescriptProjectHandle,
} from "./typescriptProjectService.js";

const ROOT = "/workspace";

function tsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      strict: true,
      lib: [],
      module: "ESNext",
      moduleResolution: "Bundler",
      target: "ES2022",
    },
    include: ["src/**/*.ts"],
  });
}

function positionOf(text: string, needle: string, offset = 0): LanguagePosition {
  const index = text.indexOf(needle, offset);
  if (index < 0) throw new Error(`needle not found: ${needle}`);
  const prefix = text.slice(0, index);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function rangeOf(text: string, needle: string): LanguageRange {
  const start = positionOf(text, needle);
  return {
    start,
    end: { line: start.line, character: start.character + needle.length },
  };
}

function directoryStat(): WorkspaceStat {
  return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
}

function testFs(files: Readonly<Record<string, string>>): WorkspaceFs {
  const base = memFs(ROOT, files);
  return {
    ...base,
    exists: (absolutePath: string): boolean =>
      base.exists(absolutePath) || base.readDir(absolutePath).length > 0,
    stat: (absolutePath: string): WorkspaceStat => {
      const stat = base.stat(absolutePath);
      return stat.isFile || base.readDir(absolutePath).length === 0 ? stat : directoryStat();
    },
  };
}

function ctx(
  fs: WorkspaceFs,
  relativePath: string,
  overlayText: string,
  limits: LanguageServiceLimits = DEFAULT_LANGUAGE_SERVICE_LIMITS,
): LanguageProviderContext {
  return {
    fs,
    root: ROOT,
    overlayPath: `${ROOT}/${relativePath}`,
    overlayText,
    languageId: "typescript",
    limits,
    cancellation: createDeadlineCancellation({ deadlineMs: limits.deadlineMs, now: () => 0 }),
  };
}

function project(
  files: Readonly<Record<string, string>>,
  relativePath: string,
  limits: LanguageServiceLimits = DEFAULT_LANGUAGE_SERVICE_LIMITS,
): TypescriptProjectHandle {
  const fs = testFs(files);
  const result = createTypescriptProjectService().resolveProject(
    ctx(fs, relativePath, files[relativePath] ?? "", limits),
  );
  expect(result.kind).toBe("project");
  if (result.kind !== "project") throw new Error("expected project");
  return result.project;
}

function basicRenameFiles(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    "tsconfig.json": tsconfig(),
    "src/decl.ts": "export const sharedValue = 1;\n",
    "src/main.ts": "import { sharedValue } from './decl.js';\nexport const use = sharedValue;\n",
    ...extra,
  };
}

function applyEdits(text: string, edits: readonly LanguageTextEdit[]): string {
  const lineStarts = computeLineStarts(text);
  return [...edits]
    .sort(
      (left, right) =>
        positionToOffset(text, lineStarts, right.range.start) -
        positionToOffset(text, lineStarts, left.range.start),
    )
    .reduce((current, edit) => {
      const starts = computeLineStarts(current);
      const start = positionToOffset(current, starts, edit.range.start);
      const end = positionToOffset(current, starts, edit.range.end);
      return `${current.slice(0, start)}${edit.newText}${current.slice(end)}`;
    }, text);
}

function missingImportDiagnostic(projectHandle: TypescriptProjectHandle): LanguageDiagnostic {
  const diagnostic = getProjectDiagnostics(projectHandle).diagnostics.find(
    (item) => item.code === "2304",
  );
  expect(diagnostic).toBeDefined();
  if (diagnostic === undefined) throw new Error("expected diagnostic");
  return diagnostic;
}

function fakeProject(
  service: Partial<ts.LanguageService>,
  sourceByFile: Readonly<Record<string, string>>,
  limits: LanguageServiceLimits = DEFAULT_LANGUAGE_SERVICE_LIMITS,
): TypescriptProjectHandle {
  const overlayPath = `${ROOT}/src/main.ts`;
  return {
    service: service as ts.LanguageService,
    configPath: `${ROOT}/tsconfig.json`,
    projectKey: "fake",
    rootFileNames: Object.keys(sourceByFile),
    limits,
    cancellation: createDeadlineCancellation({ deadlineMs: limits.deadlineMs, now: () => 0 }),
    overlayPath,
    overlayText: sourceByFile[overlayPath] ?? "",
    wasReused: false,
    truncated: false,
    sourceText: (fileName: string): string | undefined => sourceByFile[fileName],
    workspaceRelativePath: (fileName: string): string | undefined =>
      fileName.startsWith(`${ROOT}/`) ? fileName.slice(ROOT.length + 1) : undefined,
  };
}

describe("typescript refactoring provider", () => {
  it("returns inferred parameter-name and type inlay hints", () => {
    const text =
      "function format(value: string, repeat: number): string { return value.repeat(repeat); }\n" +
      "let inferred = format('x', 2);\n";
    const files = { "tsconfig.json": tsconfig(), "src/main.ts": text };
    const hints = resolveTypescriptInlayHints(project(files, "src/main.ts"), {
      start: { line: 0, character: 0 },
      end: { line: 1, character: "let inferred = format('x', 2);".length },
    });

    expect(hints.hints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "value:", kind: "parameter" }),
        expect.objectContaining({ label: "repeat:", kind: "parameter" }),
        expect.objectContaining({ label: ": string", kind: "type" }),
      ]),
    );
  });

  it("prepares rename at a renameable position and returns a negative result in comments", () => {
    const files = basicRenameFiles({
      "src/comment.ts": "// sharedValue\nexport const value = 1;\n",
    });
    const handle = project(files, "src/decl.ts");
    const prepared = resolveTypescriptRenamePrepare(
      handle,
      positionOf(files["src/decl.ts"] ?? "", "sharedValue"),
    );
    const missing = resolveTypescriptRenamePrepare(
      project(files, "src/comment.ts"),
      positionOf(files["src/comment.ts"] ?? "", "sharedValue"),
    );

    expect(prepared).toEqual({
      range: { start: { line: 0, character: 13 }, end: { line: 0, character: 24 } },
      placeholder: "sharedValue",
    });
    expect(missing.range).toBeNull();
    if (missing.range !== null) throw new Error("expected negative rename prepare result");
    expect(missing.reason.length).toBeGreaterThan(0);
  });

  it("computes a reviewable cross-file rename changeset without mutating source files", () => {
    const files = basicRenameFiles();
    const handle = project(files, "src/decl.ts");
    const result = resolveTypescriptRenameApply(
      handle,
      positionOf(files["src/decl.ts"] ?? "", "sharedValue"),
      "renamedValue",
    );

    expect(result.kind).toBe("result");
    if (result.kind !== "result") throw new Error("expected rename result");
    expect(new Set(result.result.files.map((file) => file.path))).toEqual(
      new Set(["src/decl.ts", "src/main.ts"]),
    );
    expect(result.result.files.every((file) => file.expectedContentHash.length === 64)).toBe(true);
    expect(files["src/main.ts"]).toContain("sharedValue");
    expect(result.result.files.flatMap((file) => file.edits).map((edit) => edit.newText)).toEqual(
      expect.arrayContaining(["renamedValue"]),
    );
  });

  it("returns a content-free renameApply error when no symbol is renameable", () => {
    const files = basicRenameFiles({ "src/comment.ts": "// detached\nexport const value = 1;\n" });
    const result = resolveTypescriptRenameApply(
      project(files, "src/comment.ts"),
      { line: 0, character: 3 },
      "renamed",
    );

    expect(result).toEqual({
      kind: "error",
      code: "INVALID_REQUEST",
      message: "No renameable symbol is available at this position.",
    });
  });

  it("returns a compiler quick fix whose edit resolves a missing import diagnostic", () => {
    const files = {
      "tsconfig.json": tsconfig(),
      "src/helper.ts": "export const helperValue = 1;\n",
      "src/main.ts": "export const result = helperValue;\n",
    };
    const handle = project(files, "src/main.ts");
    const diagnostic = missingImportDiagnostic(handle);
    const actions = resolveTypescriptCodeActions(handle, diagnostic.range, [diagnostic]);

    expect(actions.actions.length).toBeGreaterThan(0);
    const edits = actions.actions.find((action) => action.edits !== null)?.edits ?? [];
    expect(edits.length).toBeGreaterThan(0);
    const nextText = applyEdits(files["src/main.ts"], edits);
    const nextProject = project({ ...files, "src/main.ts": nextText }, "src/main.ts");
    expect(
      getProjectDiagnostics(nextProject).diagnostics.some((item) => item.code === "2304"),
    ).toBe(false);
  });

  it("returns an empty code-action result when the compiler offers none", () => {
    const files = basicRenameFiles({ "src/plain.ts": "// no code action here\n" });
    const handle = project(files, "src/plain.ts");
    const result = resolveTypescriptCodeActions(
      handle,
      rangeOf(files["src/plain.ts"] ?? "", "no"),
      [],
    );

    expect(result).toEqual({
      actions: [],
      truncated: false,
      returnedCount: 0,
      totalCount: 0,
    });
  });

  it("returns overload signature help inside a call and an empty result outside calls", () => {
    const text =
      "export function choose(value: string): string;\n" +
      "export function choose(value: number): number;\n" +
      "export function choose(value: string | number): string | number { return value; }\n" +
      "export const result = choose(1);\n";
    const files = { "tsconfig.json": tsconfig(), "src/main.ts": text };
    const handle = project(files, "src/main.ts");
    const help = resolveTypescriptSignatureHelp(
      handle,
      positionOf(text, "1", text.indexOf("choose(1")),
    );
    const empty = resolveTypescriptSignatureHelp(handle, { line: 0, character: 0 });

    expect(help.signatures.map((signature) => signature.label)).toEqual(
      expect.arrayContaining(["choose(value: string): string", "choose(value: number): number"]),
    );
    expect(help.activeSignature).toBe(1);
    expect(help.activeParameter).toBe(0);
    expect(empty).toEqual({
      signatures: [],
      activeSignature: null,
      activeParameter: null,
      truncated: false,
      returnedCount: 0,
      totalCount: 0,
    });
  });

  it("signals truncation for rename edits, code actions, and signatures", () => {
    const files = basicRenameFiles(
      Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [
          `src/use-${String(index)}.ts`,
          "import { sharedValue } from './decl.js';\nexport const use = sharedValue;\n",
        ]),
      ),
    );
    const rename = resolveTypescriptRenameApply(
      project(files, "src/decl.ts", {
        ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
        maxRenameChangesetEdits: 2,
      }),
      positionOf(files["src/decl.ts"] ?? "", "sharedValue"),
      "renamed",
    );
    const codeActions = resolveTypescriptCodeActions(
      fakeCodeActionProject({ ...DEFAULT_LANGUAGE_SERVICE_LIMITS, maxCodeActions: 1 }),
      rangeOf("missing", "missing"),
      [{ code: "2304" }],
    );
    const signature = resolveTypescriptSignatureHelp(
      fakeSignatureProject({ ...DEFAULT_LANGUAGE_SERVICE_LIMITS, maxSignatures: 1 }),
      { line: 0, character: 3 },
    );

    expect(rename.kind).toBe("result");
    if (rename.kind === "result") {
      expect(rename.result.truncated).toBe(true);
      expect(rename.result.returnedEditCount).toBeLessThan(rename.result.totalEditCount);
    }
    expect(codeActions.truncated).toBe(true);
    expect(codeActions.returnedCount).toBe(1);
    expect(codeActions.totalCount).toBe(2);
    expect(signature.truncated).toBe(true);
    expect(signature.returnedCount).toBe(1);
    expect(signature.totalCount).toBe(2);
  });

  it("caps the rename changeset by file count and flags filesTruncated", () => {
    const files = basicRenameFiles(
      Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [
          `src/use-${String(index)}.ts`,
          "import { sharedValue } from './decl.js';\nexport const use = sharedValue;\n",
        ]),
      ),
    );
    const rename = resolveTypescriptRenameApply(
      project(files, "src/decl.ts", {
        ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
        maxRenameChangesetFiles: 2,
      }),
      positionOf(files["src/decl.ts"] ?? "", "sharedValue"),
      "renamed",
    );

    expect(rename.kind).toBe("result");
    if (rename.kind === "result") {
      expect(rename.result.filesTruncated).toBe(true);
      expect(rename.result.returnedFileCount).toBe(2);
      expect(rename.result.returnedFileCount).toBeLessThan(rename.result.totalFileCount);
    }
  });

  it("excludes rename and code-action edit locations outside the workspace root", () => {
    const rename = resolveTypescriptRenameApply(
      fakeOutsideRenameProject(),
      { line: 0, character: 1 },
      "renamed",
    );
    const actions = resolveTypescriptCodeActions(
      fakeOutsideCodeActionProject(),
      rangeOf("target", "target"),
      [{ code: "2304" }],
    );

    expect(rename.kind).toBe("result");
    if (rename.kind === "result") {
      expect(rename.result.files.map((file) => file.path)).toEqual(["src/main.ts"]);
    }
    expect(actions.actions[0]?.edits).toHaveLength(1);
    expect(actions.actions[0]?.edits?.[0]?.newText).toBe("inside");
  });
});

function fakeCodeActionProject(limits: LanguageServiceLimits): TypescriptProjectHandle {
  const source = { [`${ROOT}/src/main.ts`]: "missing" };
  const changes = (label: string): ts.CodeFixAction => ({
    description: label,
    fixName: label,
    changes: [
      {
        fileName: `${ROOT}/src/main.ts`,
        textChanges: [{ span: { start: 0, length: 7 }, newText: label }],
      },
    ],
  });
  return fakeProject(
    {
      getCodeFixesAtPosition: () => [changes("one"), changes("two")],
      getApplicableRefactors: () => [],
    },
    source,
    limits,
  );
}

function fakeSignatureProject(limits: LanguageServiceLimits): TypescriptProjectHandle {
  const item = (name: string): ts.SignatureHelpItem => ({
    isVariadic: false,
    prefixDisplayParts: [{ text: `${name}(`, kind: "text" }],
    suffixDisplayParts: [{ text: ")", kind: "text" }],
    separatorDisplayParts: [{ text: ", ", kind: "text" }],
    parameters: [],
    documentation: [],
    tags: [],
  });
  return fakeProject(
    {
      getSignatureHelpItems: () => ({
        items: [item("first"), item("second")],
        applicableSpan: { start: 0, length: 5 },
        selectedItemIndex: 0,
        argumentIndex: 0,
        argumentCount: 0,
      }),
    },
    { [`${ROOT}/src/main.ts`]: "fn(" },
    limits,
  );
}

function fakeOutsideRenameProject(): TypescriptProjectHandle {
  return fakeProject(
    {
      getRenameInfo: () => ({
        canRename: true,
        displayName: "target",
        fullDisplayName: "target",
        kind: ts.ScriptElementKind.constElement,
        kindModifiers: "",
        triggerSpan: { start: 0, length: 6 },
      }),
      findRenameLocations: () => [
        { fileName: `${ROOT}/src/main.ts`, textSpan: { start: 0, length: 6 } },
        { fileName: "/outside/escape.ts", textSpan: { start: 0, length: 6 } },
      ],
    },
    { [`${ROOT}/src/main.ts`]: "target" },
  );
}

function fakeOutsideCodeActionProject(): TypescriptProjectHandle {
  return fakeProject(
    {
      getCodeFixesAtPosition: () => [
        {
          description: "mixed fix",
          fixName: "mixed",
          changes: [
            {
              fileName: "/outside/escape.ts",
              textChanges: [{ span: { start: 0, length: 6 }, newText: "outside" }],
            },
            {
              fileName: `${ROOT}/src/main.ts`,
              textChanges: [{ span: { start: 0, length: 6 }, newText: "inside" }],
            },
          ],
        },
      ],
      getApplicableRefactors: () => [],
    },
    { [`${ROOT}/src/main.ts`]: "target" },
  );
}
