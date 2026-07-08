import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  type LanguageServiceLimits,
} from "@oscharko-dev/keiko-contracts";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createDeadlineCancellation, isCancellation } from "./languageCancellation.js";
import type { LanguageProviderContext } from "./languageProvider.js";
import {
  createTypescriptProjectService,
  getProjectCompletions,
  getProjectDiagnostics,
  getProjectFormatting,
  getProjectHover,
  getProjectSymbols,
  type TypescriptProjectHandle,
} from "./typescriptProjectService.js";

let root: string;
let outside: string;

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-ts-project-")));
  root = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dirname(root), { recursive: true, force: true });
});

function writeProject(): void {
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
    "utf8",
  );
  writeFileSync(
    join(root, "src", "helper.ts"),
    "export function helper(value: number): number {\n  return value;\n}\n",
    "utf8",
  );
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

function resolveProject(relativePath: string, overlayText: string): TypescriptProjectHandle {
  const service = createTypescriptProjectService();
  const result = service.resolveProject(ctx(relativePath, overlayText));
  expect(result.kind).toBe("project");
  if (result.kind !== "project") throw new Error("expected project");
  return result.project;
}

describe("typescript project service", () => {
  it("builds a multi-file project service from a containing tsconfig", () => {
    writeProject();
    const overlay = "import { helper } from './helper.js';\nexport const result = helper('bad');\n";
    const project = resolveProject("src/main.ts", overlay);

    expect(project.rootFileNames.length).toBeGreaterThan(1);
    expect(project.rootFileNames).toContain(join(root, "src", "helper.ts"));
    const messages = getProjectDiagnostics(project)
      .diagnostics.map((item) => item.message)
      .join("\n")
      .toLowerCase();
    expect(messages).toContain("not assignable");
  });

  it("serves existing operations through the project service", () => {
    writeProject();
    const validProject = resolveProject(
      "src/main.ts",
      "import { helper } from './helper.js';\nhelper(1);\nconst obj = { alpha: 1 };\nobj;\n",
    );
    const completionProject = resolveProject(
      "src/main.ts",
      "import { helper } from './helper.js';\nhelper(1);\nconst obj = { alpha: 1 };\nobj.\n",
    );

    expect(getProjectDiagnostics(validProject).diagnostics).toEqual([]);
    expect(
      getProjectCompletions(completionProject, { line: 3, character: 4 }).items,
    ).toContainEqual(expect.objectContaining({ label: "alpha" }));
    expect(getProjectHover(validProject, { line: 1, character: 0 }).contents).toContain("helper");
    expect(getProjectSymbols(validProject).symbols.map((symbol) => symbol.name)).toContain("obj");
    expect(
      getProjectFormatting(resolveProject("src/f.ts", "const x   =   1;\n"), undefined).edits
        .length,
    ).toBeGreaterThan(0);
  });

  it("returns a notProject outcome when no tsconfig is discoverable", () => {
    const service = createTypescriptProjectService();
    const result = service.resolveProject(ctx("src/main.ts", "export const value = 1;\n"));

    expect(result).toEqual({
      kind: "notProject",
      reason: "No containing tsconfig.json was discovered.",
    });
  });

  it("reuses and evicts cached project services", () => {
    vi.useFakeTimers();
    writeProject();
    const service = createTypescriptProjectService({ idleTimeoutMs: 100 });

    const first = service.resolveProject(ctx("src/main.ts", "export const value = 1;\n"));
    const second = service.resolveProject(ctx("src/other.ts", "export const other = 2;\n"));

    expect(first.kind).toBe("project");
    expect(second.kind).toBe("project");
    if (second.kind === "project") expect(second.project.wasReused).toBe(true);
    expect(service.cacheSize()).toBe(1);

    vi.advanceTimersByTime(101);
    expect(service.cacheSize()).toBe(0);
  });

  it("fails closed with a structured error when project file enumeration exceeds the cap", () => {
    writeProject();
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(join(root, "src", `many-${String(index)}.ts`), "export const value = 1;\n");
    }
    const service = createTypescriptProjectService();
    const result = service.resolveProject(
      ctx("src/main.ts", "export const value = 1;\n", {
        ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
        maxWorkspaceReadFiles: 2,
      }),
    );

    // A workspace larger than the cap must never yield a partially-populated program (which would
    // answer cross-file navigation/rename with silently-incomplete results); it fails closed so the
    // provider falls back to the single-file overlay path (Issue #2100).
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("DOCUMENT_TOO_LARGE");
  });

  it("interrupts an operation when the request deadline has already passed", () => {
    writeProject();
    const service = createTypescriptProjectService();
    // deadlineMs 0 with a frozen clock at 0 means the deadline is already reached on the first
    // cooperative check, so the resolver refuses rather than running an uninterruptible analysis.
    const result = service.resolveProject(
      ctx("src/main.ts", "import { helper } from './helper.js';\nhelper(1);\n", {
        ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
        deadlineMs: 0,
      }),
    );
    expect(result.kind).toBe("project");
    if (result.kind !== "project") throw new Error("expected project");
    let thrown: unknown;
    try {
      getProjectDiagnostics(result.project);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(isCancellation(thrown)).toBe(true);
  });

  it("enforces the aggregate byte budget cumulatively across cross-file reads", () => {
    // Two sibling files, each individually under the per-file byte cap, but together over the
    // aggregate byte budget. The regression this guards: reads that reset their budget per host
    // call never accumulate, so the aggregate cap silently never bites.
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: false }, include: ["src/**/*.ts"] }),
      "utf8",
    );
    const filler = "// padding comment line to grow the file past the shared byte budget\n";
    writeFileSync(
      join(root, "src", "one.ts"),
      `export const one = 1;\n${filler.repeat(4)}`,
      "utf8",
    );
    writeFileSync(
      join(root, "src", "two.ts"),
      `export const two = 2;\n${filler.repeat(4)}`,
      "utf8",
    );
    const overlay =
      "import { one } from './one.js';\nimport { two } from './two.js';\nexport const sum = one + two;\n";
    const service = createTypescriptProjectService();
    const result = service.resolveProject(
      ctx("src/main.ts", overlay, {
        ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
        maxWorkspaceReadFileBytes: 1_000_000,
        maxWorkspaceReadBytes: 400,
      }),
    );
    expect(result.kind).toBe("project");
    if (result.kind !== "project") throw new Error("expected project");
    // Materialise the sibling files through the program, then observe the aggregate cap engaged.
    getProjectDiagnostics(result.project);
    expect(result.project.truncated).toBe(true);
  });

  it("rebuilds an evicted project rather than serving it stale", () => {
    vi.useFakeTimers();
    writeProject();
    const service = createTypescriptProjectService({ idleTimeoutMs: 100 });
    service.resolveProject(ctx("src/main.ts", "export const value = 1;\n"));
    expect(service.cacheSize()).toBe(1);

    vi.advanceTimersByTime(101);
    expect(service.cacheSize()).toBe(0);

    const rebuilt = service.resolveProject(ctx("src/main.ts", "export const value = 2;\n"));
    expect(rebuilt.kind).toBe("project");
    if (rebuilt.kind === "project") expect(rebuilt.project.wasReused).toBe(false);
    expect(service.cacheSize()).toBe(1);
  });

  it("rejects tsconfig extends paths that escape the workspace root", () => {
    writeFileSync(
      join(outside, "base.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "../outside/base.json" }));
    const service = createTypescriptProjectService();
    const result = service.resolveProject(
      ctx("src/main.ts", "export function f(x) { return x; }\n"),
    );

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("INVALID_REQUEST");
  });

  it("does not follow symlinked source files outside the workspace root", () => {
    writeProject();
    writeFileSync(join(outside, "secret.ts"), "export const secret = 1;\n", "utf8");
    try {
      symlinkSync(join(outside, "secret.ts"), join(root, "src", "escape.ts"));
    } catch {
      return;
    }
    const project = resolveProject("src/main.ts", "export const value = 1;\n");

    expect(project.rootFileNames).not.toContain(join(root, "src", "escape.ts"));
    expect(project.rootFileNames).not.toContain(join(outside, "secret.ts"));
  });
});
