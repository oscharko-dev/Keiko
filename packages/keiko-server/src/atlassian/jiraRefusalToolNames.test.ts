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
// name written with a further dot segment or an upper-case first letter is a candidate too. The head
// ("jira" and its separator) is one constant that BOTH the checker pattern and the prefilter below are
// built from, so the prefilter cannot drift from what the checker can match.
const HEAD_LETTERS: readonly string[] = ["j", "i", "r", "a"];
const HEAD_SEPARATORS = "._";
const caseless = (letter: string): string => `[${letter.toUpperCase()}${letter}]`;
const CANDIDATE = new RegExp(
  `(?<![\\w./-])${HEAD_LETTERS.map(caseless).join("")}[${HEAD_SEPARATORS}][A-Za-z][\\w.-]*\\w`,
  "gu",
);
// A file is parsed only if its text can hold a candidate. The checker reads the COOKED text of a
// string or template literal, and a cooked character comes from exactly one source character, from one
// escape sequence (`\x6a`, `\u006a`, `\u{6a}`, an identity escape such as `\.`), or from a line
// continuation, which contributes nothing. So every character of "jira" and of its separator is,
// in the source, either itself or an escape sequence, optionally interleaved with line continuations.
// Any file without such a run cannot hold a candidate, whatever the AST makes of it, and is skipped.
const CONTINUATIONS = String.raw`(?:\\(?:\r\n|[\n\r\u2028\u2029]))*`;
const sourceUnit = (alternatives: string): string =>
  String.raw`(?:${alternatives}|\\(?:x[\da-f]{2}|u(?:[\da-f]{4}|\{[\da-f]+\})|[\s\S]))${CONTINUATIONS}`;
const CAN_HOLD_CANDIDATE = new RegExp(
  [
    ...HEAD_LETTERS.map((letter) => sourceUnit(caseless(letter))),
    sourceUnit(`[${HEAD_SEPARATORS}]`),
  ].join(""),
  "iu",
);

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
let scannedFilesMemo: readonly string[] | undefined;
function scannedFiles(): readonly string[] {
  scannedFilesMemo ??= SCANNED_ROOTS.flatMap(({ directory, only }) => filesUnder(directory, only));
  return scannedFilesMemo;
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
let registeredNamesMemo: ReadonlySet<string> | undefined;
function registeredNames(): ReadonlySet<string> {
  registeredNamesMemo ??= computeRegisteredNames();
  return registeredNamesMemo;
}
function computeRegisteredNames(): ReadonlySet<string> {
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

/** The files whose text can hold a candidate are parsed and checked; every other file is skipped. */
function scan(): {
  readonly scanned: number;
  readonly parsed: number;
  readonly spelledLiterally: number;
  readonly tokens: readonly { readonly path: string; readonly token: string }[];
} {
  const files = scannedFiles();
  const sources = files.map((path) => ({ path, source: readFileSync(path, "utf8") }));
  const parsed = sources.filter(({ source }) => CAN_HOLD_CANDIDATE.test(source));
  return {
    scanned: files.length,
    parsed: parsed.length,
    spelledLiterally: sources.filter(({ source }) => /jira[._]/iu.test(source)).length,
    tokens: parsed.flatMap(({ path, source }) =>
      candidatesInLiterals(source).map((token) => ({ path: path.slice(PACKAGES.length), token })),
    ),
  };
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
  it("never skips a file whose text the checker would flag, in any way a literal can be written", () => {
    // Each fixture holds a token the checker flags; the prefilter must let it through. Why no flagged
    // token can sit in a skipped file: see CAN_HOLD_CANDIDATE.
    const writtenAs = [
      '"use jira.nope here"',
      '"use JIRA_NOPE here"',
      '"use jira\\.nope here"',
      '"use jira\\x2enope here"',
      '"use \\x6aira.nope here"',
      '"use j\\u0069ra.nope here"',
      '"use ji\\u{72}a.nope here"',
      '"use \\u006a\\u0069\\u0072\\u0061\\u002enope here"',
      '"use ji\\\nra.nope here"',
      '"use jira\\\r\n.nope here"',
      "`use jira.nope here`",
      "`use ${x} j\\ira.nope here`",
      "`use ${x} jira\\_nope here`",
    ];
    for (const literal of writtenAs) {
      const source = `const t = ${literal};`;
      expect(candidatesInLiterals(source), source).not.toEqual([]);
      expect(CAN_HOLD_CANDIDATE.test(source), source).toBe(true);
    }
  });
  it("skips a file that cannot hold a candidate, and only such a file", () => {
    for (const source of [
      'const a = "no tool here";',
      'const r = /ji.ra\\.x/u; const b = "jir a.b";',
      "const jir = 1; // nothing",
    ]) {
      expect(candidatesInLiterals(source)).toEqual([]);
      expect(CAN_HOLD_CANDIDATE.test(source), source).toBe(false);
    }
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
    const { scanned, parsed, spelledLiterally, tokens } = scan();
    // Non-vacuity, derived from the run: the prefilter must keep every file that spells the head
    // literally, must still skip files, and the tokens it let through must outnumber the registered
    // tools that the descriptors spell out, so a prefilter that skips everything cannot pass.
    expect(parsed).toBeGreaterThanOrEqual(spelledLiterally);
    expect(parsed).toBeLessThan(scanned);
    expect(tokens.length).toBeGreaterThan(jiraOperationContracts().length);
    expect(
      tokens.filter(({ token }) => !known.has(token)).map(({ path, token }) => `${path}: ${token}`),
    ).toEqual([]);
  });
});
