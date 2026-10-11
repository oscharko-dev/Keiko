import { policyDigest } from "./code-quality-inventory.mjs";
import { join, relative } from "node:path";
import ts from "typescript";
import {
  createCompilerContext,
  qualifiedAlias,
  visitCompilerNodes,
} from "./code-quality-compiler.mjs";
import {
  canonicalDeclaration,
  compilerNodeAt,
  qualifyContextDeclarations,
} from "./code-quality-provenance.mjs";

function typeFacts(type) {
  const flags = type.flags;
  if ((flags & ts.TypeFlags.Unknown) !== 0) return { kind: "unknown" };
  if ((flags & ts.TypeFlags.Any) !== 0) return { kind: "any" };
  if (type.isUnion()) {
    const indexes = type.types.flatMap(typeIndexes);
    return {
      kind: "union",
      members: type.types.length,
      containsUnknown: type.types.some((member) => (member.flags & ts.TypeFlags.Unknown) !== 0),
      ...(indexes.length ? { indexes } : {}),
    };
  }
  if ((flags & ts.TypeFlags.Object) !== 0) {
    const indexes = typeIndexes(type);
    return {
      kind: "object",
      ...(indexes.length ? { indexes } : {}),
    };
  }
  if ((flags & ts.TypeFlags.Never) !== 0) return { kind: "never" };
  return { kind: "primitive" };
}

function typeIndexes(type) {
  return [type.getStringIndexType(), type.getNumberIndexType()].filter(Boolean).map(indexTypeFacts);
}

function indexTypeFacts(type) {
  if ((type.flags & ts.TypeFlags.Unknown) !== 0) return { kind: "unknown" };
  if ((type.flags & ts.TypeFlags.Any) !== 0) return { kind: "any" };
  return { kind: "typed" };
}

function signatureFacts(context, signature) {
  const predicate = context.checker.getTypePredicateOfSignature(signature);
  return {
    parameters: signature.parameters.map((parameter, index) => ({
      index,
      optional: Boolean(
        parameter.valueDeclaration?.questionToken ?? parameter.valueDeclaration?.initializer,
      ),
      rest: Boolean(parameter.valueDeclaration?.dotDotDotToken),
      type: typeFacts(
        context.checker.getTypeOfSymbolAtLocation(parameter, parameter.valueDeclaration),
      ),
    })),
    result: typeFacts(context.checker.getReturnTypeOfSignature(signature)),
    predicate: predicate
      ? {
          kind: ts.TypePredicateKind[predicate.kind],
          parameterIndex: predicate.parameterIndex ?? null,
        }
      : null,
  };
}

function resolvedFacts(compiler, context, symbol, entry) {
  symbol = qualifiedAlias(context, symbol, compiler.state.limits.aliases);
  const identities = symbol.declarations.map((declaration) =>
    canonicalDeclaration(compiler, declaration, entry),
  );
  const type =
    (symbol.flags & ts.SymbolFlags.Type) !== 0 && !symbol.valueDeclaration
      ? context.checker.getDeclaredTypeOfSymbol(symbol)
      : context.checker.getTypeOfSymbolAtLocation(
          symbol,
          symbol.valueDeclaration ?? symbol.declarations[0],
        );
  return {
    identities,
    type: typeFacts(type),
    signatures: type.getCallSignatures().map((signature) => signatureFacts(context, signature)),
  };
}

function ownedSource(compiler, path) {
  if (!compiler.state.subject.inventory.files.some((file) => file.path === path))
    throw new TypeError("unaccounted-symbol-source");
  compiler.read(path);
  const context = compiler.program(path);
  const source = context.program.getSourceFile(join(compiler.state.subject.root, path));
  if (!source) throw new TypeError("untyped-symbol-source");
  qualifyContextDeclarations(compiler, context);
  return { context, source };
}

function resolveExport(compiler, request) {
  const { context, source } = ownedSource(compiler, request.consumerPath);
  const references = source.statements.filter(
    (statement) =>
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier?.text === request.specifier,
  );
  if (references.length === 0) throw new TypeError("unresolved-export-entry");
  const module = context.checker.getSymbolAtLocation(references[0].moduleSpecifier);
  if (!module) throw new TypeError("unresolved-export-entry");
  const symbol = context.checker
    .getExportsOfModule(module)
    .find((entry) => entry.name === request.exportName);
  const entry = { specifier: request.specifier, exportName: request.exportName };
  const facts = resolvedFacts(compiler, context, symbol, entry);
  compiler.assertCurrent();
  return facts;
}

