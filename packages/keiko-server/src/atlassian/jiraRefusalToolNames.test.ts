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
// a tool that exists. A model that follows `jira.issue_types` for `jira.issue-types` calls nothing and
// cannot correct itself. So every `jira.` / `jira_` token inside a prose literal of the Jira modules
// is decided by one question: is this exact token a registered tool name, the underscore alias of
// one, or a registered Activity Log operation? Never by the shape of the spelling.
const PACKAGES = fileURLToPath(new URL("../../../", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../../../", import.meta.url));
const SCANNED_ROOTS: readonly { readonly directory: string; readonly only: RegExp }[] = [
  { directory: join(PACKAGES, "keiko-connectors", "src"), only: /./u },
  { directory: join(PACKAGES, "keiko-server", "src"), only: /./u },
  { directory: join(PACKAGES, "keiko-contracts", "src"), only: /^(jira|atlassian)/u },
];
// Every spelling: any case of "jira", a dot or an underscore, then the rest of the token, so a wrong
// name written with a further dot segment or an upper-case first letter is a candidate too.
const CANDIDATE = /(?<![\w./-])[Jj][Ii][Rr][Aa][._][A-Za-z][\w.-]*\w/gu;

/** Every candidate token inside a prose literal (a string with a space, as a model reads it). */
function candidatesInLiterals(source: string): readonly string[] {
  const file = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      found.push(...(/\s/u.test(node.text) ? (node.text.match(CANDIDATE) ?? []) : []));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
function filesUnder(directory: string, only: RegExp): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : filesUnder(path, only);
    const named = only.test(entry.name) && entry.name.endsWith(".ts");
    return named && !/\.(test|generated)\.ts$/u.test(entry.name) ? [path] : [];
  });
}
function scannedFiles(): readonly string[] {
  return SCANNED_ROOTS.flatMap(({ directory, only }) => filesUnder(directory, only));
}
// Tokens that look like a tool name and are not one, each exact and each for a stated reason: Jira's own
// application-property keys (the instance-setting tools read and write them) and a SQL column. An
// exact token is allowed, never a shape, so a wrong tool name cannot hide behind them.
const NOT_TOOL_TOKENS: ReadonlySet<string> = new Set([
  "jira.clone.prefix",
  "jira.option.timetracking",
  "jira.option.voting",
  "jira.option.watching",
  "jira.user.locale",
  "jira.user.timezone",
  "jira_state_json",
]);
function registeredNames(): ReadonlySet<string> {
  const tools = new Set<string>([
    ...jiraOperationContracts().map((contract) => contract.definition.tool),
    ...JIRA_MANAGED_READ_TOOLS,
    ...JIRA_MUTATION_OPERATIONS,
    ...JIRA_CATALOG_DISCOVERY_TOOLS,
  ]);
  const operations = JSON.parse(
    readFileSync(join(REPOSITORY, "docs", "observability", "op-catalog.generated.json"), "utf8"),
  ) as { readonly operations: readonly string[] };
  return new Set([
    ...tools,
    ...[...tools].map((name) => name.replace(/[.-]/gu, "_")),
    ...operations.operations,
    ...NOT_TOOL_TOKENS,
  ]);
}

describe("every Jira tool named in a text is a registered operation (#4357 AC3)", () => {
  const registered = new Set(["jira.issue-types", "jira.myself", "jira_myself"]);
  const unknownIn = (source: string): readonly string[] =>
    candidatesInLiterals(source).filter((token) => !registered.has(token));
  it("judges a token by whether it is registered, in any spelling and only inside a prose literal", () => {
    const source = [
      'const a = "Use jira.issue-types, not jira.issue_types.";',
      "const b = `ask ${x} via jira.myself and Jira.myself.`;",
      'const c = "see jira.issue-types.list or jira_myself for it";',
      'const d = "https://jira.example.invalid/rest and jira.operation.core";',
      'const e = "jira.mutation-execution-failed";',
      "// jira.comment in a comment is not a text a model reads",
    ].join("\n");
    expect(unknownIn(source)).toEqual([
      "jira.issue_types",
      "Jira.myself",
      "jira.issue-types.list",
      "jira.operation.core",
    ]);
  });
  it("scans every module that carries refusals, descriptions and guidance, recursively", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(900);
    expect(files.some((path) => path.endsWith("chat-tool-receipts.ts"))).toBe(true);
    expect(files.some((path) => path.endsWith("codingJiraPodBinding.ts"))).toBe(true);
    expect(files.some((path) => path.includes("jira-test-request"))).toBe(true);
    expect(registeredNames().size).toBeGreaterThan(900);
  });
  it("names no tool that is not registered, in any text of the Jira modules", () => {
    const known = registeredNames();
    const unknown = scannedFiles().flatMap((path) =>
      candidatesInLiterals(readFileSync(path, "utf8"))
        .filter((token) => !known.has(token))
        .map((token) => `${path.slice(PACKAGES.length)}: ${token}`),
    );
    expect(unknown).toEqual([]);
  });
});
