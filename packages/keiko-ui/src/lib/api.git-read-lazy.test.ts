import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";

const imports = vi.hoisted(() => [] as string[]);
vi.mock("@oscharko-dev/keiko-contracts/runtime/git-repository-summary", async (original) => {
  imports.push("summary");
  return original();
});

vi.mock("./coding-workbench-lazy-fetchers", async (original) => {
  imports.push("fetchers");
  return original();
});

afterEach(() => vi.unstubAllGlobals());

it("loads Git read validators only when a Git read is requested", async () => {
  vi.resetModules();
  const api = await import("./api");
  expect(imports).toEqual([]);
  const fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
  vi.stubGlobal("fetch", fetch);
  for (const read of [
    (): Promise<unknown> => api.fetchGitStatus("/repo"),
    (): Promise<unknown> => api.fetchGitSummary("/repo"),
    (): Promise<unknown> => api.fetchGitRemotes("/repo"),
    (): Promise<unknown> => api.fetchGitDiff({ root: "/repo", path: "index.ts" }),
  ]) {
    await expect(read()).rejects.toBeDefined();
    expect(new Set(imports)).toEqual(new Set(["fetchers", "summary"]));
  }
  expect(fetch).toHaveBeenCalledTimes(4);
});

function hasRuntimeBinding(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  return (
    bindings === undefined ||
    !ts.isNamedImports(bindings) ||
    bindings.elements.some((element) => !element.isTypeOnly)
  );
}

it("keeps ordinary Git validator imports out of the eager API module", () => {
  const source = ts.createSourceFile(
    "api.ts",
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "api.ts"), "utf8"),
    ts.ScriptTarget.Latest,
  );
  const eagerGitImports = source.statements.filter((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      return false;
    if (!/\/git-repository(?:-summary)?$/u.test(statement.moduleSpecifier.text)) return false;
    return hasRuntimeBinding(statement.importClause);
  });
  expect(eagerGitImports.map((statement) => statement.getText(source))).toEqual([]);
});
