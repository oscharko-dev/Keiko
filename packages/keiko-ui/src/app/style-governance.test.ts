import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appDirectory, "../../../..");
const styleExceptionsPath = resolve(repositoryRoot, "docs/design-system/styling-exceptions.json");
const MAX_COMPATIBILITY_EXCEPTION_SOURCES = 38;

type ExceptionKind = "global-selector-coupling" | "unprefixed-local-classes";

interface StylingException {
  readonly source: string;
  readonly kinds: readonly ExceptionKind[];
}

interface StylingExceptionRegister {
  readonly schemaVersion: number;
  readonly canonicalLocalClassPrefix: string;
  readonly exceptions: readonly StylingException[];
}

function cssModulePaths(directory: string): readonly string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...cssModulePaths(path));
    } else if (entry.name.endsWith(".module.css")) {
      paths.push(path);
    }
  }
  return paths;
}

function localClassNames(source: string): ReadonlySet<string> {
  return new Set(
    Array.from(source.matchAll(/(?:^|[,{]\s*)\.([A-Za-z_][\w-]*)/gmu), (match) => match[1]!),
  );
}

function exceptionKinds(source: string, prefix: string): readonly ExceptionKind[] {
  const kinds: ExceptionKind[] = [];
  if (Array.from(localClassNames(source)).some((className) => !className.startsWith(prefix))) {
    kinds.push("unprefixed-local-classes");
  }
  if (source.includes(":global(")) kinds.push("global-selector-coupling");
  return kinds;
}

function exceptionRegister(): StylingExceptionRegister {
  return JSON.parse(readFileSync(styleExceptionsPath, "utf8")) as StylingExceptionRegister;
}

function registeredKinds(
  register: StylingExceptionRegister,
): ReadonlyMap<string, readonly ExceptionKind[]> {
  return new Map(register.exceptions.map((entry) => [entry.source, entry.kinds]));
}

describe("Design-system styling exception register", () => {
  it("is a shrink-only, exhaustive inventory of CSS Module compatibility exceptions", () => {
    const register = exceptionRegister();
    const registered = registeredKinds(register);
    const actual = new Map<string, readonly ExceptionKind[]>();

    for (const path of cssModulePaths(appDirectory)) {
      const kinds = exceptionKinds(readFileSync(path, "utf8"), register.canonicalLocalClassPrefix);
      if (kinds.length > 0) actual.set(relative(repositoryRoot, path), kinds);
    }

    expect(register.schemaVersion).toBe(1);
    expect(register.canonicalLocalClassPrefix).toBe("cmp");
    expect(new Set(register.exceptions.map((entry) => entry.source)).size).toBe(
      register.exceptions.length,
    );
    expect(register.exceptions.length).toBeLessThanOrEqual(MAX_COMPATIBILITY_EXCEPTION_SOURCES);
    expect([...registered.keys()].sort()).toStrictEqual([...actual.keys()].sort());
    for (const [source, kinds] of actual) {
      expect(registered.get(source)).toStrictEqual(kinds);
    }
  });

  it("keeps the documented WorkspaceSelection and Coding Workbench exceptions bounded", () => {
    const workbench = readFileSync(
      resolve(
        appDirectory,
        "components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.module.css",
      ),
      "utf8",
    );
    const selection = readFileSync(
      resolve(appDirectory, "components/desktop/WorkspaceSelection.module.css"),
      "utf8",
    );

    expect(localClassNames(selection)).toStrictEqual(
      new Set(["marquee", "workspaceWindow", "selectionRing"]),
    );
    expect(workbench).toContain(":global(.window):has(.shell)");
    expect(exceptionKinds(workbench, "cmp")).toStrictEqual([
      "unprefixed-local-classes",
      "global-selector-coupling",
    ]);
  });

  it("does not permit new bare native-control rules in the global stylesheet", () => {
    const globalCssPath = resolve(appDirectory, "globals.css");
    const globalCss = readFileSync(globalCssPath, "utf8");
    const bareNativeRules = Array.from(
      globalCss.matchAll(
        /^(button|input|select|textarea|fieldset|label|summary|details|progress|dialog)\s*\{/gmu,
      ),
      (match) => match[1]!,
    );

    expect(bareNativeRules).toStrictEqual(["button"]);
    expect(globalCss).toContain(':root[data-input-modality="pointer"]\n  :where(\n    button,');
  });
});
