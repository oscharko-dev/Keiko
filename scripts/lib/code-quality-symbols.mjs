import { Buffer } from "node:buffer";
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

function nativeDiagnosticPosition(source, offset) {
  const position = source.getLineAndCharacterOfPosition(offset);
  const lineStart = source.getPositionOfLineAndCharacter(position.line, 0);
  return {
    line: position.line + 1,
    column: Buffer.byteLength(source.text.slice(lineStart, offset), "utf8") + 1,
  };
}

function annotationSlot(context, source, annotation, identity, kind, index = null) {
  if (!annotation) return null;
  const position = nativeDiagnosticPosition(source, annotation.getStart(source));
  return {
    kind,
    index,
    path: identity.producer.path,
    ...position,
    start: annotation.getStart(source),
    end: annotation.end,
    type: typeFacts(context.checker.getTypeAtLocation(annotation)),
  };
}

function rawParentheses(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function sourceNodes(compiler, source) {
  const nodes = [];
  visitCompilerNodes(compiler.state, source, (node) => nodes.push(node));
  return nodes;
}

function containsSymbol(context, node, symbol) {
  if (ts.isIdentifier(node) && context.checker.getSymbolAtLocation(node) === symbol) return true;
  return Boolean(ts.forEachChild(node, (child) => containsSymbol(context, child, symbol)));
}

function writtenSymbol(context, nodes, symbol) {
  return nodes.some((node) => {
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      return (
        kind >= ts.SyntaxKind.FirstAssignment &&
        kind <= ts.SyntaxKind.LastAssignment &&
        containsSymbol(context, node.left, symbol)
      );
    }
    return (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
      containsSymbol(context, node.operand, symbol)
    );
  });
}

function rawProjectionOrigin(state, node, seen) {
  const key = ts.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression.text;
  const origin = rawOrigin(state, node.expression, seen);
  return origin ? [...origin, key] : null;
}

function rawAliasOrigin(state, symbol, seen) {
  if (seen.has(symbol) || seen.size >= state.compiler.state.limits.aliases)
    throw new TypeError("symbol-alias-budget");
  seen.add(symbol);
  const declaration = symbol.valueDeclaration;
  const initializer = aliasInitializer(declaration);
  if (!initializer || !ts.isIdentifier(declaration.name)) return null;
  if (declaration.type && rawErasure(state.context, declaration.type)) return null;
  return rawOrigin(state, initializer, seen);
}

function rawOrigin(state, node, seen = new Set()) {
  node = rawParentheses(node);
  if (ts.isPropertyAccessExpression(node)) return rawProjectionOrigin(state, node, seen);
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression))
    return rawProjectionOrigin(state, node, seen);
  if (!ts.isIdentifier(node)) return null;
  const symbol = state.context.checker.getSymbolAtLocation(node);
  if (!symbol || writtenSymbol(state.context, state.nodes, symbol)) return null;
  if (symbol === state.parameterSymbol) return [];
  return rawAliasOrigin(state, symbol, seen);
}

function rawErasure(context, annotation) {
  const facts = typeFacts(context.checker.getTypeAtLocation(annotation));
  return (
    ["unknown", "any"].includes(facts.kind) ||
    facts.indexes?.some((index) => ["unknown", "any"].includes(index.kind))
  );
}

function directRawBody(node, callable) {
  for (let parent = node.parent; parent && parent !== callable; parent = parent.parent)
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent)) return false;
  return true;
}

function exportedDeclaration(node) {
  const owner = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  return (
    ts.canHaveModifiers(owner) &&
    ts
      .getModifiers(owner)
      ?.some((modifier) =>
        [ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DefaultKeyword].includes(modifier.kind),
      )
  );
}

function rawCallableTarget(compiler, source, node, callable) {
  const statement = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  if (statement.parent !== source) return null;
  return { callable, identity: canonicalDeclaration(compiler, node, null), declaration: node };
}

function rawCallableBinding(compiler, context, source, expression, seen) {
  const symbol = context.checker.getSymbolAtLocation(expression);
  const node = symbol?.valueDeclaration;
  if (!node || node.getSourceFile() !== source) return null;
  if (seen.has(symbol) || seen.size >= compiler.state.limits.aliases)
    throw new TypeError("symbol-alias-budget");
  seen.add(symbol);
  return node;
}

