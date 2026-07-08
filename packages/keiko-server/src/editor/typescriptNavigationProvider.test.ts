import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  type LanguagePosition,
  type LanguageServiceLimits,
} from "@oscharko-dev/keiko-contracts";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createDeadlineCancellation } from "./languageCancellation.js";
import type { LanguageProviderContext } from "./languageProvider.js";
import {
  resolveTypescriptDefinition,
  resolveTypescriptReferences,
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

describe("typescript navigation provider", () => {
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

    expect(sameFile.locations[0]?.path).toBe("src/local.ts");
    expect(missing.locations).toEqual([]);
    expect(missing.includesDeclaration).toBe(false);
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
});
