import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { canonicalDeclaration } from "./code-quality-provenance.mjs";
import { compareStrings } from "./compare-strings.mjs";

const NODE_ENCODING_BRIDGE =
  'export {}; import * as util from "node:util"; declare global { interface TextDecoder extends util.TextDecoder {} var TextDecoder: typeof globalThis extends { onmessage: any; TextDecoder: infer T } ? T : typeof util.TextDecoder; interface TextEncoder extends util.TextEncoder {} var TextEncoder: typeof globalThis extends { onmessage: any; TextEncoder: infer T } ? T : typeof util.TextEncoder; }';

function encodingBridgeTokens(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const values = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
    values.push([kind, scanner.getTokenText()]);
  return JSON.stringify(values);
}

function symbol(state, node) {
  return state.referenceFacts.valueSymbol(state.context, node);
}

function sameParameter(state, node, index) {
  const parameter = state.callable.parameters[index];
  return (
    Boolean(parameter) &&
    ts.isIdentifier(parameter.name) &&
    ts.isIdentifier(node) &&
    symbol(state, node) === symbol(state, parameter.name)
  );
}

function valueReferences(state, target) {
  return state.nodes.filter(
    (node) =>
      ts.isIdentifier(node) &&
      symbol(state, node) === target &&
      !state.referenceFacts.declaration(node) &&
      !ts.isTypeQueryNode(node.parent),
  );
}

function privateFunction(node, source) {
  return (
    ts.isFunctionDeclaration(node) &&
    node.parent === source &&
    Boolean(node.body) &&
    !node.asteriskToken &&
    !node.typeParameters?.length &&
    !node.modifiers?.length
  );
}

function objectParameter(node, index) {
  const parameter = node.parameters[index];
  return (
    parameter &&
    ts.isIdentifier(parameter.name) &&
    parameter.type?.kind === ts.SyntaxKind.ObjectKeyword &&
    !parameter.initializer &&
    !parameter.questionToken &&
    !parameter.dotDotDotToken
  );
}

function builtinSignature(state, call) {
  const declaration = state.context.checker.getResolvedSignature(call)?.declaration;
  return Boolean(
    declaration && state.context.program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
  );
}

function builtinMember(state, node, name, strict) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === name &&
    strict(state.context, symbol(state, node.name))
  );
}

function bridgePackage(state, directory, resolved) {
  const root = state.compiler.state.subject.root;
  const read = (path) => state.compiler.read(relative(root, path).replaceAll("\\", "/"));
  const installed = JSON.parse(read(join(directory, "package.json")));
  const lock = JSON.parse(state.compiler.read("package-lock.json"));
  const key = relative(root, directory).replaceAll("\\", "/");
  return (
    installed.name === "@types/node" &&
    installed.version === resolved.packageId.version &&
    lock.packages[key]?.version === installed.version &&
    Boolean(lock.packages[key]?.integrity)
  );
}

function bridgeModule(state, bridge, directory) {
  const imported = bridge.statements.find(ts.isImportDeclaration);
  const namespace = imported.importClause?.namedBindings;
  if (!namespace || !ts.isNamespaceImport(namespace)) return false;
  const module = state.context.checker.getAliasedSymbol(symbol(state, namespace.name));
  if (
    module !==
    state.context.checker.getAmbientModules().find((entry) => entry.name === '"node:util"')
  )
    return false;
  const utilPath = join(directory, "util.d.ts");
  state.compiler.read(relative(state.compiler.state.subject.root, utilPath).replaceAll("\\", "/"));
  return (
    module.declarations?.every((entry) => entry.getSourceFile().fileName === utilPath) === true
  );
}

function nodeBridge(state, declaration) {
  const resolved = ts.resolveTypeReferenceDirective(
    "node",
    state.source.fileName,
    state.context.config.options,
    ts.sys,
  ).resolvedTypeReferenceDirective;
  if (resolved?.packageId?.name !== "@types/node") return false;
  const directory = dirname(resolved.resolvedFileName);
  const bridge = declaration.getSourceFile();
  if (bridge.fileName !== join(directory, "web-globals/encoding.d.ts")) return false;
  if (!bridgePackage(state, directory, resolved)) return false;
  const text = state.compiler.read(
    relative(state.compiler.state.subject.root, bridge.fileName).replaceAll("\\", "/"),
  );
  return (
    encodingBridgeTokens(text) === encodingBridgeTokens(NODE_ENCODING_BRIDGE) &&
    bridgeModule(state, bridge, directory)
  );
}

