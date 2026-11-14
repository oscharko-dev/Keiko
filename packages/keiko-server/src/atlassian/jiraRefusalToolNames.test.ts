import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { JIRA_CATALOG_DISCOVERY_TOOLS } from "./jiraCatalogDiscovery.js";
import { jiraOperationContracts } from "./jiraManagedProvider.js";

// #4357 AC3: a refusal, a description or a guidance text that tells a model to call a tool must name
// a tool that exists. A model that follows `jira.issue_types` for `jira.issue-types` calls nothing
// and cannot correct itself, so every Jira tool name inside a text literal of the Jira modules is
// derived from the registered operations, never trusted by spelling.
const PACKAGES = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED: readonly { readonly directory: string; readonly only: RegExp }[] = [
  { directory: join(PACKAGES, "keiko-connectors", "src"), only: /./u },
  { directory: join(PACKAGES, "keiko-server", "src", "atlassian"), only: /./u },
  { directory: join(PACKAGES, "keiko-contracts", "src"), only: /^(jira|atlassian).*\.ts$/u },
];
// A tool name is `jira.` and a lowercase word ending in a letter or digit; a trailing sentence dot,
// a domain such as `jira.example.invalid` and an activity-log operation such as `jira.operation.core`
// are not names, and a prefix such as `jira.set-` that code completes is not a complete one.
const TOOL_NAME = /(?<![\w./-])jira\.[a-z](?:[\w-]*\w)?(?![\w-]|\.[a-z])/gu;

/**
 * Every Jira tool name inside a prose literal (a string or template literal with a space, as a
 * sentence a model reads has) of one TypeScript source text. A literal that is one bare identifier,
 * such as an error kind `jira.mutation-execution-failed`, is not a sentence.
 */
function toolNamesInLiterals(source: string): readonly string[] {
  const file = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      names.push(...(/\s/u.test(node.text) ? (node.text.match(TOOL_NAME) ?? []) : []));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}
function scannedFiles(): readonly string[] {
  return SCANNED.flatMap(({ directory, only }) =>
    readdirSync(directory)
      .filter((name) => only.test(name) && name.endsWith(".ts"))
      .filter((name) => !/\.(test|generated)\.ts$/u.test(name))
      .map((name) => join(directory, name)),
  );
}
function registeredTools(): ReadonlySet<string> {
  return new Set<string>([
    ...jiraOperationContracts().map((contract) => contract.definition.tool),
    ...JIRA_MANAGED_READ_TOOLS,
    ...JIRA_MUTATION_OPERATIONS,
    ...JIRA_CATALOG_DISCOVERY_TOOLS,
  ]);
}

describe("every Jira tool named in a text is a registered operation (#4357 AC3)", () => {
  it("finds a tool name only in a text literal, and not a domain, an operation id or a sentence dot", () => {
    const source = [
      'const a = "Use jira.issue-types, not jira.issue_types.";',
      "const b = `ask ${x} via jira.myself.`;",
      'const c = "https://jira.example.invalid/rest and jira.operation.core";',
      'const e = "jira.mutation-execution-failed";',
      'const f = "Use the jira.set- prefix words or jira.create-";',
      "// jira.comment in a comment is not a text a model reads",
      "const d = { tool: jira.search };",
    ].join("\n");
    expect(toolNamesInLiterals(source)).toEqual([
      "jira.issue-types",
      "jira.issue_types",
      "jira.myself",
    ]);
  });
  it("scans the modules that carry refusals, descriptions and guidance", () => {
    expect(scannedFiles().length).toBeGreaterThan(300);
    expect(registeredTools().size).toBeGreaterThan(400);
  });
  it("names no tool that is not registered, in any text of the Jira modules", () => {
    const registered = registeredTools();
    const unknown = scannedFiles().flatMap((path) =>
      toolNamesInLiterals(readFileSync(path, "utf8"))
        .filter((name) => !registered.has(name))
        .map((name) => `${path.slice(PACKAGES.length)}: ${name}`),
    );
    expect(unknown).toEqual([]);
  });
});