function describeAt(compiler, request) {
  const { context, source } = ownedSource(compiler, request.path);
  const node = compilerNodeAt(compiler, source, request.offset);
  const facts = resolvedFacts(compiler, context, context.checker.getSymbolAtLocation(node), null);
  compiler.assertCurrent();
  return facts;
}

function sameProducer(left, right) {
  return (
    left.owner === right.owner &&
    left.producer.path === right.producer.path &&
    left.producer.start === right.producer.start &&
    left.producer.end === right.producer.end &&
    left.producer.kind === right.producer.kind
  );
}

function candidateDeclaration(compiler, symbol, identity) {
  const subject = compiler.state.subject;
  return symbol.declarations.some((declaration) => {
    const path = relative(subject.root, declaration.getSourceFile().fileName).replaceAll("\\", "/");
    return (subject.outputs.get(path) ?? path) === identity.producer.path;
  });
}

function inertExpression(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

function unwrappedExpression(node) {
  while (inertExpression(node)) node = node.expression;
  return node;
}

function useKind(node) {
  let outer = node;
  while (inertExpression(outer.parent) && outer.parent.expression === outer) outer = outer.parent;
  if (
    (ts.isCallExpression(outer.parent) || ts.isNewExpression(outer.parent)) &&
    outer.parent.expression === outer
  )
    return "call";
  if (ts.isExportSpecifier(node.parent)) return "reexport";
  if (ts.isTypeReferenceNode(node.parent) || ts.isTypeQueryNode(node.parent))
    return "type-reference";
  return "reference";
}

function referenceNode(node) {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return true;
  return (
    ts.isIdentifier(node) &&
    !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
  );
}

function staticMemberKey(compiler, context, node) {
  const seen = new Set();
  while (node) {
    node = unwrappedExpression(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return String(Number(node.text));
    if (!ts.isIdentifier(node)) return undefined;
    const symbol = context.checker.getSymbolAtLocation(node);
    const initializer = aliasInitializer(symbol?.valueDeclaration);
    if (!initializer) return undefined;
    if (seen.has(symbol) || seen.size >= compiler.state.limits.aliases)
      throw new TypeError("symbol-alias-budget");
    seen.add(symbol);
    node = initializer;
  }
  return undefined;
}

function expressionSymbol(compiler, context, node) {
  node = unwrappedExpression(node);
  if (!ts.isElementAccessExpression(node)) return context.checker.getSymbolAtLocation(node);
  const key = staticMemberKey(compiler, context, node.argumentExpression);
  if (key === undefined) return undefined;
  const owner = context.checker.getNonNullableType(
    context.checker.getTypeAtLocation(node.expression),
  );
  return context.checker.getPropertyOfType(owner, key);
}

function aliasInitializer(declaration) {
  if (!declaration) return null;
  if (
    ts.isParameter(declaration) ||
    ts.isBindingElement(declaration) ||
    ts.isPropertyAssignment(declaration) ||
    ts.isShorthandPropertyAssignment(declaration)
  )
    return undefined;
  if (!ts.isVariableDeclaration(declaration)) return null;
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0 || !declaration.initializer)
    return undefined;
  return declaration.initializer;
}

function matchesProducer(compiler, symbol, identity) {
  if (!candidateDeclaration(compiler, symbol, identity)) return false;
  return symbol.declarations.some((declaration) =>
    sameProducer(canonicalDeclaration(compiler, declaration, identity.entry), identity),
  );
}

function namespaceReceiver(compiler, context, node) {
  const seen = new Set();
  while (node) {
    node = unwrappedExpression(node);
    if (!ts.isIdentifier(node)) return false;
    const symbol = context.checker.getSymbolAtLocation(node);
    if (
      symbol?.declarations?.some(
        (declaration) =>
          ts.isNamespaceImport(declaration) && !ts.isTypeOnlyImportDeclaration(declaration),
      )
    )
      return true;
    if (seen.has(symbol) || seen.size >= compiler.state.limits.aliases)
      throw new TypeError("symbol-alias-budget");
    seen.add(symbol);
    node = aliasInitializer(symbol?.valueDeclaration);
  }
  return false;
}

function qualifiedMemberReceiver(compiler, context, node) {
  node = unwrappedExpression(node);
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return true;
  return namespaceReceiver(compiler, context, node.expression);
}

function invocationSymbol(compiler, context, symbol, identity) {
  const seen = new Set();
  while (symbol) {
    symbol = qualifiedAlias(context, symbol, compiler.state.limits.aliases);
    if (matchesProducer(compiler, symbol, identity)) return symbol;
    const initializer = aliasInitializer(symbol.valueDeclaration);
    if (initializer === null) return symbol;
    if (initializer === undefined) return undefined;
    if (seen.has(symbol) || seen.size >= compiler.state.limits.aliases)
      throw new TypeError("symbol-alias-budget");
    seen.add(symbol);
    if (!qualifiedMemberReceiver(compiler, context, initializer)) return undefined;
    symbol = expressionSymbol(compiler, context, initializer);
  }
  return undefined;
}

function scanUses(compiler, path, identity, result) {
  let owned;
  try {
    owned = ownedSource(compiler, path);
  } catch (error) {
    if (error.message !== "untyped-symbol-source") throw error;
    result.untyped.push(path);
    return;
  }
  const { context, source } = owned;
  visitCompilerNodes(compiler.state, source, (node) => {
    if (!referenceNode(node)) return;
    const symbol = expressionSymbol(compiler, context, node);
    if (!symbol) {
      result.unresolved += 1;
      return;
    }
    inspectUse(compiler, context, node, symbol, path, identity, result);
  });
}

function inspectUse(compiler, context, node, symbol, path, identity, result) {
  try {
    symbol =
      useKind(node) === "call"
        ? invocationSymbol(compiler, context, symbol, identity)
        : qualifiedAlias(context, symbol, compiler.state.limits.aliases);
    if (!symbol) {
      result.unresolved += 1;
      return;
    }
  } catch (error) {
    if (error.message !== "unresolved-owner-symbol") throw error;
    result.unresolved += 1;
    return;
  }
  if (!matchesProducer(compiler, symbol, identity)) return;
  if (!qualifiedMemberReceiver(compiler, context, node)) {
    result.unresolved += 1;
    return;
  }
  result.uses.push({ path, start: node.getStart(), end: node.end, kind: useKind(node) });
}

function incomingUses(compiler, identity, paths) {
  const production = compiler.state.subject.inventory.files
    .filter((file) => file.production)
    .map((file) => file.path);
  const selected = paths ?? production;
  const partial =
    production.length !== selected.length || production.some((path) => !selected.includes(path));
  const result = { uses: [], untyped: [], unresolved: 0 };
  for (const path of new Set(selected)) scanUses(compiler, path, identity, result);
  compiler.assertCurrent();
  return {
    ...result,
    partial,
    complete: !partial && result.untyped.length === 0 && result.unresolved === 0,
  };
}

function ownedDeclaration(compiler, identity) {
  const { context, source } = ownedSource(compiler, identity.producer.path);
  let node = compilerNodeAt(compiler, source, identity.producer.start);
  while (node && ts.SyntaxKind[node.kind] !== identity.producer.kind) node = node.parent;
  if (!node || !sameProducer(canonicalDeclaration(compiler, node, identity.entry), identity))
    throw new TypeError("mismatched-responsibility-producer");
  return { context, source, node };
}

function runtimeCallable(node) {
  return (
    node &&
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
    node.body
  );
}

function declarationCallable(compiler, identity) {
  const { context, source, node } = ownedDeclaration(compiler, identity);
  const callable = ts.isVariableDeclaration(node) ? node.initializer : node;
  if (!runtimeCallable(callable)) throw new TypeError("unsupported-responsibility-callable");
  return { context, source, callable };
}

function consumerImplementation(compiler, identity) {
  const seen = new Set();
  while (identity) {
    const { context, source, node } = ownedDeclaration(compiler, identity);
    const initializer = aliasInitializer(node);
    const callable = initializer ? unwrappedExpression(initializer) : node;
    if (runtimeCallable(callable)) return { context, source, callable, identity };
    if (!initializer || !qualifiedMemberReceiver(compiler, context, initializer)) break;
    const key = JSON.stringify(identity.producer);
    if (seen.has(key) || seen.size >= compiler.state.limits.aliases)
      throw new TypeError("symbol-alias-budget");
    seen.add(key);
    const symbol = qualifiedAlias(
      context,
      expressionSymbol(compiler, context, initializer),
      compiler.state.limits.aliases,
    );
    if (symbol.declarations.length !== 1) break;
    identity = canonicalDeclaration(compiler, symbol.declarations[0], null);
  }
  throw new TypeError("unsupported-responsibility-consumer-implementation");
}

function inlineCallArgument(node) {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  if (node.name) return false;
  while (inertExpression(node.parent)) node = node.parent;
  return ts.isCallExpression(node.parent) && node.parent.arguments.includes(node);
}

function participatingCall(node, callable) {
  for (let parent = node.parent; parent && parent !== callable; parent = parent.parent) {
    if (ts.isClassLike(parent)) return false;
    if (ts.isFunctionLike(parent) && !inlineCallArgument(parent)) return false;
  }
  return true;
}

function canonicalCall(compiler, context, expression, producer) {
  if (!qualifiedMemberReceiver(compiler, context, expression)) return false;
  try {
    const symbol = invocationSymbol(
      compiler,
      context,
      expressionSymbol(compiler, context, expression),
      producer,
    );
    return Boolean(symbol && matchesProducer(compiler, symbol, producer));
  } catch (error) {
    if (error.message !== "unresolved-owner-symbol") throw error;
    return false;
  }
}

function consumerCalls(compiler, identity, producer, expectedOwner) {
  const implementation = consumerImplementation(compiler, identity);
  if (implementation.identity.owner !== expectedOwner)
    throw new TypeError("foreign-responsibility-consumer-implementation");
  const calls = [];
  visitCompilerNodes(compiler.state, implementation.callable.body, (node) => {
    if (!ts.isCallExpression(node) || !participatingCall(node, implementation.callable)) return;
    if (!canonicalCall(compiler, implementation.context, node.expression, producer)) return;
    calls.push({
      path: implementation.identity.producer.path,
      start: node.getStart(),
      end: node.end,
    });
  });
  compiler.assertCurrent();
  return { implementation: implementation.identity, calls, bound: calls.length > 0 };
}

function annotationSlot(context, source, annotation, identity, kind, index = null) {
  if (!annotation) return null;
  const position = source.getLineAndCharacterOfPosition(annotation.getStart(source));
  return {
    kind,
    index,
    path: identity.producer.path,
    line: position.line + 1,
    column: position.character + 1,
    start: annotation.getStart(source),
    end: annotation.end,
    type: typeFacts(context.checker.getTypeAtLocation(annotation)),
  };
}

function callableSlots(compiler, identity) {
  const { context, source, callable } = declarationCallable(compiler, identity);
  const facts = {
    parameters: callable.parameters.map((parameter, index) =>
      annotationSlot(context, source, parameter.type, identity, "parameter", index),
    ),
    result: annotationSlot(context, source, callable.type, identity, "return"),
  };
  compiler.assertCurrent();
  return facts;
}

function expressionFactsAt(compiler, request) {
  const { context, source } = ownedSource(compiler, request.path);
  let node = compilerNodeAt(compiler, source, request.offset);
  while (inertExpression(node.parent) && node.parent.expression === node) node = node.parent;
  if (!ts.isExpressionNode(node)) throw new TypeError("unsupported-responsibility-expression");
  const facts = {
    type: typeFacts(context.checker.getTypeAtLocation(node)),
    beforeAssertions: typeFacts(context.checker.getTypeAtLocation(unwrappedExpression(node))),
  };
  compiler.assertCurrent();
  return facts;
}

export function createSymbolResolver(subject, options = {}) {
  const compiler = createCompilerContext(subject, options);
  return {
    resolveExport: (request) => resolveExport(compiler, request),
    describeAt: (request) => describeAt(compiler, request),
    incomingUses: (identity, paths) => incomingUses(compiler, identity, paths),
    callableSlots: (identity) => callableSlots(compiler, identity),
    consumerCalls: (identity, producer, expectedOwner) =>
      consumerCalls(compiler, identity, producer, expectedOwner),
    expressionFactsAt: (request) => expressionFactsAt(compiler, request),
    sourceIdentity: (path) => {
      const sha256 = policyDigest(compiler.read(path));
      compiler.assertCurrent();
      return { path, sha256 };
    },
    assertCurrent: compiler.assertCurrent,
    close: compiler.close,
    stats: () => ({
      programs: compiler.state.programs.size,
      created: compiler.state.created,
      sourceBytes: compiler.state.bytes,
      nodes: compiler.state.nodes,
    }),
  };
}
