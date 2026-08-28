import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appDirectory, "../../../..");
const styleExceptionsPath = resolve(repositoryRoot, "docs/design-system/styling-exceptions.json");
// This is intentionally an equality pin rather than a capacity: every compatibility migration
// must lower it in the same change, and any new exception needs an explicit governance decision.
const EXPECTED_COMPATIBILITY_EXCEPTION_SOURCES = 38;

interface StylingException {
  readonly source: string;
  readonly globalSelectors: readonly string[];
  readonly unprefixedLocalClasses: readonly string[];
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

function withoutGlobalSelectors(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const globalStart = source.indexOf(":global(", index);
    if (globalStart === -1) return result + source.slice(index);
    result += source.slice(index, globalStart);
    index = globalStart + ":global(".length;
    let depth = 1;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      index += 1;
    }
  }
  return result;
}

function localClassNames(source: string): ReadonlySet<string> {
  return new Set(
    Array.from(
      withoutGlobalSelectors(source).matchAll(/(?<![\w-])\.([A-Za-z_][\w-]*)/gmu),
      (match) => match[1]!,
    ),
  );
}

function globalSelectors(source: string): readonly string[] {
  const selectors: string[] = [];
  let index = 0;
  while (index < source.length) {
    const globalStart = source.indexOf(":global(", index);
    if (globalStart === -1) break;

    index = globalStart + ":global(".length;
    const selectorStart = index;
    let depth = 1;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      index += 1;
    }
    selectors.push(source.slice(selectorStart, index - 1));
  }
  return selectors.sort();
}

function exceptionRegister(): StylingExceptionRegister {
  return JSON.parse(readFileSync(styleExceptionsPath, "utf8")) as StylingExceptionRegister;
}

function exceptionDetails(source: string, prefix: string): Omit<StylingException, "source"> {
  return {
    globalSelectors: globalSelectors(source),
    unprefixedLocalClasses: [...localClassNames(source)]
      .filter((className) => !className.startsWith(prefix))
      .sort(),
  };
}

function registeredExceptions(
  register: StylingExceptionRegister,
): ReadonlyMap<string, Omit<StylingException, "source">> {
  return new Map(register.exceptions.map(({ source, ...details }) => [source, details]));
}

describe("Design-system styling exception register", () => {
  it("is a shrink-only, exhaustive inventory of CSS Module compatibility exceptions", () => {
    const register = exceptionRegister();
    const registered = registeredExceptions(register);
    const actual = new Map<string, Omit<StylingException, "source">>();

    for (const path of cssModulePaths(appDirectory)) {
      const details = exceptionDetails(
        readFileSync(path, "utf8"),
        register.canonicalLocalClassPrefix,
      );
      if (details.globalSelectors.length > 0 || details.unprefixedLocalClasses.length > 0) {
        actual.set(relative(repositoryRoot, path), details);
      }
    }

    expect(register.schemaVersion).toBe(2);
    expect(register.canonicalLocalClassPrefix).toBe("cmp");
    expect(new Set(register.exceptions.map((entry) => entry.source)).size).toBe(
      register.exceptions.length,
    );
    expect(register.exceptions).toHaveLength(EXPECTED_COMPATIBILITY_EXCEPTION_SOURCES);
    expect([...registered.keys()].sort()).toStrictEqual([...actual.keys()].sort());
    for (const [source, details] of actual) {
      expect(registered.get(source)).toStrictEqual(details);
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
    expect(exceptionDetails(workbench, "cmp").globalSelectors).toContain(".window");
  });

  it("detects local classes in combinator positions without treating global selectors as local", () => {
    expect(localClassNames(".cmpCard .legacyIcon > .cmpBadge { color: red; }")).toStrictEqual(
      new Set(["cmpCard", "legacyIcon", "cmpBadge"]),
    );
    expect(
      localClassNames(":global(.thirdParty .legacyIcon) .cmpCard { color: red; }"),
    ).toStrictEqual(new Set(["cmpCard"]));
  });

  it("detects added selectors in an already registered exception source", () => {
    const baseline = exceptionDetails(".legacyCard :global(.vendor) { color: red; }", "cmp");
    const expanded = exceptionDetails(
      ".legacyCard .legacyBadge :global(.vendor .nested) { color: red; }",
      "cmp",
    );

    expect(baseline).toStrictEqual({
      globalSelectors: [".vendor"],
      unprefixedLocalClasses: ["legacyCard"],
    });
    expect(expanded).toStrictEqual({
      globalSelectors: [".vendor .nested"],
      unprefixedLocalClasses: ["legacyBadge", "legacyCard"],
    });
    expect(expanded).not.toStrictEqual(baseline);
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
