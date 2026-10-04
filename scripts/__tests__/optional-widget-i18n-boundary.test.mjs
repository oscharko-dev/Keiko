import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/keiko-ui");
const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const optionalEnglish = resolve(root, "src/lib/i18n-messages.optional.en.ts");
const optionalGerman = resolve(root, "src/lib/i18n-messages.optional.de.ts");
const helper = resolve(root, "src/lib/optional-widget-i18n.ts");

function isRuntimeImport(statement) {
  const clause = statement.importClause;
  if (clause?.isTypeOnly) return false;
  const bindings = clause?.namedBindings;
  return !(
    bindings &&
    ts.isNamedImports(bindings) &&
    !clause.name &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function staticDependencies(file, overrides) {
  const text = overrides.get(file) ?? readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = source.statements.filter(
    (statement) =>
      (ts.isImportDeclaration(statement) && isRuntimeImport(statement)) ||
      (ts.isExportDeclaration(statement) && !statement.isTypeOnly),
  );
  return imports.flatMap((statement) => {
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const resolved = ts.resolveModuleName(statement.moduleSpecifier.text, file, options, ts.sys);
    const target = resolved.resolvedModule?.resolvedFileName;
    return target?.startsWith(resolve(root, "src")) ? [target] : [];
  });
}

function closure(entries, overrides = new Map()) {
  const visited = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    pending.push(...staticDependencies(file, overrides));
  }
  return visited;
}

const initial = [
  "src/app/page.tsx",
  "src/app/layout.tsx",
  "src/app/components/desktop/update/UpdateStartupNotice.tsx",
].map((file) => resolve(root, file));

describe("optional widget locale import ownership", () => {
  it("keeps both optional catalogs outside initial application and startup notice imports", () => {
    const modules = closure(initial);
    expect(modules.has(helper)).toBe(false);
    expect(modules.has(optionalEnglish)).toBe(false);
    expect(modules.has(optionalGerman)).toBe(false);
  });

  it("loads English widget copy with Chat while keeping German behind its locale import", () => {
    const modules = closure([resolve(root, "src/app/components/desktop/ChatWindow.tsx")]);
    expect(modules.has(helper)).toBe(true);
    expect(modules.has(optionalEnglish)).toBe(true);
    expect(modules.has(optionalGerman)).toBe(false);
    expect(readFileSync(helper, "utf8")).toContain('import("./i18n-messages.optional.de")');
  });

  it("detects an accidental initial widget-catalog import through the same resolver", () => {
    const entry = initial[0];
    const overrides = new Map([
      [entry, readFileSync(entry, "utf8") + '\nimport "@/lib/optional-widget-i18n";\n'],
    ]);
    expect(closure(initial, overrides).has(optionalEnglish)).toBe(true);
  });

  it("detects an eager German catalog added to the widget translator", () => {
    const overrides = new Map([
      [helper, readFileSync(helper, "utf8") + '\nimport "./i18n-messages.optional.de";\n'],
    ]);
    expect(closure([helper], overrides).has(optionalGerman)).toBe(true);
  });
});