function domSignature(state, node) {
  const declaration = state.context.checker.getResolvedSignature(node)?.declaration;
  const expected = join(
    dirname(ts.getDefaultLibFilePath(state.context.config.options)),
    "lib.dom.d.ts",
  );
  return (
    declaration?.getSourceFile().fileName === expected &&
    state.context.program.isSourceFileDefaultLibrary(declaration.getSourceFile())
  );
}

function encoderConstruction(node) {
  return (
    ts.isNewExpression(node) &&
    !node.arguments?.length &&
    !node.typeArguments?.length &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "TextEncoder"
  );
}

function builtinEncoder(state, node) {
  if (!encoderConstruction(node)) return false;
  const target = symbol(state, node.expression);
  if (!target?.valueDeclaration) return false;
  const source = target.valueDeclaration.getSourceFile();
  const dom = join(dirname(ts.getDefaultLibFilePath(state.context.config.options)), "lib.dom.d.ts");
  return (
    state.context.program.isSourceFileDefaultLibrary(source) &&
    domSignature(state, node) &&
    source.fileName === dom &&
    target.declarations.every(
      (entry) =>
        state.context.program.isSourceFileDefaultLibrary(entry.getSourceFile()) ||
        nodeBridge(state, entry),
    )
  );
}

function jsonStringify(state, node, strict) {
  return (
    ts.isCallExpression(node) &&
    !node.typeArguments?.length &&
    node.arguments.length === 1 &&
    sameParameter(state, node.arguments[0], 0) &&
    builtinMember(state, node.expression, "stringify", strict) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "JSON" &&
    strict(state.context, symbol(state, node.expression.expression)) &&
    builtinSignature(state, node)
  );
}

function numericExpression(state, node, strict) {
  if (!builtinMember(state, node, "length", strict)) return false;
  const call = node.expression;
  return (
    ts.isCallExpression(call) &&
    call.arguments.length === 1 &&
    !call.typeArguments?.length &&
    builtinMember(state, call.expression, "encode", strict) &&
    domSignature(state, call) &&
    builtinEncoder(state, call.expression.expression) &&
    jsonStringify(state, call.arguments[0], strict)
  );
}

function numericLeafShape(state) {
  const node = state.callable;
  return (
    privateFunction(node, state.source) &&
    node.parameters.length === 1 &&
    objectParameter(node, 0) &&
    node.type?.kind === ts.SyntaxKind.NumberKeyword &&
    node.body.statements.length === 1
  );
}

function closedAttempt(attempt) {
  return (
    ts.isTryStatement(attempt) &&
    !attempt.finallyBlock &&
    Boolean(attempt.catchClause) &&
    !attempt.catchClause.variableDeclaration &&
    attempt.tryBlock.statements.length === 1 &&
    attempt.catchClause.block.statements.length === 1
  );
}

function returnsExpression(node) {
  return ts.isReturnStatement(node) && Boolean(node.expression);
}

function positiveInfinity(state, node, strict) {
  return (
    builtinMember(state, node, "POSITIVE_INFINITY", strict) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Number" &&
    strict(state.context, symbol(state, node.expression))
  );
}

function numericLeaf(state, strict) {
  if (!numericLeafShape(state)) return false;
  const attempt = state.callable.body.statements[0];
  if (!closedAttempt(attempt)) return false;
  const result = attempt.tryBlock.statements[0],
    fallback = attempt.catchClause.block.statements[0];
  return (
    returnsExpression(result) &&
    returnsExpression(fallback) &&
    numericExpression(state, result.expression, strict) &&
    positiveInfinity(state, fallback.expression, strict) &&
    valueReferences(state, symbol(state, state.callable.parameters[0].name)).length === 1
  );
}

function directCalls(state) {
  const references = valueReferences(state, symbol(state, state.callable.name));
  if (
    references.some((node) => !ts.isCallExpression(node.parent) || node.parent.expression !== node)
  )
    return null;
  return references.map((node) => node.parent);
}

