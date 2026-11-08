// Offline implementation accounting; these facts cannot register a tool or authorize a request.
import { existsSync, readFileSync } from "node:fs";
import { URL } from "node:url";
import ts from "typescript";
import { sha256 } from "./digest.mjs";
import { requireJiraInventory as requireValid } from "./jira-api-sources.mjs";

export const JIRA_REGISTRY_SOURCE = "packages/keiko-server/src/atlassian/jiraOperationRegistry.ts";
export const JIRA_REGISTRY_FILE = new URL(`../../${JIRA_REGISTRY_SOURCE}`, import.meta.url);

const BUILDER_FORMS = {
  read: { parameters: 3, returned: ["GET", "read", 0, 1, 2] },
  write: { parameters: 4, returned: [0, "write", 1, 2, 3] },
  issueRead: { parameters: 2, returned: ["GET", "read", 0, "visible-issues", 1] },
};
// These are parsed as syntax only. Keep the reviewed helper semantics closed: no execution,
// identifier substitution, arbitrary callbacks, or imported runtime declarations are accepted.
const GROUP_BUILDERS = `
function reads<const K extends NativeTool>(
  permissionPolicy: JiraPermissionPolicy,
  paths: Readonly<Record<K, string>>,
  root: JiraApiRoot = "/rest/api/2",
): NativeGroup<K> {
  const result: Partial<Record<K, NativeSpecification>> = {};
  for (const tool in paths) {
    if (Object.hasOwn(paths, tool))
      result[tool] = ["GET", "read", paths[tool], permissionPolicy, root];
  }
  return result as NativeGroup<K>;
}
function writes<const K extends NativeTool>(
  permissionPolicy: JiraPermissionPolicy,
  paths: Readonly<Record<K, readonly ["POST" | "PUT" | "DELETE", string]>>,
  root: JiraApiRoot = "/rest/api/2",
): NativeGroup<K> {
  const result: Partial<Record<K, NativeSpecification>> = {};
  for (const tool in paths) {
    if (!Object.hasOwn(paths, tool)) continue;
    const [method, path] = paths[tool];
    result[tool] = [method, "write", path, permissionPolicy, root];
  }
  return result as NativeGroup<K>;
}`;
const GROUP_NAMES = new Set(["reads", "writes"]);

function syntaxShape(node) {
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(syntaxShape(child));
  });
  const text =
    ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
      ? node.text
      : null;
  return [node.kind, text, children];
}
function groupBuilderDeclaration(ast, name) {
  const declarations = ast.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  requireValid(declarations.length === 1, "registry-native-group-owner");
  return declarations[0];
}
function closedGroupReferences(ast, declaration, native) {
  function invalid(node) {
    if (ts.isIdentifier(node) && node.text === declaration.name.text) {
      const parent = node.parent;
      const directCall =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        ts.isSpreadAssignment(parent.parent) &&
        parent.parent.parent === native;
      if (node !== declaration.name && !directCall) return true;
    }
    return ts.forEachChild(node, invalid) === true;
  }
  return !invalid(ast);
}
function closedObjectReferences(ast) {
  function invalid(node) {
    if (ts.isIdentifier(node) && node.text === "Object") {
      const parent = node.parent;
      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) return true;
      if (
        parent.name.text !== "prototype" &&
        !(ts.isCallExpression(parent.parent) && parent.parent.expression === parent)
      )
        return true;
    }
    return ts.forEachChild(node, invalid) === true;
  }
  return !changesBuilder(ast, "Object") && !invalid(ast);
}
function verifyGroupBuilder(ast, name, verified) {
  if (verified.has(name)) return;
  const declaration = groupBuilderDeclaration(ast, name);
  const expected = ts.createSourceFile(
    "closed-builders.ts",
    GROUP_BUILDERS,
    ts.ScriptTarget.Latest,
    true,
  );
  requireValid(
    closedGroupReferences(ast, declaration, nativeDeclaration(ast)) && closedObjectReferences(ast),
    "registry-native-group-owner",
  );
  requireValid(
    JSON.stringify(syntaxShape(declaration)) ===
      JSON.stringify(syntaxShape(groupBuilderDeclaration(expected, name))),
    "registry-native-group-semantics",
  );
  verified.add(name);
}

