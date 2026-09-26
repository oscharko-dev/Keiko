// Every Windows system path in product code must come from the ONE trusted decision in
// keiko-security (`resolveWindowsSystemDirectory` / `resolveWindowsSystemBinary` / the
// `windowsSystemRoot` re-export), never from a raw `process.env.SystemRoot` read.
//
// This is a whole-class pin, and it exists because the class was declared fixed while a
// counter-example shipped: PR #3354 introduced the shared resolver and its commit message said the
// class was closed, but `native-file-dialog/adapter.ts` still did
//
//   const systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`;
//   return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
//
// — no validation at all, on a path that is then SPAWNED. A reviewer had to find it by hand. A raw
// read accepts every substitution the resolver rejects: UNC (`\\attacker\share`), device paths
// (`\\?\C:\Windows`), root-relative (`\Windows`, which resolves against the CURRENT drive),
// bare-relative (the process cwd, i.e. the workspace), `..` traversal, control characters, cmd.exe
// metacharacters and NTFS alternate-data-stream colons.
//
// Reading SystemRoot to FORWARD it as a child-process environment variable is a different thing and
// stays allowed — keiko-git/src/env.ts does exactly that. Only a raw read that feeds a PATH is
// banned, which is why the pattern below looks for the read and the file is then checked for a join.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const PACKAGES_ROOT = join(process.cwd(), "packages");

// The owning module itself, which must read the environment to validate it.
const OWNER = join("keiko-security", "src", "windows-system-directory.ts");

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
    }
  };
  for (const pkg of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (pkg.isDirectory()) walk(join(PACKAGES_ROOT, pkg.name, "src"));
  }
  return out;
}

const RAW_SYSTEM_ROOT_PROPERTIES = new Set(["SystemRoot", "WINDIR", "windir"]);
const EXPANDS_SYSTEM_ROOT_IN_BATCH_PATH = /%(?:SystemRoot|WINDIR)%\\+System32\b/iu;
const HARDCODES_DEFAULT_SYSTEM32_PATH = /\bC:\\+Windows\\+System32\b/iu;
const PATH_MARKER = /System32|[\\/]/u;
const MAY_REFERENCE_WINDOWS_SYSTEM_PATH =
  /SystemRoot|WINDIR|System32|\\(?:x[\dA-Fa-f]{2}|u[\dA-Fa-f]{4}|u\{[\dA-Fa-f]+\})/iu;

function containsRawSystemRootToken(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (RAW_SYSTEM_ROOT_PROPERTIES.has(scanner.getTokenValue())) return true;
  }
  return false;
}

// Comments are stripped first: this very pin's own explanatory comments quote the banned pattern,
// and so does every fixed call site's comment. A scanner that flagged those would be unusable.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function rawSystemRootPropertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!ts.isElementAccessExpression(node)) return undefined;
  const argument = node.argumentExpression;
  return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function isRawSystemRootMember(node) {
  const propertyName = rawSystemRootPropertyName(node);
  return propertyName !== undefined && RAW_SYSTEM_ROOT_PROPERTIES.has(propertyName);
}

function containsRawSystemRoot(node, bindings) {
  let found = false;
  function visit(current) {
    if (isRawSystemRootMember(current)) found = true;
    if (ts.isIdentifier(current) && bindings.has(current.text)) found = true;
    if (!found) ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function recordDestructuredSystemRoot(node, bindings) {
  if (!ts.isObjectBindingPattern(node)) return;
  for (const element of node.elements) {
    const property = element.propertyName ?? element.name;
    const propertyName =
      ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined;
    if (!RAW_SYSTEM_ROOT_PROPERTIES.has(propertyName) || !ts.isIdentifier(element.name)) continue;
    bindings.add(element.name.text);
  }
}

function collectRawSystemRootAssignments(sourceFile, bindings) {
  const assignments = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      recordDestructuredSystemRoot(node.name, bindings);
      if (ts.isIdentifier(node.name) && node.initializer !== undefined) {
        assignments.push([node.name.text, node.initializer]);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      assignments.push([node.left.text, node.right]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return assignments;
}

function collectRawSystemRootBindings(sourceFile) {
  const bindings = new Set();
  const assignments = collectRawSystemRootAssignments(sourceFile, bindings);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, initializer] of assignments) {
      if (bindings.has(name) || !containsRawSystemRoot(initializer, bindings)) continue;
      bindings.add(name);
      changed = true;
    }
  }
  return bindings;
}

function isPathJoinOrResolveCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "join" || callee.text === "resolve";
  return (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === "join" || callee.name.text === "resolve")
  );
}

function isManualPathExpression(node, sourceFile) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return true;
  if (!ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node)) return false;
  return PATH_MARKER.test(node.getText(sourceFile));
}