function stateFor(graph, callable, index) {
  const state = [...graph.states.values()].find(
    (entry) =>
      entry.callable === callable && entry.index === index && graph.qualified.has(entry.key),
  );
  return state ? { ...state, referenceFacts: graph.referenceFacts } : null;
}

function enclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isFunctionLike(parent)) return parent;
  return null;
}

function rootOrigins(key, graph, cache = new Map()) {
  if (graph.roots.has(key)) return new Map(graph.roots.get(key).map((id) => [id, []]));
  if (cache.has(key)) return cache.get(key);
  const result = new Map();
  for (const edge of graph.states.get(key).incoming) {
    for (const [id, parent] of rootOrigins(edge.state, graph, cache)) {
      const path = parent === null ? null : [...parent, ...edge.origin];
      result.set(
        id,
        result.has(id) && JSON.stringify(result.get(id)) !== JSON.stringify(path) ? null : path,
      );
    }
  }
  cache.set(key, result);
  return result;
}

function closedOrigins(state, graph, expected) {
  const origins = rootOrigins(state.key, graph);
  return origins.size > 0 &&
    [...origins.values()].every((path) => JSON.stringify(path) === JSON.stringify(expected))
    ? [...origins.keys()].sort(compareStrings)
    : null;
}

function errorsParameter(state, index) {
  const type = state.callable.parameters[index]?.type;
  return type && ts.isArrayTypeNode(type) && type.elementType.kind === ts.SyntaxKind.StringKeyword;
}

function errorPush(state, node, index, message, strict) {
  return (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.arguments.length === 1 &&
    ts.isStringLiteral(node.expression.arguments[0]) &&
    node.expression.arguments[0].text === message &&
    builtinMember(state, node.expression.expression, "push", strict) &&
    sameParameter(state, node.expression.expression.expression, index)
  );
}

function zeroErrors(state, node, index, strict) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isNumericLiteral(node.right) &&
    node.right.text === "0" &&
    builtinMember(state, node.left, "length", strict) &&
    sameParameter(state, node.left.expression, index)
  );
}

function exportedConstant(state, declaration) {
  return (
    Boolean(declaration) &&
    ts.isVariableDeclaration(declaration) &&
    declaration.getSourceFile() === state.source &&
    Boolean(declaration.parent.flags & ts.NodeFlags.Const) &&
    declaration.parent.parent.parent === state.source &&
    declaration.parent.parent.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

function byteCapValue(value) {
  return (
    Boolean(value) &&
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
    ts.isNumericLiteral(value.left) &&
    value.left.text === "64" &&
    ts.isNumericLiteral(value.right) &&
    value.right.text === "1024"
  );
}

function ownedCap(state, node) {
  if (!ts.isIdentifier(node)) return null;
  const declaration = symbol(state, node)?.valueDeclaration;
  return exportedConstant(state, declaration) && byteCapValue(declaration.initializer)
    ? declaration
    : null;
}

function byteComparison(comparison, call) {
  return (
    ts.isBinaryExpression(comparison) &&
    comparison.left === call &&
    comparison.operatorToken.kind === ts.SyntaxKind.GreaterThanToken
  );
}

function gatedBudget(state, condition, comparison, index, strict) {
  return (
    ts.isBinaryExpression(condition) &&
    condition.right === comparison &&
    condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    zeroErrors(state, condition.left, index, strict)
  );
}

function budgetUse(state, call, index, message, strict) {
  const comparison = call.parent,
    condition = comparison.parent,
    branch = condition.parent;
  if (
    !byteComparison(comparison, call) ||
    !gatedBudget(state, condition, comparison, index, strict)
  )
    return null;
  if (
    !ts.isIfStatement(branch) ||
    branch.expression !== condition ||
    branch.elseStatement ||
    !errorPush(state, branch.thenStatement, index, message, strict)
  )
    return null;
  const statements = state.callable.body.statements;
  return statements.at(-2) === branch && ts.isReturnStatement(statements.at(-1))
    ? ownedCap(state, comparison.right)
    : null;
}

function variable(statement, flags) {
  if (
    !ts.isVariableStatement(statement) ||
    statement.declarationList.flags !== flags ||
    statement.declarationList.declarations.length !== 1
  )
    return null;
  const node = statement.declarationList.declarations[0];
  return ts.isIdentifier(node.name) && node.initializer ? node : null;
}

function identifierIs(state, node, declaration) {
  return ts.isIdentifier(node) && symbol(state, node) === symbol(state, declaration.name);
}

function falseReturn(node) {
  return ts.isReturnStatement(node) && node.expression?.kind === ts.SyntaxKind.FalseKeyword;
}

function arrayAdmissionBranch(first) {
  return (
    ts.isIfStatement(first) &&
    !first.elseStatement &&
    ts.isBlock(first.thenStatement) &&
    first.thenStatement.statements.length === 2
  );
}

function arrayConditionLeft(state, condition, errors, strict) {
  if (
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.BarBarToken
  )
    return null;
  const left = condition.left;
  if (errors !== 1) return left;
  return ts.isBinaryExpression(left) &&
    left.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
    minimumArray(state, left.right, strict)
    ? left.left
    : null;
}

function negatedArrayCheck(state, node, strict) {
  if (
    !node ||
    !ts.isPrefixUnaryExpression(node) ||
    node.operator !== ts.SyntaxKind.ExclamationToken ||
    !ts.isCallExpression(node.operand)
  )
    return false;
  const call = node.operand;
  return (
    call.arguments.length === 1 &&
    sameParameter(state, call.arguments[0], 0) &&
    builtinMember(state, call.expression, "isArray", strict) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "Array" &&
    strict(state.context, symbol(state, call.expression.expression))
  );
}

function maximumArray(state, node, maximum, strict) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
    builtinMember(state, node.left, "length", strict) &&
    sameParameter(state, node.left.expression, 0) &&
    numericConstant(state, node.right, maximum)
  );
}

