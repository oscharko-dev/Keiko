import { Buffer } from "node:buffer";
import { types } from "node:util";
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
  qualifiedDeclarationBytes,
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
  if (type.isIntersection() || (flags & ts.TypeFlags.Object) !== 0) {
    const indexes = typeIndexes(type);
    return {
      kind: type.isIntersection() ? "intersection" : "object",
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

function ownedSource(compiler, path, proof = false) {
  if (!compiler.state.subject.inventory.files.some((file) => file.path === path))
    throw new TypeError("unaccounted-symbol-source");
  compiler.read(path);
  const context = proof ? compiler.proofProgram(path) : compiler.program(path);
  const source = context.program.getSourceFile(join(compiler.state.subject.root, path));
  if (!source) throw new TypeError("untyped-symbol-source");
  qualifyContextDeclarations(compiler, context);
  return { context, source };
}

function resolveExport(compiler, request, proof = false) {
  const { context, source } = ownedSource(compiler, request.consumerPath, proof);
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
  if (proof) qualifyPublicEntry(compiler, context, source, references, request, facts);
  compiler.assertCurrent();
  return facts;
}

function sourceOverride(config, specifier) {
  return Object.keys(config.options.paths ?? {}).some(
    (pattern) =>
      pattern === specifier ||
      (pattern.includes("*") &&
        specifier.startsWith(pattern.split("*")[0]) &&
        specifier.endsWith(pattern.split("*")[1])),
  );
}

function declarationModule(compiler, context, source, literal, publicEntry = false) {
  const mode = ts.getModeForUsageLocation(source, literal, context.config.options);
  if (sourceOverride(context.config, literal.text))
    throw new TypeError("unsupported-public-source-override");
  const resolved = compiler.resolveModule(source.fileName, literal.text, context.config, mode);
  if (!resolved) throw new TypeError("unresolved-public-declaration-entry");
  const path = relative(compiler.state.subject.root, resolved.resolvedFileName).replaceAll(
    "\\",
    "/",
  );
  if (publicEntry) return selectedPublicEntry(compiler, literal.text, resolved, path, mode);
  if (!compiler.state.subject.outputs.has(path))
    throw new TypeError("unqualified-public-declaration-entry");
  return path;
}

function closedPublicTarget(target) {
  return Boolean(
    target &&
    Object.keys(target).length === 2 &&
    Object.hasOwn(target, "import") &&
    Object.hasOwn(target, "types") &&
    typeof target.types === "string" &&
    typeof target.import === "string" &&
    target.types.startsWith("./") &&
    target.import.startsWith("./"),
  );
}

function publicPackageOwner(subject, specifier, resolved, mode) {
  const owner = subject.inventory.packages.find((entry) => entry.name === resolved.packageId?.name);
  if (
    mode !== ts.ModuleKind.ESNext ||
    !owner ||
    !(specifier === owner.name || specifier.startsWith(`${owner.name}/`))
  )
    throw new TypeError("unqualified-public-declaration-entry");
  return owner;
}

function selectedPublicEntry(compiler, specifier, resolved, path, mode) {
  const subject = compiler.state.subject;
  const owner = publicPackageOwner(subject, specifier, resolved, mode);
  const manifest = JSON.parse(compiler.read(`${owner.directory}/package.json`));
  const key = specifier === owner.name ? "." : `.${specifier.slice(owner.name.length)}`;
  const target = manifest.exports?.[key];
  if (!closedPublicTarget(target)) throw new TypeError("unsupported-public-declaration-entry");
  const declaration = `${owner.directory}/${target.types.slice(2)}`;
  const runtime = `${owner.directory}/${target.import.slice(2)}`;
  const source = subject.outputs.get(declaration);
  if (
    !source ||
    subject.outputs.get(runtime) !== source ||
    ![declaration, source].includes(path) ||
    !/\.d\.[cm]?ts$/u.test(declaration)
  )
    throw new TypeError("unqualified-public-declaration-entry");
  compiler.read(runtime);
  return declaration;
}

function publicDeclarationSource(compiler, context, path) {
  compiler.assertCurrent();
  const cached = compiler.state.declarations.get(path);
  if (cached) return cached;
  const { declarationText } = qualifiedDeclarationBytes(compiler, path);
  const source = ts.createSourceFile(
    join(compiler.state.subject.root, path),
    declarationText,
    context.config.options.target,
    true,
  );
  source.impliedNodeFormat = ts.getImpliedNodeFormatForFile(
    source.fileName,
    undefined,
    {
      ...ts.sys,
      readFile: (absolute) =>
        compiler.read(relative(compiler.state.subject.root, absolute).replaceAll("\\", "/")),
    },
    context.config.options,
  );
  visitCompilerNodes(compiler.state, source, () => undefined);
  compiler.state.declarations.set(path, source);
  return source;
}

function publicExportCandidates(source, name) {
  const functions = source.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
  const exports = source.statements
    .filter(
      (node) =>
        ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause),
    )
    .flatMap((node) =>
      node.exportClause.elements
        .filter((entry) => entry.name.text === name)
        .map((entry) => ({ node, entry })),
    );
  return { functions, exports };
}

function namedValueReexport(node, entry) {
  return (
    !node.isTypeOnly &&
    !entry.isTypeOnly &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  );
}

function publicDeclaration(compiler, context, path, name, seen) {
  if (seen.has(path) || seen.size >= compiler.state.limits.aliases)
    throw new TypeError("symbol-alias-budget");
  seen.add(path);
  const source = publicDeclarationSource(compiler, context, path);
  const { functions, exports } = publicExportCandidates(source, name);
  if (functions.length === 1 && exports.length === 0)
    return canonicalDeclaration(compiler, functions[0], null);
  if (functions.length || exports.length !== 1)
    throw new TypeError("unsupported-public-declaration-entry");
  const { node, entry } = exports[0];
  if (!namedValueReexport(node, entry)) throw new TypeError("unsupported-public-declaration-entry");
  return publicDeclaration(
    compiler,
    context,
    declarationModule(compiler, context, source, node.moduleSpecifier),
    entry.propertyName?.text ?? entry.name.text,
    seen,
  );
}

function qualifyPublicEntry(compiler, context, source, references, request, facts) {
  if (references.length !== 1 || facts.identities.length !== 1)
    throw new TypeError("ambiguous-public-declaration-entry");
  const statement = references[0];
  if (
    !ts.isImportDeclaration(statement) ||
    statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
  )
    throw new TypeError("unsupported-public-declaration-entry");
  const entry = declarationModule(compiler, context, source, statement.moduleSpecifier, true);
  const canonical = publicDeclaration(compiler, context, entry, request.exportName, new Set());
  if (!sameProducer(canonical, facts.identities[0]))
    throw new TypeError("mismatched-public-declaration-producer");
}

function resolveProofConsumer(compiler, request) {
  const { context, source } = ownedSource(compiler, request.consumerPath, true);
  const module = context.checker.getSymbolAtLocation(source);
  const symbol = context.checker
    .getExportsOfModule(module)
    .find((entry) => entry.name === request.exportName);
  const facts = resolvedFacts(compiler, context, symbol, null);
  compiler.assertCurrent();
  return facts;
}

function directDiagnosticCallable(callable) {
  return Boolean(
    callable.body &&
    !callable.typeParameters?.length &&
    !callable.asteriskToken &&
    callable.parameters.length === 1 &&
    callable.body.statements.length === 2,
  );
}

function diagnosticCallable(context, source, name) {
  const module = context.checker.getSymbolAtLocation(source);
  const symbol = context.checker.getExportsOfModule(module).find((entry) => entry.name === name);
  const declarations = symbol?.declarations ?? [];
  if (declarations.length !== 1 || !ts.isFunctionDeclaration(declarations[0])) return null;
  const callable = declarations[0];
  if (!directDiagnosticCallable(callable)) return null;
  return diagnosticParameter(context, callable.parameters[0]) ? callable : null;
}

function diagnosticParameter(context, parameter) {
  return (
    ts.isIdentifier(parameter.name) &&
    !parameter.initializer &&
    !parameter.questionToken &&
    !parameter.dotDotDotToken &&
    (context.checker.getTypeAtLocation(parameter).flags & ts.TypeFlags.Unknown) !== 0
  );
}

function diagnosticResult(callable) {
  const [assignment, returned] = callable.body.statements;
  if (
    !ts.isVariableStatement(assignment) ||
    assignment.declarationList.flags !== ts.NodeFlags.Const ||
    assignment.declarationList.declarations.length !== 1 ||
    !ts.isReturnStatement(returned)
  )
    return null;
  const local = assignment.declarationList.declarations[0];
  const call = local.initializer;
  if (
    !ts.isIdentifier(local.name) ||
    !directDiagnosticCall(call) ||
    !diagnosticLength(returned.expression)
  )
    return null;
  return { local, call, argument: call.arguments[0], result: returned.expression };
}

function directDiagnosticCall(call) {
  return Boolean(
    call &&
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    !call.typeArguments?.length &&
    call.arguments.length === 1 &&
    ts.isIdentifier(call.arguments[0]),
  );
}

function diagnosticLength(result) {
  return Boolean(
    result &&
    ts.isPropertyAccessExpression(result) &&
    ts.isIdentifier(result.expression) &&
    result.name.text === "length",
  );
}

function directDiagnosticProducer(compiler, context, call, producer) {
  const callee = context.checker.getSymbolAtLocation(call.expression);
  const imported = callee?.declarations?.[0];
  if (
    !imported ||
    !ts.isImportSpecifier(imported) ||
    imported.isTypeOnly ||
    imported.parent.parent.phaseModifier === ts.SyntaxKind.TypeKeyword
  )
    return false;
  const canonical = qualifiedAlias(context, callee, compiler.state.limits.aliases);
  return (
    canonical.declarations.length === 1 &&
    sameProducer(canonicalDeclaration(compiler, canonical.declarations[0], null), producer)
  );
}

function readonlyDiagnosticResult(context, call) {
  const signature = context.checker.getResolvedSignature(call);
  const type = context.checker.getReturnTypeOfSignature(signature);
  const args = context.checker.getTypeArguments(type);
  return (
    context.checker.isArrayType(type) &&
    type.symbol?.name === "ReadonlyArray" &&
    args.length === 1 &&
    (args[0].flags & ts.TypeFlags.String) !== 0
  );
}

function diagnosticBinding(compiler, request, producer) {
  const { context, source } = ownedSource(compiler, request.consumerPath, true);
  const callable = diagnosticCallable(context, source, request.exportName);
  const result = callable && diagnosticResult(callable);
  if (!result || !directDiagnosticProducer(compiler, context, result.call, producer))
    return { bound: false };
  const { local, call, argument } = result;
  if (
    context.checker.getSymbolAtLocation(argument) !==
      context.checker.getSymbolAtLocation(callable.parameters[0].name) ||
    context.checker.getSymbolAtLocation(result.result.expression) !==
      context.checker.getSymbolAtLocation(local.name)
  )
    return { bound: false };
  const bound = readonlyDiagnosticResult(context, call);
  compiler.assertCurrent();
  return {
    bound,
    implementation: canonicalDeclaration(compiler, callable, null),
    calls: [{ path: request.consumerPath, start: call.getStart(), end: call.end }],
  };
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
    const overload = consumerOverload(compiler, context, source, node);
    if (overload) return overload;
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
    const declaration = consumerAliasDeclaration(symbol);
    if (!declaration) break;
    identity = canonicalDeclaration(compiler, declaration, null);
  }
  throw new TypeError("unsupported-responsibility-consumer-implementation");
}