function sourceJoinsRawSystemRoot(sourceFile) {
  const bindings = collectRawSystemRootBindings(sourceFile);
  let found = false;
  function visit(node) {
    if (
      (isPathJoinOrResolveCall(node) || isManualPathExpression(node, sourceFile)) &&
      containsRawSystemRoot(node, bindings)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function joinsAPathFromRawSystemRoot(text) {
  // Nearly every product file is irrelevant. Reject it before comment stripping or TypeScript AST
  // construction; retain escaped-token candidates because the scanner deliberately decodes forms
  // such as `System\x52oot` that a literal substring check would miss.
  if (!MAY_REFERENCE_WINDOWS_SYSTEM_PATH.test(text)) return false;
  const code = stripComments(text);
  if (EXPANDS_SYSTEM_ROOT_IN_BATCH_PATH.test(code) || HARDCODES_DEFAULT_SYSTEM32_PATH.test(code)) {
    return true;
  }
  if (!containsRawSystemRootToken(text)) return false;
  const sourceFile = ts.createSourceFile("scanner-fixture.ts", text, ts.ScriptTarget.Latest, true);
  return sourceJoinsRawSystemRoot(sourceFile);
}

describe("trusted Windows system-root usage (whole-class pin)", () => {
  it("no product file joins a PATH from a raw SystemRoot/WINDIR read", () => {
    const offenders = [];
    for (const path of sourceFiles()) {
      if (path.endsWith(OWNER)) continue;
      const text = readFileSync(path, "utf8");
      if (joinsAPathFromRawSystemRoot(text)) {
        offenders.push(path.slice(path.indexOf("packages/")));
      }
    }
    expect(offenders).toEqual([]);
  }, 60_000);

  // IDX55 fixtures: prove the widened detection actually fires on the two forms the original
  // dot-only regex missed, rather than trusting the regex change by inspection alone.
  describe("detects a raw SystemRoot/WINDIR read regardless of access form (fixtures)", () => {
    it.each([
      ["dot access", 'const p = join(process.env.SystemRoot ?? "C:\\\\Windows", "System32");'],
      [
        "optional-chained dot access",
        'const p = join(process.env?.SystemRoot ?? "C:\\\\Windows", "System32");',
      ],
      [
        "bracket access with double quotes",
        'const p = join(process.env["SystemRoot"] ?? "C:\\\\Windows", "System32");',
      ],
      [
        "bracket access with single quotes",
        "const p = join(process.env['WINDIR'] ?? String.raw`C:\\\\Windows`, \"System32\");",
      ],
      [
        "optional-chained bracket access",
        'const p = join(process.env?.["SystemRoot"] ?? "C:\\\\Windows", "System32");',
      ],
      [
        "Unicode-escaped bracket access",
        String.raw`const p = join(process.env["System\x52oot"], "System32");`,
      ],
      [
        "Unicode-escaped bracket access without another literal path marker",
        String.raw`const p = join(process.env["System\x52oot"], dynamicSegment);`,
      ],
      [
        "bare env (no process. prefix), bracket access",
        'const p = join(env["windir"] ?? "C:\\\\Windows", "System32");',
      ],
      [
        "processEnv holder with dot access",
        'const p = join(processEnv.SystemRoot ?? "C:\\\\Windows", "System32");',
      ],
      [
        "baseEnv holder with bracket access",
        'const p = join(baseEnv["WINDIR"] ?? "C:\\\\Windows", "System32");',
      ],
      [
        "optional-chained processEnv holder",
        'const p = join(processEnv?.["SystemRoot"] ?? "C:\\\\Windows", "System32");',
      ],
      [
        "environment holder without a naming convention",
        'const p = join(environment["WINDIR"] ?? "C:\\\\Windows", "System32");',
      ],
      [
        "holder whose name only starts with env",
        'const p = join(envValue.SystemRoot ?? "C:\\\\Windows", "System32");',
      ],
      [
        "destructured SystemRoot binding",
        'const { SystemRoot } = process.env; const p = join(SystemRoot, "System32");',
      ],
      [
        "aliased destructured WINDIR binding",
        'const { WINDIR: windowsRoot } = environment; const p = resolve(windowsRoot, "System32");',
      ],
      [
        "manual template-literal System32 path",
        "const root = environment.SystemRoot; const p = `${root}\\\\System32\\\\cmd.exe`;",
      ],
      [
        "manual concatenated System32 path",
        'const p = environment.SystemRoot + "\\\\System32\\\\cmd.exe";',
      ],
      [
        "manual array-joined System32 path",
        'const p = [environment.SystemRoot, "System32", "cmd.exe"].join("\\\\");',
      ],
    ])("flags %s joined onto a path", (_label, snippet) => {
      expect(joinsAPathFromRawSystemRoot(snippet)).toBe(true);
    });

    it.each([
      [
        "a deferred SystemRoot expansion in generated batch content",
        String.raw`const line = '@"%SystemRoot%\System32\cmd.exe"';`,
      ],
      [
        "a deferred WINDIR expansion in generated batch content",
        String.raw`const line = '@"%WINDIR%\System32\cmd.exe"';`,
      ],
      [
        "a hard-coded raw-string default System32 executable",
        String.raw`const command = String.raw\`C:\Windows\System32\cmd.exe\`;`,
      ],
      [
        "a hard-coded escaped default System32 executable",
        'const command = "C:\\\\Windows\\\\System32\\\\cmd.exe";',
      ],
    ])("flags %s without needing an environment read", (_label, snippet) => {
      expect(joinsAPathFromRawSystemRoot(snippet)).toBe(true);
    });

    it.each([
      [
        "dot access forwarded into a child env, never joined",
        "const childEnv = { ...base, SystemRoot: process.env.SystemRoot };",
      ],
      [
        "bracket access forwarded into a child env, never joined",
        'const childEnv = { ...base, SystemRoot: process.env["SystemRoot"] };',
      ],
      [
        "an unrelated env var read with the same access forms",
        'const lang = process.env.LANG; const home = process.env?.["HOME"];',
      ],
      [
        "the shared resolver receiving an arbitrarily named environment object",
        'const p = resolveWindowsSystemExecutable(["System32", "cmd.exe"], environment);',
      ],
    ])("does not flag %s", (_label, snippet) => {
      expect(joinsAPathFromRawSystemRoot(snippet)).toBe(false);
    });
  });
});
