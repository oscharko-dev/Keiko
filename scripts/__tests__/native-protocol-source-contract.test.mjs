import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { it } from "vitest";
import { prepareCSource, stripStringLiteralBodies } from "../../native/lib/c-source-scanner.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const source = readFileSync(
  join(repoRoot, "native/runtime-supervisor/linux/protocol.test.mjs"),
  "utf8",
);
const raw = readFileSync(
  join(repoRoot, "native/runtime-supervisor/linux/keiko_runtime_supervisor.c"),
  "utf8",
);
const code = stripStringLiteralBodies(prepareCSource(raw));

function qualificationStatement() {
  const parsed = ts.createSourceFile(
    "protocol.test.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const matches = parsed.statements.filter((node) => {
    if (!ts.isExpressionStatement(node) || !ts.isAwaitExpression(node.expression)) return false;
    const call = node.expression.expression;
    if (
      !ts.isCallExpression(call) ||
      !ts.isIdentifier(call.expression) ||
      call.expression.text !== "test"
    )
      return false;
    const name = call.arguments[0];
    return (
      name !== undefined &&
      ts.isStringLiteral(name) &&
      name.text === "Linux generation source, protocol and requested kernel boundaries"
    );
  });
  const statement = matches[0];
  if (matches.length !== 1 || statement === undefined)
    throw new Error("Expected one native qualification test");
  return source.slice(statement.getStart(parsed), statement.end);
}

function probe(input) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-native-source-contract-"));
  try {
    const path = join(directory, "probe.mjs");
    writeFileSync(
      path,
      [
        'import { strict as assert } from "node:assert";',
        'import { test } from "node:test";',
        `const code = ${JSON.stringify(input)};`,
        "const qualificationOptions = () => ({});",
        'const qualifyRequested = async () => { process.stdout.write("qualification-marker\\n"); };',
        qualificationStatement(),
      ].join("\n"),
    );
    return spawnSync(process.execPath, [path], { encoding: "utf8", env: {}, timeout: 5000 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [name, input, status, reached] of [
  ["healthy source", code, 0, true],
  ["missing kernel primitive", code.replaceAll("SYS_clone3", "MISSING_CLONE"), 1, false],
  ["forbidden shell execution", `${code}\nsystem();`, 1, false],
]) {
  it(`validates ${name} before entering native qualification`, () => {
    const result = probe(input);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, status);
    assert.equal(result.stdout.includes("qualification-marker"), reached);
  });
}