function localRawCallable(compiler, context, source, expression) {
  const seen = new Set();
  while (expression) {
    expression = rawParentheses(expression);
    if (!ts.isIdentifier(expression)) return null;
    const node = rawCallableBinding(compiler, context, source, expression, seen);
    if (!node) return null;
    const initializer = aliasInitializer(node);
    const callable = initializer ? rawParentheses(initializer) : node;
    if (runtimeCallable(callable)) return rawCallableTarget(compiler, source, node, callable);
    if (!initializer || exportedDeclaration(node)) return null;
    expression = initializer;
  }
  return null;
}

function rawState(compiler, context, source, nodes, target, index) {
  const parameter = target.callable.parameters[index];
  if (!parameter || !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) return null;
  return {
    ...target,
    compiler,
    context,
    source,
    nodes,
    index,
    parameterSymbol: context.checker.getSymbolAtLocation(parameter.name),
    key: `${target.identity.producer.start}:${index}`,
    incoming: [],
  };
}

function stateCalls(state) {
  return state.nodes.filter(
    (node) =>
      ts.isCallExpression(node) &&
      node.getStart() >= state.callable.body.getStart() &&
      node.end <= state.callable.body.end &&
      directRawBody(node, state.callable),
  );
}

function rawCallEdges(state, states, queue) {
  for (const call of stateCalls(state)) {
    const target = localRawCallable(state.compiler, state.context, state.source, call.expression);
    if (!target || exportedDeclaration(target.declaration)) continue;
    for (const [index, argument] of call.arguments.entries()) {
      const origin = rawOrigin(state, argument);
      if (!origin) continue;
      const candidate = rawState(
        state.compiler,
        state.context,
        state.source,
        state.nodes,
        target,
        index,
      );
      if (!candidate) continue;
      if (!states.has(candidate.key)) {
        states.set(candidate.key, candidate);
        queue.push(candidate);
      }
      states.get(candidate.key).incoming.push({ state: state.key, call, origin });
    }
  }
}

function declarationReference(node) {
  return (
    (ts.isFunctionDeclaration(node.parent) ||
      ts.isVariableDeclaration(node.parent) ||
      ts.isParameter(node.parent)) &&
    node.parent.name === node
  );
}

function referenceValueSymbol(context, node) {
  if (ts.isExportSpecifier(node.parent))
    return context.checker.getExportSpecifierLocalTargetSymbol(node.parent);
  return ts.isShorthandPropertyAssignment(node.parent)
    ? context.checker.getShorthandAssignmentValueSymbol(node.parent)
    : context.checker.getSymbolAtLocation(node);
}

function helperReference(state, node) {
  if (!ts.isIdentifier(node) || declarationReference(node) || ts.isTypeQueryNode(node.parent))
    return false;
  const symbol = referenceValueSymbol(state.context, node);
  if (!symbol) return false;
  const declaration = symbol.valueDeclaration;
  if (declaration === state.declaration) return true;
  if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
  const target = localRawCallable(state.compiler, state.context, state.source, node);
  return target && sameProducer(target.identity, state.identity);
}

function referenceCall(node) {
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null;
}

function permittedHelperReference(state, node) {
  const call = referenceCall(node);
  if (call) return state.incoming.some((edge) => edge.call === call);
  let outer = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  return (
    ts.isVariableDeclaration(outer.parent) &&
    outer.parent.initializer === outer &&
    Boolean(aliasInitializer(outer.parent)) &&
    !exportedDeclaration(outer.parent) &&
    ts.isIdentifier(outer.parent.name)
  );
}

function assertRawAcyclic(states) {
  const complete = new Set();
  function visit(key, active) {
    if (active.has(key)) throw new TypeError("unsupported-raw-helper-cycle");
    if (complete.has(key)) return;
    if (active.size >= states.get(key).compiler.state.limits.aliases)
      throw new TypeError("symbol-alias-budget");
    const next = new Set(active).add(key);
    for (const edge of states.get(key).incoming) visit(edge.state, next);
    complete.add(key);
  }
  for (const key of states.keys()) visit(key, new Set());
}