function consumerAliasDeclaration(symbol) {
  const declarations = symbol.declarations;
  if (declarations.length === 1) return declarations[0];
  if (declarations.length !== 2 || !declarations.every(ts.isFunctionDeclaration)) return null;
  return declarations.find((declaration) => !declaration.body);
}

function bodylessNamedFunction(node) {
  return ts.isFunctionDeclaration(node) && !node.body && Boolean(node.name);
}

function consumerOverload(compiler, context, source, node) {
  if (!bodylessNamedFunction(node)) return null;
  const symbol = context.checker.getSymbolAtLocation(node.name);
  const declarations = symbol?.declarations ?? [];
  if (declarations.length !== 2 || !declarations.includes(node)) return null;
  const bodies = declarations.filter((declaration) => runtimeCallable(declaration));
  if (bodies.length !== 1) return null;
  const callable = bodies[0];
  if (callable.getSourceFile() !== source || callable.parent !== source) return null;
  return { context, source, callable, identity: canonicalDeclaration(compiler, callable, null) };
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

function consumerParticipatingCalls(compiler, state) {
  const calls = [];
  visitCompilerNodes(compiler.state, state.callable.body, (node) => {
    if (ts.isCallExpression(node) && participatingCall(node, state.callable)) calls.push(node);
  });
  return calls;
}

function consumerStates(compiler, implementation) {
  const nodes = [];
  visitCompilerNodes(compiler.state, implementation.source, (node) => nodes.push(node));
  const root = {
    ...implementation,
    compiler,
    nodes,
    declaration: implementation.callable,
    incoming: [],
  };
  root.key = root.identity.producer.start;
  const states = new Map([[root.key, root]]);
  for (const state of states.values()) {
    state.calls = consumerParticipatingCalls(compiler, state);
    for (const call of state.calls) consumerEdge(state, call, states);
  }
  const complete = new Set();
  for (const key of states.keys()) assertConsumerAcyclic(states, key, new Set(), complete);
  return { root, states, qualified: qualifiedRawStates(root, states) };
}

function knownConsumerTarget(state, expression, states) {
  expression = rawParentheses(expression);
  if (!ts.isIdentifier(expression)) return null;
  const declaration = state.context.checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (!eligibleConsumerDeclaration(state, declaration)) return null;
  const target = rawCallableTarget(state.compiler, state.source, declaration, null);
  if (!target) return null;
  const implementation = existingConsumerImplementation(state.compiler, target.identity);
  if (!implementation || implementation.source !== state.source) return null;
  const known = states.get(implementation.identity.producer.start);
  return known && sameProducer(implementation.identity, known.identity) ? known : null;
}

function eligibleConsumerDeclaration(state, declaration) {
  return (
    sameSourceConsumerDeclaration(declaration, state.source) &&
    (!ts.isVariableDeclaration(declaration) || directConsumerAlias(state, declaration))
  );
}

function sameSourceConsumerDeclaration(declaration, source) {
  return (
    declaration?.getSourceFile() === source &&
    (ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration))
  );
}