function arrayAdmission(state, errors, maximum, message, strict) {
  const first = state.callable.body.statements[0];
  if (!arrayAdmissionBranch(first)) return false;
  const left = arrayConditionLeft(state, first.expression, errors, strict);
  return (
    negatedArrayCheck(state, left, strict) &&
    maximumArray(state, first.expression.right, maximum, strict) &&
    errorPush(state, first.thenStatement.statements[0], errors, message, strict) &&
    falseReturn(first.thenStatement.statements[1])
  );
}

function minimumArray(state, node, strict) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
    builtinMember(state, node.left, "length", strict) &&
    sameParameter(state, node.left.expression, 0) &&
    ts.isNumericLiteral(node.right) &&
    node.right.text === "1"
  );
}

function numericConstant(state, node, value) {
  if (!ts.isIdentifier(node)) return false;
  const declaration = symbol(state, node)?.valueDeclaration;
  return (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.getSourceFile() === state.source &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    declaration.initializer &&
    ts.isNumericLiteral(declaration.initializer) &&
    declaration.initializer.text === String(value)
  );
}

function predicateCallShape(call, argument) {
  return (
    ts.isCallExpression(call) &&
    !call.typeArguments?.length &&
    call.arguments.length >= 1 &&
    call.arguments[0] === argument &&
    ts.isIdentifier(call.expression)
  );
}

function predicateCall(state, call, argument) {
  if (!predicateCallShape(call, argument)) return false;
  const declaration = symbol(state, call.expression)?.valueDeclaration;
  if (!declaration || !privateFunction(declaration, state.source)) return false;
  const signature = state.context.checker.getSignatureFromDeclaration(declaration);
  const predicate = signature && state.context.checker.getTypePredicateOfSignature(signature);
  return predicate?.kind === ts.TypePredicateKind.Identifier && predicate.parameterIndex === 0;
}

// The independently validated questions parameter is narrowed to any[] by Array.isArray.
// Prove only its owned predicate call/order; never grant that callee a raw-helper state.

function forwardingAdmission(state, strict) {
  const statements = state.callable.body.statements;
  const admitted = variable(statements[1], ts.NodeFlags.Const);
  if (
    !admitted ||
    !ts.isCallExpression(admitted.initializer) ||
    admitted.initializer.arguments.length !== 2 ||
    !sameParameter(state, admitted.initializer.arguments[0], 0) ||
    !sameParameter(state, admitted.initializer.arguments[1], 2) ||
    !predicateCall(state, admitted.initializer, admitted.initializer.arguments[0])
  )
    return false;
  return (
    arrayAdmission(state, 2, 256, "questions must be a bounded array", strict) &&
    ts.isReturnStatement(statements[3]) &&
    identifierIs(state, statements[3].expression, admitted) &&
    valueReferences(state, symbol(state, admitted.name)).length === 1
  );
}