function qualifiedRawStates(root, states) {
  const qualified = new Set(states.keys());
  for (const state of states.values()) {
    if (state === root) continue;
    if (
      state.nodes.some(
        (node) => helperReference(state, node) && !permittedHelperReference(state, node),
      )
    )
      qualified.delete(state.key);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const state of states.values()) {
      if (state === root || !qualified.has(state.key)) continue;
      if (state.incoming.some((edge) => !qualified.has(edge.state))) {
        qualified.delete(state.key);
        changed = true;
      }
    }
  }
  return qualified;
}

function rawOperationSlot(state, node, rule, kind, origin) {
  const position = nativeDiagnosticPosition(state.source, node.getStart(state.source));
  return {
    kind,
    path: state.identity.producer.path,
    rule,
    ...position,
    start: node.getStart(state.source),
    end: node.end,
    origin,
  };
}

function rawTypeofSlots(state) {
  return state.nodes
    .filter(
      (node) =>
        ts.isTypeOfExpression(node) &&
        node.getStart() >= state.callable.body.getStart() &&
        node.end <= state.callable.body.end &&
        directRawBody(node, state.callable),
    )
    .flatMap((node) => {
      const origin = rawOrigin(state, node.expression);
      const facts = typeFacts(state.context.checker.getTypeAtLocation(node.expression));
      return origin && facts.kind === "unknown"
        ? [rawOperationSlot(state, node, "anti-slop/no-runtime-typeof", "typeof", origin)]
        : [];
    });
}

function rawPredicateSlots(state, states, qualified) {
  return stateCalls(state).flatMap((call) => {
    const target = localRawCallable(state.compiler, state.context, state.source, call.expression);
    if (!target) return [];
    const signature = state.context.checker.getResolvedSignature(call);
    const predicate = signature && state.context.checker.getTypePredicateOfSignature(signature);
    if (predicate?.kind !== ts.TypePredicateKind.Identifier) return [];
    const key = `${target.identity.producer.start}:${predicate.parameterIndex}`;
    const argument = call.arguments[predicate.parameterIndex];
    const origin = argument && rawOrigin(state, argument);
    if (!states.has(key) || !qualified.has(key) || !origin || rawErasure(state.context, argument))
      return [];
    return [
      rawOperationSlot(state, argument, "anti-slop/no-known-value-widening", "argument", origin),
    ];
  });
}

function rawCheckingSlots(compiler, identity, index) {
  const owned = declarationCallable(compiler, identity);
  const nodes = sourceNodes(compiler, owned.source);
  const root = rawState(
    compiler,
    owned.context,
    owned.source,
    nodes,
    { callable: owned.callable, identity, declaration: owned.callable },
    index,
  );
  if (!root || writtenSymbol(root.context, nodes, root.parameterSymbol)) return [];
  const states = new Map([[root.key, root]]);
  const queue = [root];
  for (const state of queue) rawCallEdges(state, states, queue);
  assertRawAcyclic(states);
  const qualified = qualifiedRawStates(root, states);
  const slots = [];
  for (const state of states.values()) {
    if (!qualified.has(state.key)) continue;
    const parameter = state.callable.parameters[state.index];
    const annotation = annotationSlot(
      state.context,
      state.source,
      parameter.type,
      state.identity,
      "parameter",
      state.index,
    );
    if (annotation?.type.kind === "unknown")
      slots.push({ ...annotation, rule: "anti-slop/no-unknown-parameters" });
    slots.push(...rawTypeofSlots(state), ...rawPredicateSlots(state, states, qualified));
  }
  compiler.assertCurrent();
  return slots;
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
  const rawSlots = new Map();
  return {
    resolveExport: (request) => resolveExport(compiler, request),
    describeAt: (request) => describeAt(compiler, request),
    incomingUses: (identity, paths) => incomingUses(compiler, identity, paths),
    callableSlots: (identity) => callableSlots(compiler, identity),
    rawCheckingSlots: (identity, index) => {
      compiler.assertCurrent();
      const key = policyDigest(JSON.stringify({ identity, index }));
      if (!rawSlots.has(key)) rawSlots.set(key, rawCheckingSlots(compiler, identity, index));
      return structuredClone(rawSlots.get(key));
    },
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