function directConsumerAlias(state, declaration) {
  const seen = new Set();
  let expression = aliasInitializer(declaration);
  while (expression) {
    expression = rawParentheses(expression);
    if (runtimeCallable(expression)) return true;
    if (!ts.isIdentifier(expression)) return false;
    const node = rawCallableBinding(state.compiler, state.context, state.source, expression, seen);
    if (!node) return false;
    if (ts.isFunctionDeclaration(node)) return true;
    expression = aliasInitializer(node);
  }
  return false;
}

function existingConsumerImplementation(compiler, identity) {
  try {
    return consumerImplementation(compiler, identity);
  } catch (error) {
    if (error.message !== "unsupported-responsibility-consumer-implementation") throw error;
    return null;
  }
}

function consumerEdge(state, call, states) {
  const target =
    localRawCallable(state.compiler, state.context, state.source, call.expression) ??
    knownConsumerTarget(state, call.expression, states);
  if (!target) return;
  const key = target.identity.producer.start;
  if (exportedDeclaration(target.declaration) && !states.has(key)) return;
  if (!states.has(key)) {
    if (states.size >= state.compiler.state.limits.aliases)
      throw new TypeError("symbol-alias-budget");
    states.set(key, { ...state, ...target, key, incoming: [], calls: [] });
  }
  states.get(key).incoming.push({ state: state.key, call });
}