function stringIndex(state, node, variableNode, strict) {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    identifierIs(state, node.arguments[0], variableNode) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "String" &&
    strict(state.context, symbol(state, node.expression))
  );
}

function answerTemplate(state, template, variableNode, tail, strict) {
  if (
    !ts.isTemplateExpression(template) ||
    template.head.text !== "answers[" ||
    template.templateSpans.length !== 1
  )
    return false;
  const span = template.templateSpans[0];
  return span.literal.text === tail && stringIndex(state, span.expression, variableNode, strict);
}

function templatePush(state, node, index, variableNode, tail, strict) {
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
  const call = node.expression;
  return (
    call.arguments.length === 1 &&
    builtinMember(state, call.expression, "push", strict) &&
    sameParameter(state, call.expression.expression, index) &&
    answerTemplate(state, call.arguments[0], variableNode, tail, strict)
  );
}

function setNotAdmitted(state, statement, admitted) {
  if (!ts.isExpressionStatement(statement)) return false;
  const set = statement.expression;
  return (
    ts.isBinaryExpression(set) &&
    set.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    identifierIs(state, set.left, admitted) &&
    set.right.kind === ts.SyntaxKind.FalseKeyword
  );
}

function absentAnswer(state, absent, index) {
  if (
    !ts.isIfStatement(absent) ||
    absent.elseStatement ||
    !falseReturn(absent.thenStatement) ||
    !ts.isPrefixUnaryExpression(absent.expression) ||
    absent.expression.operator !== ts.SyntaxKind.ExclamationToken
  )
    return false;
  let condition = absent.expression.operand;
  if (ts.isParenthesizedExpression(condition)) condition = condition.expression;
  return (
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    identifierIs(state, condition.left, index) &&
    sameParameter(state, condition.right, 0)
  );
}

function answerFailure(state, branch, index, admitted, strict) {
  if (!ts.isBlock(branch) || branch.statements.length !== 3) return false;
  const [push, assignment, absent] = branch.statements;
  return (
    templatePush(state, push, 1, index, "] must contain bounded strings", strict) &&
    setNotAdmitted(state, assignment, admitted) &&
    absentAnswer(state, absent, index)
  );
}

function duplicateCondition(state, condition, answer, strict) {
  return (
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    builtinMember(state, condition.left, "size", strict) &&
    builtinMember(state, condition.right, "length", strict) &&
    identifierIs(state, condition.right.expression, answer)
  );
}

function answerSet(state, create, answer, strict) {
  return (
    ts.isNewExpression(create) &&
    create.arguments?.length === 1 &&
    identifierIs(state, create.arguments[0], answer) &&
    ts.isIdentifier(create.expression) &&
    create.expression.text === "Set" &&
    strict(state.context, symbol(state, create.expression)) &&
    builtinSignature(state, create)
  );
}

function answerDuplicate(state, branch, answer, index, strict) {
  if (
    !branch ||
    !ts.isIfStatement(branch) ||
    branch.elseStatement ||
    !ts.isBlock(branch.thenStatement) ||
    branch.thenStatement.statements.length !== 1
  )
    return false;
  if (
    !templatePush(
      state,
      branch.thenStatement.statements[0],
      1,
      index,
      "] must not contain duplicate selections",
      strict,
    )
  )
    return false;
  return (
    duplicateCondition(state, branch.expression, answer, strict) &&
    answerSet(state, branch.expression.left.expression, answer, strict)
  );
}

function loopIndex(loop) {
  if (
    !loop.initializer ||
    !ts.isVariableDeclarationList(loop.initializer) ||
    loop.initializer.flags !== ts.NodeFlags.Let ||
    loop.initializer.declarations.length !== 1
  )
    return null;
  const index = loop.initializer.declarations[0];
  return ts.isIdentifier(index.name) &&
    index.initializer &&
    ts.isNumericLiteral(index.initializer) &&
    index.initializer.text === "0"
    ? index
    : null;
}

function loopCondition(state, condition, index, count) {
  return (
    condition &&
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
    identifierIs(state, condition.left, index) &&
    identifierIs(state, condition.right, count)
  );
}