function nativeDeclaration(ast) {
  const declarations = ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === "NATIVE");
  requireValid(declarations.length === 1, "registry-native-owner");
  requireValid((declarations[0].parent.flags & ts.NodeFlags.Const) !== 0, "registry-native-owner");
  const initializer = declarations[0].initializer;
  requireValid(
    initializer !== undefined && ts.isObjectLiteralExpression(initializer),
    "registry-native-shape",
  );
  return initializer;
}
function hasIdentifier(node, name) {
  if (ts.isIdentifier(node) && node.text === name) return true;
  return ts.forEachChild(node, (child) => hasIdentifier(child, name)) === true;
}
function changesBuilder(ast, name) {
  function changed(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      hasIdentifier(node.left, name)
    )
      return true;
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      hasIdentifier(node.operand, name)
    )
      return true;
    return ts.forEachChild(node, changed) === true;
  }
  return (
    changed(ast) ||
    ast.statements.some(
      (node) =>
        (ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((declaration) =>
            hasIdentifier(declaration.name, name),
          )) ||
        (ts.isImportDeclaration(node) &&
          node.importClause !== undefined &&
          hasIdentifier(node.importClause, name)),
    )
  );
}
function builderParameters(declaration, name) {
  const parameters = declaration.parameters;
  requireValid(
    parameters.length === BUILDER_FORMS[name].parameters,
    "registry-native-builder-parameters",
  );
  for (const [index, parameter] of parameters.entries()) {
    requireValid(
      ts.isIdentifier(parameter.name) &&
        parameter.dotDotDotToken === undefined &&
        parameter.questionToken === undefined &&
        (parameter.modifiers?.length ?? 0) === 0,
      "registry-native-builder-parameters",
    );
    const last = index === parameters.length - 1;
    requireValid(
      last ? nativeRootDefault(parameter.initializer) : parameter.initializer === undefined,
      "registry-native-builder-default",
    );
  }
  const names = parameters.map((parameter) => parameter.name.text);
  requireValid(new Set(names).size === names.length, "registry-native-builder-parameters");
  return names;
}
function nativeRootDefault(initializer) {
  return (
    initializer !== undefined &&
    ts.isStringLiteralLike(initializer) &&
    initializer.text === "/rest/api/2"
  );
}
function builderReturn(declaration, name, parameters) {
  const body = declaration.body;
  requireValid(
    body !== undefined && body.statements.length === 1 && ts.isReturnStatement(body.statements[0]),
    "registry-native-builder-body",
  );
  const returned = body.statements[0].expression;
  requireValid(
    returned !== undefined && ts.isArrayLiteralExpression(returned),
    "registry-native-builder-return",
  );
  const expected = BUILDER_FORMS[name].returned.map((slot) =>
    typeof slot === "number" ? ["identifier", parameters[slot]] : ["literal", slot],
  );
  requireValid(
    returned.elements.length === expected.length &&
      returned.elements.every((element, index) => {
        const [kind, value] = expected[index];
        return (
          (kind === "literal" ? ts.isStringLiteralLike(element) : ts.isIdentifier(element)) &&
          element.text === value
        );
      }),
    "registry-native-builder-return",
  );
}
function verifyBuilder(ast, name, verified) {
  if (verified.has(name)) return;
  const declarations = ast.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  requireValid(
    declarations.length === 1 && !changesBuilder(ast, name),
    "registry-native-builder-owner",
  );
  const declaration = declarations[0];
  requireValid(
    (declaration.modifiers?.length ?? 0) === 0 &&
      declaration.asteriskToken === undefined &&
      (declaration.typeParameters?.length ?? 0) === 0,
    "registry-native-builder-shape",
  );
  builderReturn(declaration, name, builderParameters(declaration, name));
  verified.add(name);
}
function literalTuple(tuple) {
  requireValid(
    (tuple.length === 4 || tuple.length === 5) && tuple.every(ts.isStringLiteralLike),
    "registry-native-tuple",
  );
  return tuple.map((node) => node.text);
}
function nativeTuple(initializer, ast, verified) {
  if (ts.isArrayLiteralExpression(initializer)) return literalTuple(initializer.elements);
  requireValid(
    ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      Object.hasOwn(BUILDER_FORMS, initializer.expression.text) &&
      initializer.typeArguments === undefined,
    "registry-native-builder-call",
  );
  const name = initializer.expression.text;
  verifyBuilder(ast, name, verified);
  const count = BUILDER_FORMS[name].parameters - 1;
  requireValid(
    (initializer.arguments.length === count || initializer.arguments.length === count + 1) &&
      initializer.arguments.every(ts.isStringLiteralLike),
    "registry-native-builder-arguments",
  );
  const args = initializer.arguments.map((node) => node.text);
  if (args.length === count) args.push("/rest/api/2");
  return BUILDER_FORMS[name].returned.map((slot) => (typeof slot === "number" ? args[slot] : slot));
}
function nativeEntry(property, ast, verified) {
  requireValid(
    ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.name),
    "registry-native-property",
  );
  return entryFor(property.name.text, nativeTuple(property.initializer, ast, verified));
}
function nativeEffect(method, root, path) {
  // These documented POST observations/validations have explicit read contracts. No other method/path may
  // acquire a read disposition from its caller or an arbitrary registry tuple.
  if (method === "GET") return "read";
  return root === "/rest/api/2" &&
    method === "POST" &&
    new Set([
      "/search",
      "/worklog/list",
      "/password/policy/createUser",
      "/password/policy/updateUser",
      "/licenseValidator",
    ]).has(path)
    ? "read"
    : "write";
}
function entryFor(tool, tuple) {
  const [method, effect, path, permissionPolicy, root = "/rest/api/2"] = tuple;
  requireValid(
    new Set(["GET", "POST", "PUT", "DELETE"]).has(method) &&
      effect === nativeEffect(method, root, path),
    "registry-native-effect",
  );
  requireValid(/^jira\.[a-z]+(?:-[a-z]+)*$/u.test(tool), "registry-native-tool");
  requireValid(
    new Set(["/rest/api/2", "/rest/agile/1.0", "/rest/auth/1"]).has(root) &&
      path.startsWith("/") &&
      !path.includes("?"),
    "registry-native-path",
  );
  return {
    tool,
    identity: `${method} ${root}${path}`,
    effect,
    permissionPolicy,
  };
}
function groupMember(property, name, policy, root) {
  requireValid(
    ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.name),
    "registry-native-group-property",
  );
  if (name === "reads") {
    requireValid(ts.isStringLiteralLike(property.initializer), "registry-native-group-path");
    return entryFor(property.name.text, ["GET", "read", property.initializer.text, policy, root]);
  }
  const tuple = property.initializer;
  requireValid(
    ts.isArrayLiteralExpression(tuple) &&
      tuple.elements.length === 2 &&
      tuple.elements.every(ts.isStringLiteralLike),
    "registry-native-group-tuple",
  );
  const [method, path] = tuple.elements.map((element) => element.text);
  return entryFor(property.name.text, [method, "write", path, policy, root]);
}
function nativeGroupArguments(call) {
  const [policy, members, root] = call.arguments;
  requireValid(
    (call.arguments.length === 2 || call.arguments.length === 3) &&
      policy !== undefined &&
      ts.isStringLiteralLike(policy) &&
      policy.text.length > 0 &&
      members !== undefined &&
      ts.isObjectLiteralExpression(members) &&
      members.properties.length > 0 &&
      (root === undefined || ts.isStringLiteralLike(root)),
    "registry-native-group-arguments",
  );
  return { policy, members, root };
}
function nativeGroup(property, ast, verified) {
  const call = property.expression;
  requireValid(
    ts.isCallExpression(call) &&
      ts.isIdentifier(call.expression) &&
      GROUP_NAMES.has(call.expression.text) &&
      call.typeArguments === undefined,
    "registry-native-property",
  );
  const name = call.expression.text;
  verifyGroupBuilder(ast, name, verified);
  const { policy, members, root } = nativeGroupArguments(call);
  return members.properties.map((member) =>
    groupMember(member, name, policy.text, root?.text ?? "/rest/api/2"),
  );
}
/** Parse only literals and verified closed builder declarations. Never import/evaluate the runtime. */
export function readJiraNativeRegistry(file = JIRA_REGISTRY_FILE) {
  const bytes = readFileSync(file);
  const ast = ts.createSourceFile(
    JIRA_REGISTRY_SOURCE,
    bytes.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  requireValid(ast.parseDiagnostics.length === 0, "registry-native-syntax");
  const verified = new Set();
  const entries = nativeDeclaration(ast)
    .properties.flatMap((property) =>
      ts.isSpreadAssignment(property)
        ? nativeGroup(property, ast, verified)
        : [nativeEntry(property, ast, verified)],
    )
    .sort((a, b) => a.tool.localeCompare(b.tool, "en"));
  requireValid(
    entries.length > 0 && new Set(entries.map((entry) => entry.tool)).size === entries.length,
    "registry-native-duplicate",
  );
  return { sourceFile: JIRA_REGISTRY_SOURCE, sha256: sha256(bytes), entries };
}
function textList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}
function notesFor(capability) {
  requireValid(
    capability !== undefined && typeof capability === "object" && capability !== null,
    "current-capability-notes",
  );
  requireValid(
    typeof capability.constraints === "string" && capability.constraints.length > 0,
    "current-capability-constraints",
  );
  requireValid(
    textList(capability.sourceFiles) && textList(capability.testFiles),
    "current-capability-references",
  );
  for (const path of [...capability.sourceFiles, ...capability.testFiles])
    requireValid(
      /^(?:packages|scripts|tests)\/[A-Za-z0-9_./-]+$/u.test(path) &&
        !path.split("/").includes("..") &&
        existsSync(new URL(`../../${path}`, import.meta.url)),
      "current-capability-path",
    );
  return {
    constraints: capability.constraints,
    sourceFiles: capability.sourceFiles,
    testFiles: capability.testFiles,
  };
}
function capabilitiesFor(ledger, registry) {
  const notes = ledger.currentCapabilities;
  requireValid(
    notes !== undefined && typeof notes === "object" && !Array.isArray(notes),
    "current-capabilities",
  );
  requireValid(
    JSON.stringify(Object.keys(notes).sort()) ===
      JSON.stringify(registry.entries.map((entry) => entry.tool).sort()),
    "current-capability-completeness",
  );
  return Object.fromEntries(
    registry.entries.map(({ tool, ...entry }) => [
      tool,
      { ...entry, kind: "constrained-tool", ...notesFor(notes[tool]) },
    ]),
  );
}
function capabilityIds(identity, capabilities) {
  return Object.entries(capabilities)
    .filter(([, capability]) => capability.identity === identity)
    .map(([tool]) => tool)
    .sort();
}
/** Update only implementation mappings; source provenance, historical facts and qualification stay intact. */
export function reconcileJiraImplementation(ledger, registry) {
  const currentCapabilities = capabilitiesFor(ledger, registry);
  const identities = new Set(ledger.operations.map((row) => row.identity));
  requireValid(
    registry.entries.every((entry) => identities.has(entry.identity)),
    "registry-operation-not-published",
  );
  const { operations, ...historical } = ledger;
  return {
    ...historical,
    currentRegistry: {
      sourceFile: registry.sourceFile,
      sha256: registry.sha256,
      nativeOperationCount: registry.entries.length,
    },
    currentCapabilities,
    operations: operations.map((row) => {
      const currentCapabilityIds = capabilityIds(row.identity, currentCapabilities);
      return {
        ...row,
        currentCapabilityIds,
        implementationState:
          currentCapabilityIds.length > 0 && row.implementationState === "not-implemented"
            ? "partial"
            : row.implementationState,
      };
    }),
  };
}
export function validateJiraImplementation(ledger, registry) {
  const expected = reconcileJiraImplementation(ledger, registry);
  requireValid(
    JSON.stringify(ledger.currentRegistry) === JSON.stringify(expected.currentRegistry),
    "current-registry-drift",
  );
  requireValid(
    JSON.stringify(ledger.currentCapabilities) === JSON.stringify(expected.currentCapabilities),
    "current-capability-drift",
  );
  for (let index = 0; index < ledger.operations.length; index++) {
    const row = ledger.operations[index];
    const current = expected.operations[index];
    requireValid(
      JSON.stringify(row.currentCapabilityIds) === JSON.stringify(current.currentCapabilityIds),
      "current-operation-mapping",
    );
    requireValid(
      row.implementationState === current.implementationState,
      "current-implementation-state",
    );
  }
}