function assertConsumerAcyclic(states, key, active, complete) {
  if (active.has(key)) throw new TypeError("unsupported-consumer-helper-cycle");
  if (complete.has(key)) return;
  const next = new Set(active).add(key);
  for (const edge of states.get(key).incoming)
    assertConsumerAcyclic(states, edge.state, next, complete);
  complete.add(key);
}

function consumerCalls(compiler, identity, producer, expectedOwner) {
  const implementation = consumerImplementation(compiler, identity);
  if (implementation.identity.owner !== expectedOwner)
    throw new TypeError("foreign-responsibility-consumer-implementation");
  const { states, qualified } = consumerStates(compiler, implementation);
  const calls = [];
  for (const state of states.values()) {
    if (!qualified.has(state.key)) continue;
    for (const node of state.calls) {
      if (!canonicalCall(compiler, state.context, node.expression, producer)) continue;
      calls.push({ path: state.identity.producer.path, start: node.getStart(), end: node.end });
    }
  }
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

function standardDictionaryDeclaration(state, declaration) {
  return (
    state.context.program.isSourceFileDefaultLibrary(declaration.getSourceFile()) &&
    ts.isTypeAliasDeclaration(declaration) &&
    ts.isMappedTypeNode(declaration.type)
  );
}

function rawDictionarySyntax(node) {
  if (!node || !ts.isTypeReferenceNode(node) || node.typeArguments?.length !== 2) return false;
  if (
    node.typeArguments[0].kind !== ts.SyntaxKind.StringKeyword ||
    node.typeArguments[1].kind !== ts.SyntaxKind.UnknownKeyword
  )
    return false;
  return true;
}

function rawDictionaryMember(state, node) {
  if (!rawDictionarySyntax(node)) return false;
  const symbol = state.context.checker.getSymbolAtLocation(node.typeName);
  if (
    !symbol?.declarations?.some((declaration) => standardDictionaryDeclaration(state, declaration))
  )
    return false;
  const type = state.context.checker.getTypeAtLocation(node);
  return Boolean(type.getStringIndexType()?.flags & ts.TypeFlags.Unknown);
}

function rawDictionaryPredicates(state, signature) {
  const predicate = state.callable.type;
  const facts = state.context.checker.getTypePredicateOfSignature(signature);
  if (
    predicate &&
    ts.isTypePredicateNode(predicate) &&
    facts?.kind === ts.TypePredicateKind.Identifier &&
    facts.parameterIndex === state.index &&
    ts.isIdentifier(predicate.parameterName) &&
    state.context.checker.getSymbolAtLocation(predicate.parameterName) === state.parameterSymbol
  ) {
    const members = ts.isIntersectionTypeNode(predicate.type)
      ? predicate.type.types
      : [predicate.type];
    return members.map((node) => ({ node, kind: "predicate-member" }));
  }
  return [];
}

function rawDictionaryAnnotations(state) {
  if (writtenSymbol(state.context, state.nodes, state.parameterSymbol)) return [];
  const parameter = state.callable.parameters[state.index];
  const signature = state.context.checker.getSignatureFromDeclaration(state.callable);
  if (!signature) return [];
  const result = state.context.checker.getReturnTypeOfSignature(signature);
  if ((result.flags & ts.TypeFlags.BooleanLike) === 0) return [];
  const annotations = [{ node: parameter.type, kind: "parameter" }];
  annotations.push(...rawDictionaryPredicates(state, signature));
  return annotations
    .filter(({ node }) => rawDictionaryMember(state, node))
    .map(({ node, kind }) => ({
      ...annotationSlot(state.context, state.source, node, state.identity, kind, state.index),
      rule: "anti-slop/no-unsafe-dictionary-type",
    }));
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
    slots.push(
      ...rawDictionaryAnnotations(state),
      ...rawTypeofSlots(state),
      ...rawPredicateSlots(state, states, qualified),
    );
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

function exportFactKey(request, proof) {
  if (
    request === null ||
    (typeof request !== "object" && typeof request !== "function") ||
    types.isProxy(request)
  )
    return undefined;
  const selectors = ["consumerPath", "specifier", "exportName"].map((name) =>
    Object.getOwnPropertyDescriptor(request, name),
  );
  if (
    !selectors.every(
      (entry) => entry && Object.hasOwn(entry, "value") && typeof entry.value === "string",
    )
  )
    return undefined;
  return JSON.stringify([proof, ...selectors.map((entry) => entry.value)]);
}

function ownedExportSnapshots(compiler) {
  const paths = [...compiler.state.snapshots.keys()].map((absolute) =>
    relative(compiler.state.subject.root, absolute).replaceAll("\\", "/"),
  );
  return paths.filter(
    (path) =>
      path !== ".." &&
      !path.startsWith("../") &&
      (compiler.state.subject.outputs.has(path) ||
        (path.endsWith(".map") && compiler.state.subject.outputs.has(path.slice(0, -4)))),
  );
}

function createExportFactCache(compiler) {
  let entry;
  return {
    resolve: (request, proof = false) => {
      const key = exportFactKey(request, proof);
      if (key !== undefined && entry?.key === key) {
        for (const path of entry.paths) compiler.read(path);
        compiler.assertCurrent();
        return structuredClone(entry.facts);
      }
      const facts = resolveExport(compiler, request, proof);
      if (key !== undefined)
        entry = { key, facts: structuredClone(facts), paths: ownedExportSnapshots(compiler) };
      return structuredClone(facts);
    },
    close: () => {
      entry = undefined;
    },
  };
}

export function createSymbolResolver(subject, options = {}, proofRoots = []) {
  const compiler = createCompilerContext(subject, options, proofRoots);
  const rawSlots = new Map();
  const exportFacts = createExportFactCache(compiler);
  return {
    resolveExport: (request) => exportFacts.resolve(request),
    resolveProofExport: (request) => exportFacts.resolve(request, true),
    resolveProofConsumer: (request) => resolveProofConsumer(compiler, request),
    diagnosticBinding: (request, producer) => diagnosticBinding(compiler, request, producer),
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
    close: () => {
      exportFacts.close();
      compiler.close();
    },
    stats: () => ({
      programs: compiler.state.programs.size,
      created: compiler.state.created,
      sourceBytes: compiler.state.bytes,
      nodes: compiler.state.nodes,
    }),
  };
}