function loopIncrement(state, increment, index) {
  return (
    increment &&
    ts.isBinaryExpression(increment) &&
    increment.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
    identifierIs(state, increment.left, index) &&
    ts.isNumericLiteral(increment.right) &&
    increment.right.text === "1"
  );
}

function loopAnswer(state, statement, index) {
  const answer = variable(statement, ts.NodeFlags.Const);
  return answer &&
    answer.type?.kind === ts.SyntaxKind.UnknownKeyword &&
    ts.isElementAccessExpression(answer.initializer) &&
    sameParameter(state, answer.initializer.expression, 0) &&
    identifierIs(state, answer.initializer.argumentExpression, index)
    ? answer
    : null;
}

function answerCheck(state, check, answer, index, admitted, strict) {
  if (
    !ts.isIfStatement(check) ||
    !ts.isPrefixUnaryExpression(check.expression) ||
    check.expression.operator !== ts.SyntaxKind.ExclamationToken
  )
    return false;
  const call = check.expression.operand;
  return (
    ts.isCallExpression(call) &&
    call.arguments.length === 1 &&
    identifierIs(state, call.arguments[0], answer) &&
    predicateCall(state, call, call.arguments[0]) &&
    answerFailure(state, check.thenStatement, index, admitted, strict) &&
    answerDuplicate(state, check.elseStatement, answer, index, strict)
  );
}

function answerLoop(state, loop, count, admitted, strict) {
  const index = loopIndex(loop);
  if (
    !index ||
    !loopCondition(state, loop.condition, index, count) ||
    !loopIncrement(state, loop.incrementor, index)
  )
    return false;
  if (!ts.isBlock(loop.statement) || loop.statement.statements.length !== 2) return false;
  const answer = loopAnswer(state, loop.statement.statements[0], index);
  return (
    Boolean(answer) &&
    answerCheck(state, loop.statement.statements[1], answer, index, admitted, strict)
  );
}

function answerAdmission(state, strict) {
  const statements = state.callable.body.statements,
    count = variable(statements[1], ts.NodeFlags.Const),
    admitted = variable(statements[2], ts.NodeFlags.Let);
  if (
    !count ||
    !builtinMember(state, count.initializer, "length", strict) ||
    !sameParameter(state, count.initializer.expression, 0) ||
    admitted?.initializer.kind !== ts.SyntaxKind.TrueKeyword
  )
    return false;
  return (
    arrayAdmission(state, 1, 32, "answers must be a bounded non-empty array", strict) &&
    answerLoop(state, statements[3], count, admitted, strict) &&
    ts.isReturnStatement(statements[5]) &&
    identifierIs(state, statements[5].expression, admitted)
  );
}

function forwarderShape(state, call) {
  return (
    privateFunction(state.callable, state.source) &&
    state.callable.parameters.length === 3 &&
    objectParameter(state.callable, 1) &&
    errorsParameter(state, 2) &&
    sameParameter(state, call.arguments[0], 1)
  );
}

function forwarder(state, call, graph, strict) {
  if (!forwarderShape(state, call)) return null;
  const references = valueReferences(state, symbol(state, state.callable.parameters[1].name));
  if (references.length !== 1 || references[0] !== call.arguments[0]) return null;
  const first = stateFor(graph, state.callable, 0),
    origins = closedOrigins(state, graph, []);
  if (
    !first ||
    origins?.length !== 2 ||
    state.callable.body.statements.length !== 4 ||
    !forwardingAdmission(state, strict)
  )
    return null;
  const cap = budgetUse(
    state,
    call,
    2,
    "questions response exceeds the aggregate UTF-8 byte budget",
    strict,
  );
  return cap ? { state, ids: origins, cap } : null;
}

function forwardedCalls(facts, graph) {
  const calls = directCalls(facts.state);
  if (
    calls?.length !== 2 ||
    facts.state.incoming.length !== 2 ||
    !calls.every((call) => facts.state.incoming.some((edge) => edge.call === call))
  )
    return false;
  return calls.every((call) => {
    const caller = stateFor(graph, enclosingFunction(call), 0);
    return (
      caller &&
      call.arguments.length === 3 &&
      sameParameter(caller, call.arguments[1], 0) &&
      ts.isPropertyAccessExpression(call.arguments[0]) &&
      call.arguments[0].name.text === "questions" &&
      sameParameter(caller, call.arguments[0].expression, 0) &&
      sameParameter(caller, call.arguments[2], 1) &&
      closedOrigins(caller, graph, [])?.length === 1
    );
  });
}

function answersProperty(state, envelope) {
  if (!ts.isObjectLiteralExpression(envelope) || envelope.properties.length !== 1) return false;
  const property = envelope.properties[0];
  return (
    ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.name) &&
    property.name.text === "answers" &&
    sameParameter(state, property.initializer, 0)
  );
}

function answersShape(state) {
  const statements = state.callable.body.statements;
  return (
    statements.length === 6 &&
    ts.isIfStatement(statements[0]) &&
    ts.isVariableStatement(statements[1]) &&
    ts.isVariableStatement(statements[2]) &&
    ts.isForStatement(statements[3])
  );
}

function answersEnvelope(state, call, graph, strict) {
  if (
    !answersProperty(state, call.arguments[0]) ||
    !privateFunction(state.callable, state.source) ||
    state.callable.parameters.length !== 2 ||
    !errorsParameter(state, 1)
  )
    return null;
  const ids = closedOrigins(state, graph, ["answers"]);
  if (ids?.length !== 1 || !answersShape(state) || !answerAdmission(state, strict)) return null;
  const cap = budgetUse(state, call, 1, "answers exceed the aggregate UTF-8 byte budget", strict);
  return cap ? { state, ids, cap } : null;
}

function componentCalls(calls) {
  if (
    calls?.length !== 2 ||
    calls.some((call) => call.arguments.length !== 1 || call.typeArguments?.length)
  )
    return null;
  const forward = calls.find((call) => ts.isIdentifier(call.arguments[0]));
  const answer = calls.find((call) => ts.isObjectLiteralExpression(call.arguments[0]));
  return forward && answer ? { forward, answer } : null;
}

function componentCap(leaf, forwarded, answer, calls) {
  if (forwarded.cap !== answer.cap) return false;
  const references = valueReferences(leaf, symbol(leaf, forwarded.cap.name));
  return (
    references.length === 2 &&
    references.every(
      (node) => node === calls.forward.parent.right || node === calls.answer.parent.right,
    )
  );
}

function componentFor(leaf, calls, graph, strict) {
  const pair = componentCalls(calls);
  if (!pair) return null;
  const forwardedState = stateFor(graph, enclosingFunction(pair.forward), 1),
    answerState = stateFor(graph, enclosingFunction(pair.answer), 0);
  if (!forwardedState || !answerState) return null;
  const forwarded = forwarder(forwardedState, pair.forward, graph, strict),
    answer = answersEnvelope(answerState, pair.answer, graph, strict);
  if (
    !forwarded ||
    !answer ||
    !componentCap(leaf, forwarded, answer, pair) ||
    !forwardedCalls(forwarded, graph)
  )
    return null;
  const ids = [...new Set([...forwarded.ids, ...answer.ids])].sort(compareStrings);
  return ids.length === 3 ? { leaf, forwarded, answer, ids } : null;
}

export function recognizeJsonByteMeasurement(compiler, graph, requests, strict) {
  const first = graph.states.values().next().value;
  if (!first) return null;
  const matches = [];
  for (const callable of first.source.statements) {
    if (!privateFunction(callable, first.source) || !objectParameter(callable, 0)) continue;
    const leaf = {
      ...first,
      referenceFacts: graph.referenceFacts,
      compiler,
      callable,
      identity: canonicalDeclaration(compiler, callable, null),
      index: 0,
    };
    if (!numericLeaf(leaf, strict)) continue;
    const component = componentFor(leaf, directCalls(leaf), graph, strict);
    if (component) matches.push(component);
  }
  if (matches.length !== 1) return null;
  const result = matches[0];
  const roots = result.ids.map((recordId) => {
    const request = requests.find((entry) => entry.recordId === recordId);
    return request
      ? {
          recordId,
          identity: request.identity,
          index: request.index,
          origin: result.forwarded.ids.includes(recordId) ? "container" : "answers",
        }
      : null;
  });
  if (
    roots.some((root) => !root) ||
    new Set(roots.map((root) => JSON.stringify([root.identity.owner, root.identity.producer])))
      .size !== 3
  )
    return null;
  return { ...result, componentRoots: roots };
}
