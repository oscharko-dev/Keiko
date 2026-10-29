import { Buffer } from "node:buffer";
import { types } from "node:util";
import { fileURLToPath } from "node:url";
import { policyDigest, preparedModuleReceipt } from "./code-quality-inventory.mjs";
import { chargeSymbolVisits } from "./code-quality-policy.mjs";
import { compareStrings } from "./compare-strings.mjs";
import { join, relative } from "node:path";
import ts from "typescript";
import { recognizeJsonByteMeasurement } from "./code-quality-json-byte-form.mjs";
import { productionModuleReferences } from "./code-quality-production.mjs";
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

// Only these module-created cardinality refusals may withhold a collective group.
const collectiveHelperBudgetErrors = new WeakMap();
const rawModuleIndexes = new WeakMap();
const rawSourceNodeCaches = new WeakMap();
const rawPrivateOutputBindings = new WeakMap();
const rawDiscoveryKeys = new WeakMap();
const rawDetachedSlots = new WeakMap();

function detachedRawRequestKey(requests) {
  const entries = requests.map(({ identity, index, recordId }) =>
    JSON.stringify({ identity, index, recordId }),
  );
  return JSON.stringify([true, entries.sort(compareStrings)]);
}

function detachedRawResult(compiler, caches, key, compute) {
  compiler.assertCurrent();
  let cache = caches.get(compiler);
  if (!cache) {
    cache = new Map();
    caches.set(compiler, cache);
  }
  if (cache.has(key)) return structuredClone(cache.get(key));
  const result = compute();
  compiler.assertCurrent();
  if (cache.size < compiler.state.limits.aliases) cache.set(key, structuredClone(result));
  return structuredClone(result);
}

function collectiveHelperBudgetError(limit, observedCount) {
  const error = new TypeError("symbol-alias-budget");
  collectiveHelperBudgetErrors.set(error, { limit, observedCount });
  return error;
}

export function collectiveHelperBudgetDetails(error) {
  const details = collectiveHelperBudgetErrors.get(error);
  return details ? { ...details } : null;
}

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

// This describes only literal OWN data in a readonly declared view. It never certifies a
// string-key lookup, inherited values, runtime immutability, or callable/semantic admission.
function intrinsicLiteralLookupType(context, node, name, arity) {
  return Boolean(
    node &&
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === name &&
    node.typeArguments?.length === arity &&
    defaultLibrarySymbol(context, context.checker.getSymbolAtLocation(node.typeName)),
  );
}

function readonlyLiteralValueAnnotation(context, annotation) {
  if (!intrinsicLiteralLookupType(context, annotation, "Readonly", 1)) return null;
  const record = annotation.typeArguments[0];
  if (!intrinsicLiteralLookupType(context, record, "Record", 2)) return null;
  return record.typeArguments[0].kind === ts.SyntaxKind.StringKeyword
    ? record.typeArguments[1]
    : null;
}

function readonlyLiteralDataCandidate(context, symbol, type) {
  if (!symbol.valueDeclaration || !ts.isVariableDeclaration(symbol.valueDeclaration)) return false;
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const index = type.getStringIndexType();
  return Boolean(
    index &&
    finiteStringType(index) &&
    readonlyLiteralValueAnnotation(context, symbol.valueDeclaration.type),
  );
}

function readonlyLiteralDeclaration(node) {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
    ts.isVariableStatement(node.parent.parent) &&
    ts.isSourceFile(node.parent.parent.parent) &&
    exportedDeclaration(node) &&
    Boolean(node.initializer && ts.isObjectLiteralExpression(node.initializer))
  );
}

function readonlyLiteralEntry(property, values) {
  if (!ts.isPropertyAssignment(property)) return null;
  if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) return null;
  const key = property.name.text;
  if (key === "__proto__" || !ts.isStringLiteral(property.initializer)) return null;
  return values.has(property.initializer.text) ? { key, value: property.initializer.text } : null;
}

function readonlyLiteralEntries(compiler, declaration, vocabulary) {
  const entries = [];
  const keys = new Set();
  const values = new Set(vocabulary);
  chargeSymbolVisits(compiler.state, declaration.initializer.properties.length);
  for (const property of declaration.initializer.properties) {
    const entry = readonlyLiteralEntry(property, values);
    if (!entry || keys.has(entry.key)) return null;
    keys.add(entry.key);
    entries.push(entry);
  }
  return entries.length > 0 ? entries : null;
}

function readonlyLiteralDomain(compiler, owned, identity) {
  const annotation = readonlyLiteralValueAnnotation(owned.context, owned.node.type);
  const domain = annotation && typedDomain(compiler, owned.context, annotation);
  return domain?.identity.owner === identity.owner ? domain : null;
}

function readonlyLiteralDataFacts(compiler, symbol, identities) {
  if (identities.length !== 1 || !ts.isVariableDeclaration(symbol.valueDeclaration)) return null;
  // The declaration can be emitted data with no initializer. Resolve the actual owned Source
  // through the existing canonical declaration/provenance mechanism, never callable facts.
  const owned = ownedDeclaration(compiler, identities[0]);
  if (!readonlyLiteralDeclaration(owned.node)) return null;
  const domain = readonlyLiteralDomain(compiler, owned, identities[0]);
  if (!domain) return null;
  const members = domain.type.isUnion() ? domain.type.types : [domain.type];
  chargeSymbolVisits(compiler.state, members.length);
  const vocabulary = members.map((member) => member.value).toSorted(compareStrings);
  const entries = readonlyLiteralEntries(compiler, owned.node, vocabulary);
  if (!entries) return null;
  return {
    origin: "readonly-open-string-literal-data",
    declaration: identities[0],
    valueDomain: domain.identity,
    ownEntries: entries,
    ownValueVocabulary: vocabulary,
    initializer: {
      path: identities[0].producer.path,
      ...nativeDiagnosticPosition(owned.source, owned.node.initializer.getStart()),
      start: owned.node.initializer.getStart(),
      end: owned.node.initializer.end,
    },
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
  const facts = {
    identities,
    type: typeFacts(type),
    signatures: type.getCallSignatures().map((signature) => signatureFacts(context, signature)),
  };
  if (facts.signatures.length === 0 && readonlyLiteralDataCandidate(context, symbol, type)) {
    const literalData = readonlyLiteralDataFacts(compiler, symbol, identities);
    if (literalData) facts.literalData = literalData;
  }
  return facts;
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
  const runtime = path.replace(/\.d\.([cm]?)ts$/u, ".$1js");
  const outputs = compiler.state.subject.outputs;
  if (runtime === path || !outputs.has(path) || outputs.get(runtime) !== outputs.get(path))
    throw new TypeError("unqualified-public-declaration-entry");
  compiler.read(runtime);
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

function publicBindingName(name, requested) {
  if (ts.isIdentifier(name)) return name.text === requested;
  return name.elements.some(
    (element) => ts.isBindingElement(element) && publicBindingName(element.name, requested),
  );
}

function unsupportedExplicitPublicExport(source, name) {
  return source.statements.some((node) => {
    if (ts.isExportDeclaration(node))
      return Boolean(
        node.exportClause &&
        ts.isNamespaceExport(node.exportClause) &&
        node.exportClause.name.text === name,
      );
    if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      return false;
    if (ts.isFunctionDeclaration(node)) return false;
    if (ts.isVariableStatement(node))
      return node.declarationList.declarations.some((entry) => publicBindingName(entry.name, name));
    return node.name && ts.isIdentifier(node.name) && node.name.text === name;
  });
}

function publicStarDeclaration(compiler, context, source, name, seen) {
  let found = null;
  for (const node of source.statements) {
    if (!ts.isExportDeclaration(node) || node.isTypeOnly || node.exportClause) continue;
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier))
      throw new TypeError("unsupported-public-declaration-entry");
    const path = declarationModule(compiler, context, source, node.moduleSpecifier);
    const candidate = publicDeclarationCandidate(compiler, context, path, name, seen);
    if (candidate === null) continue;
    if (found !== null) throw new TypeError("ambiguous-public-declaration-entry");
    found = candidate;
  }
  return found;
}

function publicExplicitDeclaration(compiler, context, source, candidates, seen) {
  const { functions, exports } = candidates;
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

function publicDeclarationCandidate(compiler, context, path, name, seen) {
  if (seen.has(path) || seen.size >= compiler.state.limits.aliases)
    throw new TypeError("symbol-alias-budget");
  seen.add(path);
  const source = publicDeclarationSource(compiler, context, path);
  const candidates = publicExportCandidates(source, name);
  if (unsupportedExplicitPublicExport(source, name))
    throw new TypeError("unsupported-public-declaration-entry");
  if (candidates.functions.length === 0 && candidates.exports.length === 0)
    return publicStarDeclaration(compiler, context, source, name, seen);
  return publicExplicitDeclaration(compiler, context, source, candidates, seen);
}

function publicDeclaration(compiler, context, path, name, seen) {
  const result = publicDeclarationCandidate(compiler, context, path, name, seen);
  if (result === null) throw new TypeError("unsupported-public-declaration-entry");
  return result;
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

function resolveProofConsumer(compiler, request, proof = true) {
  const { context, source } = ownedSource(compiler, request.consumerPath, proof);
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

function arrayDiagnosticBinding(compiler, request, producer) {
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

function diagnosticBinding(compiler, request, producer) {
  const legacy = arrayDiagnosticBinding(compiler, request, producer);
  if (legacy.bound) return legacy;
  return envelopeDiagnosticBinding(compiler, request, producer) ?? legacy;
}

function diagnosticEnvelopeAssignment(callable) {
  const [assignment, returned] = callable.body.statements;
  if (
    !ts.isVariableStatement(assignment) ||
    assignment.declarationList.flags !== ts.NodeFlags.Const ||
    assignment.declarationList.declarations.length !== 1 ||
    !ts.isReturnStatement(returned) ||
    !returned.expression ||
    !ts.isConditionalExpression(returned.expression)
  )
    return null;
  return { local: assignment.declarationList.declarations[0], result: returned.expression };
}

function diagnosticOkCondition(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "ok" &&
    ts.isIdentifier(node.expression)
  );
}

function diagnosticReasonsLength(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "length" &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "reasons" &&
    ts.isIdentifier(node.expression.expression)
  );
}

function numericDiagnosticWitness(callable) {
  return callable.type?.kind === ts.SyntaxKind.NumberKeyword;
}

function diagnosticEnvelopeResult(callable) {
  if (!numericDiagnosticWitness(callable)) return null;
  const assignment = diagnosticEnvelopeAssignment(callable);
  if (!assignment) return null;
  const { local, result } = assignment;
  if (
    !ts.isIdentifier(local.name) ||
    local.type ||
    !directDiagnosticCall(local.initializer) ||
    !diagnosticOkCondition(result.condition) ||
    !ts.isNumericLiteral(result.whenTrue) ||
    result.whenTrue.text !== "0" ||
    !diagnosticReasonsLength(result.whenFalse)
  )
    return null;
  return { local, call: local.initializer, result };
}

function sameDiagnosticEnvelopeFlow(context, callable, result) {
  const symbol = context.checker.getSymbolAtLocation(result.local.name);
  return (
    context.checker.getSymbolAtLocation(result.call.arguments[0]) ===
      context.checker.getSymbolAtLocation(callable.parameters[0].name) &&
    context.checker.getSymbolAtLocation(result.result.condition.expression) === symbol &&
    context.checker.getSymbolAtLocation(result.result.whenFalse.expression.expression) === symbol
  );
}

function readonlyEnvelopeFields(type) {
  return type.getProperties().every((property) => {
    const declarations = property.declarations ?? [];
    return (
      declarations.length === 1 &&
      ts.isPropertySignature(declarations[0]) &&
      (ts.getCombinedModifierFlags(declarations[0]) & ts.ModifierFlags.Readonly) !== 0
    );
  });
}

function diagnosticFailureArm(context, type, call) {
  return (
    requiredParserFields(type, ["ok", "reasons"]) &&
    intrinsicParserErrors(context, parserProperty(context, type, "reasons", call))
  );
}

function diagnosticEnvelopeArm(context, type, call) {
  const ok = parserProperty(context, type, "ok", call);
  if (!ok || (ok.flags & ts.TypeFlags.BooleanLiteral) === 0 || !readonlyEnvelopeFields(type))
    return null;
  if (ok.intrinsicName === "true" && requiredParserFields(type, ["ok"])) return "success";
  if (ok.intrinsicName === "false" && diagnosticFailureArm(context, type, call)) return "failure";
  return null;
}

function closedDiagnosticEnvelope(compiler, context, call) {
  const signature = parserSignature(context, call);
  if (!signature?.declaration?.type) return false;
  const type = producerParserResult(compiler, context, signature.declaration, signature);
  if (!type?.isUnion() || type.types.length !== 2) return false;
  const arms = new Set(type.types.map((arm) => diagnosticEnvelopeArm(context, arm, call)));
  return arms.has("success") && arms.has("failure");
}

function envelopeDiagnosticBinding(compiler, request, producer) {
  const { context, source } = ownedSource(compiler, request.consumerPath, true);
  const callable = diagnosticCallable(context, source, request.exportName);
  const result = callable && diagnosticEnvelopeResult(callable);
  if (!result) return null;
  const bound =
    parserImport(context, result.call, request.specifier) &&
    directDiagnosticProducer(compiler, context, result.call, producer) &&
    sameDiagnosticEnvelopeFlow(context, callable, result) &&
    closedDiagnosticEnvelope(compiler, context, result.call);
  compiler.assertCurrent();
  return {
    bound,
    implementation: canonicalDeclaration(compiler, callable, null),
    calls: [{ path: request.consumerPath, start: result.call.getStart(), end: result.call.end }],
  };
}

function parserCallable(context, source, name) {
  const callable = diagnosticCallable(context, source, name);
  if (
    !callable?.type ||
    callable.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return null;
  return callable;
}

function parserResult(callable) {
  const [assignment, returned] = callable.body.statements;
  if (
    !ts.isVariableStatement(assignment) ||
    assignment.declarationList.flags !== ts.NodeFlags.Const ||
    assignment.declarationList.declarations.length !== 1 ||
    !ts.isReturnStatement(returned) ||
    !returned.expression ||
    !ts.isIdentifier(returned.expression)
  )
    return null;
  const local = assignment.declarationList.declarations[0];
  if (!ts.isIdentifier(local.name) || local.type || !directDiagnosticCall(local.initializer))
    return null;
  return { local, call: local.initializer, result: returned.expression };
}

function parserImport(context, call, specifier) {
  const symbol = context.checker.getSymbolAtLocation(call.expression);
  const imported = symbol?.declarations?.[0];
  if (!imported || !ts.isImportSpecifier(imported)) return false;
  const statement = imported.parent.parent.parent;
  return ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === specifier;
}

function sameParserFlow(context, callable, result) {
  return (
    context.checker.getSymbolAtLocation(result.call.arguments[0]) ===
      context.checker.getSymbolAtLocation(callable.parameters[0].name) &&
    context.checker.getSymbolAtLocation(result.result) ===
      context.checker.getSymbolAtLocation(result.local.name)
  );
}

function parserSignature(context, call) {
  const signature = context.checker.getResolvedSignature(call);
  if (!signature || signature.typeParameters?.length || signature.parameters.length !== 1)
    return null;
  if (!requiredUnknownParserParameter(context, signature.parameters[0])) return null;
  const signatures = context.checker.getTypeAtLocation(call.expression).getCallSignatures();
  return signatures.length === 1 && canonicalParserSignature(context, signatures[0])
    ? signature
    : null;
}

function canonicalParserSignature(context, signature) {
  const declaration = signature.declaration;
  return Boolean(
    declaration &&
    !declaration.typeParameters?.length &&
    !signature.typeParameters?.length &&
    !signature.thisParameter &&
    declaration.parameters.length === 1 &&
    requiredUnknownParserParameter(context, signature.parameters[0]),
  );
}

function requiredUnknownParserParameter(context, parameter) {
  const declaration = parameter.valueDeclaration;
  return Boolean(
    declaration &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text !== "this" &&
    !declaration.questionToken &&
    !declaration.initializer &&
    !declaration.dotDotDotToken &&
    typeFacts(context.checker.getTypeOfSymbolAtLocation(parameter, declaration)).kind === "unknown",
  );
}

function requiredParserFields(type, names) {
  const properties = type.getProperties();
  return (
    properties.length === names.length &&
    properties.every(
      (property) =>
        names.includes(property.name) && (property.flags & ts.SymbolFlags.Optional) === 0,
    ) &&
    typeIndexes(type).length === 0
  );
}

function parserProperty(context, type, name, call) {
  const property = type.getProperty(name);
  return property && context.checker.getTypeOfSymbolAtLocation(property, call);
}

function parserArm(context, type, call) {
  const ok = parserProperty(context, type, "ok", call);
  if (!ok || (ok.flags & ts.TypeFlags.BooleanLiteral) === 0) return null;
  if (ok.intrinsicName === "true" && requiredParserFields(type, ["ok", "value"])) return "success";
  if (ok.intrinsicName === "false" && parserFailureField(type) !== null) return "failure";
  return null;
}

function parserFailureField(type) {
  return ["errors", "reasons"].find((name) => requiredParserFields(type, ["ok", name])) ?? null;
}

function intrinsicParserErrors(context, type) {
  if (!context.checker.isArrayType(type) || type.symbol?.name !== "ReadonlyArray") return false;
  if (
    !type.symbol.declarations?.every((declaration) =>
      context.program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    )
  )
    return false;
  const args = context.checker.getTypeArguments(type);
  return args.length === 1 && (args[0].flags & ts.TypeFlags.String) !== 0;
}

function validParserFailure(context, failure, call) {
  if (!failure) return false;
  const field = parserFailureField(failure);
  return (
    field !== null && intrinsicParserErrors(context, parserProperty(context, failure, field, call))
  );
}

function parserEnvelope(context, type, call) {
  if (!type.isUnion() || type.types.length !== 2) return { status: "incomplete" };
  const success = type.types.find((arm) => parserArm(context, arm, call) === "success");
  const failure = type.types.find((arm) => parserArm(context, arm, call) === "failure");
  if (!success || !failure || !validParserFailure(context, failure, call))
    return { status: "incomplete" };
  const value = typeFacts(parserProperty(context, success, "value", call));
  const unsafe =
    ["unknown", "any"].includes(value.kind) ||
    value.containsUnknown ||
    value.indexes?.some((index) => ["unknown", "any"].includes(index.kind));
  return { status: unsafe ? "invalid" : "ready", value };
}

function producerParserResult(compiler, context, callable, signature) {
  const type = context.checker.getReturnTypeOfSignature(signature);
  const annotation = context.checker.getTypeAtLocation(callable.type);
  if (!type.aliasSymbol || annotation !== type || annotation.aliasSymbol !== type.aliasSymbol)
    return null;
  const declarations = type.aliasSymbol.declarations ?? [];
  if (declarations.length !== 1) return null;
  const identity = canonicalDeclaration(compiler, declarations[0], null);
  const producer = canonicalDeclaration(compiler, signature.declaration, null);
  const file = compiler.state.subject.inventory.files.find(
    (entry) => entry.path === identity.producer.path,
  );
  return identity.owner === producer.owner && file?.production ? type : null;
}

function parserBinding(compiler, request, producer) {
  const { context, source } = ownedSource(compiler, request.consumerPath, true);
  const callable = parserCallable(context, source, request.exportName);
  const result = callable && parserResult(callable);
  if (
    !result ||
    !parserImport(context, result.call, request.specifier) ||
    !directDiagnosticProducer(compiler, context, result.call, producer) ||
    !sameParserFlow(context, callable, result)
  )
    return { bound: false, status: "incomplete" };
  const signature = parserSignature(context, result.call);
  const type = signature && producerParserResult(compiler, context, callable, signature);
  if (!type) return { bound: false, status: "incomplete" };
  const envelope = parserEnvelope(context, type, result.call);
  compiler.assertCurrent();
  return {
    ...envelope,
    bound: envelope.status === "ready",
    implementation: canonicalDeclaration(compiler, callable, null),
    calls: [{ path: request.consumerPath, start: result.call.getStart(), end: result.call.end }],
  };
}

function typedRequiredParameter(parameter) {
  return Boolean(
    parameter?.type &&
    ts.isIdentifier(parameter.name) &&
    parameter.name.text !== "this" &&
    !parameter.questionToken &&
    !parameter.initializer &&
    !parameter.dotDotDotToken,
  );
}

function typedFunctionDeclaration(callable) {
  return Boolean(callable && ts.isFunctionDeclaration(callable) && callable.name && callable.body);
}

function typedCallableShape(callable) {
  if (!typedFunctionDeclaration(callable)) return false;
  return Boolean(
    callable.type &&
    !callable.typeParameters?.length &&
    !callable.asteriskToken &&
    !callable.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    callable.parameters.length &&
    callable.parameters.every(typedRequiredParameter),
  );
}

function typedSingleSignature(signature) {
  return Boolean(
    signature &&
    !signature.typeParameters?.length &&
    !signature.thisParameter &&
    signature.declaration &&
    !signature.declaration.typeParameters?.length &&
    signature.declaration.parameters.every(typedRequiredParameter),
  );
}

function typedNamedCallable(context, callable) {
  if (!typedCallableShape(callable)) return null;
  const symbol = context.checker.getSymbolAtLocation(callable.name);
  const signatures =
    symbol && context.checker.getTypeOfSymbolAtLocation(symbol, callable).getCallSignatures();
  return symbol?.declarations?.length === 1 &&
    signatures?.length === 1 &&
    typedSingleSignature(signatures[0])
    ? signatures[0]
    : null;
}

function finiteStringType(type) {
  const members = type.isUnion() ? type.types : [type];
  return (
    members.length > 0 &&
    members.every((member) => (member.flags & ts.TypeFlags.StringLiteral) !== 0)
  );
}

function typedDomainAlias(compiler, context, annotation) {
  if (
    !annotation ||
    !ts.isTypeReferenceNode(annotation) ||
    !ts.isIdentifier(annotation.typeName) ||
    annotation.typeArguments?.length
  )
    return null;
  const symbol = context.checker.getSymbolAtLocation(annotation.typeName);
  if (!symbol) return null;
  const target = qualifiedAlias(context, symbol, compiler.state.limits.aliases);
  return { symbol, target };
}

function typedDomainDeclaration(target) {
  const declaration = target.declarations?.length === 1 && target.declarations[0];
  return declaration &&
    ts.isTypeAliasDeclaration(declaration) &&
    !declaration.typeParameters?.length
    ? declaration
    : null;
}

function typedDomain(compiler, context, annotation) {
  const alias = typedDomainAlias(compiler, context, annotation);
  const declaration = alias && typedDomainDeclaration(alias.target);
  if (!declaration) return null;
  const type = context.checker.getTypeAtLocation(annotation);
  if (!finiteStringType(type)) return null;
  const identity = canonicalDeclaration(compiler, declaration, null);
  const file = compiler.state.subject.inventory.files.find(
    (entry) => entry.path === identity.producer.path,
  );
  return file?.production ? { type, identity, symbol: alias.symbol } : null;
}

function typedPredicateCall(call) {
  return (
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    !call.typeArguments?.length &&
    call.arguments.length === 1 &&
    ts.isIdentifier(call.arguments[0])
  );
}

function typedPredicateDeclaration(owned, call) {
  const symbol = owned.context.checker.getSymbolAtLocation(call.expression);
  const declaration = symbol?.valueDeclaration;
  return symbol?.declarations?.length === 1 &&
    declaration &&
    ts.isFunctionDeclaration(declaration) &&
    declaration.getSourceFile() === owned.source &&
    declaration.parameters.length === 1
    ? declaration
    : null;
}

function typedIdentifierPredicate(context, declaration, signature) {
  const predicate = context.checker.getTypePredicateOfSignature(signature);
  return predicate?.kind === ts.TypePredicateKind.Identifier &&
    predicate.parameterIndex === 0 &&
    ts.isTypePredicateNode(declaration.type) &&
    ts.isIdentifier(declaration.type.parameterName)
    ? predicate
    : null;
}

function typedDirectPredicate(compiler, owned, call) {
  if (!typedPredicateCall(call)) return null;
  const declaration = typedPredicateDeclaration(owned, call);
  const signature = declaration && typedNamedCallable(owned.context, declaration);
  if (
    !signature ||
    owned.context.checker.getResolvedSignature(call) !== signature ||
    !requiredUnknownParserParameter(owned.context, signature.parameters[0])
  )
    return null;
  const predicate = typedIdentifierPredicate(owned.context, declaration, signature);
  const domain = predicate && typedDomain(compiler, owned.context, declaration.type.type);
  return domain && predicate.type === domain.type
    ? {
        domain,
        identity: canonicalDeclaration(compiler, declaration, null),
      }
    : null;
}

function typedNegativeCalls(expression) {
  expression = rawParentheses(expression);
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isCallExpression(expression.operand)
  )
    return [expression.operand];
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
  ) {
    const left = typedNegativeCalls(expression.left);
    const right = typedNegativeCalls(expression.right);
    return left && right ? [...left, ...right] : null;
  }
  return null;
}

function typedAndParts(expression) {
  expression = rawParentheses(expression);
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ? [...typedAndParts(expression.left), ...typedAndParts(expression.right)]
    : [expression];
}

function typedRefusal(statement) {
  if (ts.isBlock(statement) && statement.statements.length === 1)
    [statement] = statement.statements;
  return (
    ts.isReturnStatement(statement) &&
    statement.expression &&
    (statement.expression.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isArrayLiteralExpression(statement.expression) &&
        statement.expression.elements.length === 0))
  );
}

function typedIfGuard(statements) {
  return (
    statements.length === 2 &&
    ts.isIfStatement(statements[0]) &&
    !statements[0].elseStatement &&
    typedRefusal(statements[0].thenStatement) &&
    ts.isReturnStatement(statements[1]) &&
    statements[1].expression
  );
}

function typedGuardCalls(callable) {
  const statements = callable.body.statements;
  if (typedIfGuard(statements)) return typedNegativeCalls(statements[0].expression);
  if (statements.length !== 1 || !ts.isReturnStatement(statements[0]) || !statements[0].expression)
    return null;
  const parts = typedAndParts(statements[0].expression);
  return parts.length > 1 && parts.slice(0, -1).every(ts.isCallExpression)
    ? parts.slice(0, -1)
    : null;
}

function typedParameterDomains(compiler, owned, signature) {
  return owned.callable.parameters.map((parameter, index) => {
    const domain = typedDomain(compiler, owned.context, parameter.type);
    if (
      !domain ||
      domain.identity.owner !== owned.identity.owner ||
      domain.identity.producer.path !== owned.identity.producer.path ||
      signature.parameters[index]?.valueDeclaration !== parameter
    )
      throw new TypeError("unsupported-typed-recheck-domain");
    return {
      ...domain,
      parameter,
      symbol: owned.context.checker.getSymbolAtLocation(parameter.name),
    };
  });
}

function typedGuardWitness(compiler, owned, domains) {
  const calls = typedGuardCalls(owned.callable);
  if (!calls?.length) throw new TypeError("unsupported-typed-recheck-guard");
  return calls.map((call) => {
    const predicate = typedDirectPredicate(compiler, owned, call);
    const symbol = owned.context.checker.getSymbolAtLocation(call.arguments[0]);
    const parameter = domains.find((domain) => domain.symbol === symbol);
    if (
      !predicate ||
      !parameter ||
      !sameProducer(predicate.domain.identity, parameter.identity) ||
      predicate.domain.type !== parameter.type
    )
      throw new TypeError("unsupported-typed-recheck-predicate");
    return { call, parameter, predicate };
  });
}

function typedReadonlyArray(context, type) {
  return (
    context.checker.isArrayType(type) &&
    type.symbol?.name === "ReadonlyArray" &&
    type.symbol.declarations?.every((declaration) =>
      context.program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    )
  );
}

function typedStableReceiver(context, expression) {
  if (ts.isElementAccessExpression(expression))
    return typedStableReceiver(context, expression.expression);
  if (!ts.isIdentifier(expression)) return false;
  const declaration = context.checker.getSymbolAtLocation(expression)?.valueDeclaration;
  return Boolean(
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.parent.flags === ts.NodeFlags.Const &&
    declaration.parent.parent.parent === declaration.getSourceFile(),
  );
}

function typedIncludesCall(node) {
  const call = node.parent;
  return ts.isCallExpression(call) &&
    call.arguments.length === 1 &&
    call.arguments[0] === node &&
    !call.typeArguments?.length &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "includes"
    ? call
    : null;
}

function typedIncludesUse(owned, domain, node) {
  const call = typedIncludesCall(node);
  if (!call || !typedStableReceiver(owned.context, call.expression.expression)) return false;
  const receiver = owned.context.checker.getTypeAtLocation(call.expression.expression);
  const member = owned.context.checker.getSymbolAtLocation(call.expression.name);
  const element =
    typedReadonlyArray(owned.context, receiver) &&
    owned.context.checker.getTypeArguments(receiver)[0];
  return Boolean(
    element === domain.type &&
    member?.declarations?.length &&
    member.declarations.every((declaration) =>
      owned.context.program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    ),
  );
}

function typedTableUse(owned, domain, node) {
  const access = node.parent;
  if (
    !ts.isElementAccessExpression(access) ||
    access.argumentExpression !== node ||
    !typedStableReceiver(owned.context, access.expression)
  )
    return false;
  const type = owned.context.checker.getTypeAtLocation(access.expression);
  const members = domain.type.isUnion() ? domain.type.types : [domain.type];
  return (
    !type.getStringIndexType() &&
    !type.getNumberIndexType() &&
    members.every((member) => {
      const property = type.getProperty(member.value);
      return (
        property &&
        (property.flags & ts.SymbolFlags.Optional) === 0 &&
        !rawErasure(owned.context, access)
      );
    })
  );
}

function typedParameterUses(owned, nodes, domain, witness) {
  const uses = nodes.filter(
    (node) =>
      ts.isIdentifier(node) &&
      node.getStart() >= owned.callable.body.getStart() &&
      node.end <= owned.callable.body.end &&
      owned.context.checker.getSymbolAtLocation(node) === domain.symbol,
  );
  if (writtenSymbol(owned.context, nodes, domain.symbol)) return false;
  return uses.every(
    (node) =>
      directRawBody(node, owned.callable) &&
      (witness.some(({ call }) => call.arguments[0] === node) ||
        typedIncludesUse(owned, domain, node) ||
        typedTableUse(owned, domain, node)),
  );
}

function typedEntryResult(compiler, owned, signature, domain) {
  const annotation = owned.callable.type;
  const type = owned.context.checker.getReturnTypeOfSignature(signature);
  if (annotation.kind === ts.SyntaxKind.BooleanKeyword)
    return (type.flags & ts.TypeFlags.Boolean) !== 0;
  if (
    !ts.isTypeOperatorNode(annotation) ||
    annotation.operator !== ts.SyntaxKind.ReadonlyKeyword ||
    !ts.isArrayTypeNode(annotation.type) ||
    !typedReadonlyArray(owned.context, type)
  )
    return false;
  const element = typedDomain(compiler, owned.context, annotation.type.elementType);
  return (
    element &&
    sameProducer(element.identity, domain.identity) &&
    owned.context.checker.getTypeArguments(type)[0] === domain.type
  );
}

function typedRecheckFacts(compiler, identity, index) {
  const owned = { ...declarationCallable(compiler, identity), identity };
  const signature = typedNamedCallable(owned.context, owned.callable);
  if (!signature || !exportedDeclaration(owned.callable))
    throw new TypeError("unsupported-typed-recheck-entry");
  const domains = typedParameterDomains(compiler, owned, signature);
  const domain = domains[index];
  if (!domain || !typedEntryResult(compiler, owned, signature, domain))
    throw new TypeError("unsupported-typed-recheck-parameter");
  const witness = typedGuardWitness(compiler, owned, domains);
  const selected = witness.filter((entry) => entry.parameter.symbol === domain.symbol);
  if (selected.length !== 1) throw new TypeError("ambiguous-typed-recheck-guard");
  const nodes = sourceNodes(compiler, owned.source);
  if (!typedParameterUses(owned, nodes, domain, witness))
    throw new TypeError("unsupported-typed-recheck-use");
  const entry = selected[0];
  const argument = entry.call.arguments[0];
  return {
    producer: identity,
    predicate: entry.predicate.identity,
    slots: [
      {
        kind: "argument",
        path: identity.producer.path,
        rule: "anti-slop/no-known-value-widening",
        ...nativeDiagnosticPosition(owned.source, argument.getStart()),
        start: argument.getStart(),
        end: argument.end,
        parameterIndex: index,
        origin: { kind: "typed-parameter-recheck", index },
      },
    ],
  };
}

function constAssignmentAndIdentifierReturn(assignment, returned) {
  return (
    ts.isVariableStatement(assignment) &&
    assignment.declarationList.flags === ts.NodeFlags.Const &&
    assignment.declarationList.declarations.length === 1 &&
    ts.isReturnStatement(returned) &&
    returned.expression &&
    ts.isIdentifier(returned.expression)
  );
}

function typedForwardCall(call) {
  return (
    call &&
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    !call.typeArguments?.length &&
    call.arguments.every(ts.isIdentifier)
  );
}

function typedForwardResult(callable) {
  if (callable.body.statements.length !== 2) return null;
  const [assignment, returned] = callable.body.statements;
  if (!constAssignmentAndIdentifierReturn(assignment, returned)) return null;
  const local = assignment.declarationList.declarations[0];
  const call = local.initializer;
  return ts.isIdentifier(local.name) && !local.type && typedForwardCall(call)
    ? { local, call, returned: returned.expression }
    : null;
}

function typedImportedDomain(compiler, context, annotation, specifier) {
  const domain = typedDomain(compiler, context, annotation);
  const imported = domain?.symbol.declarations?.[0];
  if (!domain || !ts.isImportSpecifier(imported)) return null;
  const statement = imported.parent.parent.parent;
  return ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === specifier
    ? domain
    : null;
}

function typedProofParameters(compiler, context, callable, signature, request) {
  if (callable.parameters.length !== signature.parameters.length) return false;
  return callable.parameters.every((parameter, index) => {
    const domain = typedImportedDomain(compiler, context, parameter.type, request.specifier);
    const actual = signature.parameters[index]?.valueDeclaration;
    const expected = actual && typedDomain(compiler, context, actual.type);
    return (
      domain &&
      expected &&
      sameProducer(domain.identity, expected.identity) &&
      domain.type === expected.type
    );
  });
}

function typedForwardType(compiler, context, annotation, expected, specifier) {
  if (annotation.kind === ts.SyntaxKind.BooleanKeyword)
    return (
      (expected.flags & ts.TypeFlags.Boolean) !== 0 &&
      context.checker.getTypeAtLocation(annotation) === expected
    );
  if (
    !ts.isTypeOperatorNode(annotation) ||
    annotation.operator !== ts.SyntaxKind.ReadonlyKeyword ||
    !ts.isArrayTypeNode(annotation.type) ||
    !typedReadonlyArray(context, expected)
  )
    return false;
  const domain = typedImportedDomain(compiler, context, annotation.type.elementType, specifier);
  return (
    domain &&
    context.checker.getTypeArguments(expected)[0] === domain.type &&
    context.checker.getTypeAtLocation(annotation) === expected
  );
}

function typedForwardArguments(context, callable, flow) {
  return (
    flow.call.arguments.length === callable.parameters.length &&
    flow.call.arguments.every(
      (argument, index) =>
        context.checker.getSymbolAtLocation(argument) ===
        context.checker.getSymbolAtLocation(callable.parameters[index].name),
    ) &&
    context.checker.getSymbolAtLocation(flow.returned) ===
      context.checker.getSymbolAtLocation(flow.local.name)
  );
}

function typedPublicForward(compiler, context, callable, flow, request) {
  const signatures = context.checker.getTypeAtLocation(flow.call.expression).getCallSignatures();
  const signature = context.checker.getResolvedSignature(flow.call);
  return (
    signatures.length === 1 &&
    typedSingleSignature(signature) &&
    typedProofParameters(compiler, context, callable, signature, request) &&
    typedForwardArguments(context, callable, flow) &&
    typedForwardType(
      compiler,
      context,
      callable.type,
      context.checker.getReturnTypeOfSignature(signature),
      request.specifier,
    )
  );
}

function typedRecheckBinding(compiler, request, producer) {
  const { context, source } = ownedSource(compiler, request.consumerPath, true);
  const module = context.checker.getSymbolAtLocation(source);
  const symbol = context.checker
    .getExportsOfModule(module)
    .find((entry) => entry.name === request.exportName);
  const callable = symbol?.declarations?.length === 1 ? symbol.declarations[0] : null;
  const ownSignature = callable && typedNamedCallable(context, callable);
  const flow = ownSignature && typedForwardResult(callable);
  if (
    !flow ||
    !parserImport(context, flow.call, request.specifier) ||
    !directDiagnosticProducer(compiler, context, flow.call, producer) ||
    !typedPublicForward(compiler, context, callable, flow, request)
  )
    return { bound: false, status: "incomplete" };
  return {
    bound: true,
    status: "ready",
    implementation: canonicalDeclaration(compiler, callable, null),
    calls: [{ path: request.consumerPath, start: flow.call.getStart(), end: flow.call.end }],
  };
}

function decoderNamedDeclaration(callable) {
  if (!callable || !ts.isFunctionDeclaration(callable) || !callable.name || !callable.type)
    return false;
  return (
    !callable.typeParameters?.length &&
    !callable.asteriskToken &&
    !callable.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

function decoderPrimitiveDeclaration(callable, parameters, result) {
  return (
    decoderNamedDeclaration(callable) &&
    callable.type.kind === result &&
    callable.parameters.length === parameters.length &&
    callable.parameters.every(
      (parameter, index) =>
        typedRequiredParameter(parameter) && parameter.type.kind === parameters[index],
    )
  );
}

function decoderPrimitiveSignature(context, callable, parameters, result) {
  if (!decoderPrimitiveDeclaration(callable, parameters, result)) return false;
  const symbol = context.checker.getSymbolAtLocation(callable.name);
  const signatures =
    symbol && context.checker.getTypeOfSymbolAtLocation(symbol, callable).getCallSignatures();
  return (
    symbol?.declarations?.length === 1 &&
    signatures?.length === 1 &&
    typedSingleSignature(signatures[0])
  );
}

function decoderSameSymbol(context, left, right) {
  if (!left || !right || !ts.isIdentifier(left) || !ts.isIdentifier(right)) return false;
  const symbol = context.checker.getSymbolAtLocation(left);
  return Boolean(symbol && symbol === context.checker.getSymbolAtLocation(right));
}

function decoderParameter(state, expression, index) {
  return decoderSameSymbol(state.context, expression, state.callable.parameters[index].name);
}

function decoderOwnedFunction(context, symbol, declaration, count) {
  const signatures = context.checker
    .getTypeOfSymbolAtLocation(symbol, declaration)
    .getCallSignatures();
  return Boolean(
    decoderNamedDeclaration(declaration) &&
    declaration.body &&
    declaration.parameters.length === count &&
    declaration.parameters.every(typedRequiredParameter) &&
    symbol.declarations.length === 1 &&
    signatures.length === 1 &&
    typedSingleSignature(signatures[0]),
  );
}

function decoderOwnedCall(state, call, name, count) {
  if (!typedForwardCall(call) || call.arguments.length !== count) return null;
  const symbol = state.context.checker.getSymbolAtLocation(call.expression);
  const declaration = symbol?.valueDeclaration;
  return declaration &&
    ts.isFunctionDeclaration(declaration) &&
    declaration.name?.text === name &&
    declaration.getSourceFile() === state.source &&
    decoderOwnedFunction(state.context, symbol, declaration, count)
    ? declaration
    : null;
}

function decoderErrorArguments(value, reason) {
  return (
    !value.typeArguments?.length &&
    value.arguments?.length === 1 &&
    ts.isStringLiteral(value.arguments[0]) &&
    value.arguments[0].text === reason
  );
}

function decoderErrorConstructor(state, value) {
  const declaration = state.context.checker.getSymbolAtLocation(value.expression)?.valueDeclaration;
  return Boolean(
    declaration &&
    ts.isClassDeclaration(declaration) &&
    declaration.getSourceFile() === state.source &&
    declaration.name?.text === "SupportReportError",
  );
}

function decoderErrorExpression(state, value, reason) {
  return Boolean(
    value &&
    ts.isNewExpression(value) &&
    ts.isIdentifier(value.expression) &&
    decoderErrorArguments(value, reason) &&
    decoderErrorConstructor(state, value),
  );
}

function decoderError(state, statement, reason) {
  return (
    ts.isThrowStatement(statement) && decoderErrorExpression(state, statement.expression, reason)
  );
}

function decoderBudgetThrow(state, statement) {
  if (!ts.isThrowStatement(statement)) return false;
  const declaration = decoderOwnedCall(state, statement.expression, "budgetExceeded", 0);
  return Boolean(
    declaration?.body.statements.length === 1 &&
    ts.isReturnStatement(declaration.body.statements[0]) &&
    decoderErrorExpression(
      state,
      declaration.body.statements[0].expression,
      "report-budget-exceeded",
    ),
  );
}

function decoderGreaterLimit(state, expression) {
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
    decoderParameter(state, expression.right, 1)
  );
}

function decoderTextLength(state, expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "length" &&
    decoderParameter(state, expression.expression, 0)
  );
}

function decoderDefaultValue(context, expression, name) {
  const symbol = context.checker.getSymbolAtLocation(expression);
  const declaration = symbol?.valueDeclaration;
  return (
    ts.isIdentifier(expression) &&
    expression.text === name &&
    Boolean(declaration) &&
    context.program.isSourceFileDefaultLibrary(declaration.getSourceFile())
  );
}

function decoderBuiltinEncoder(state, construct) {
  return (
    ts.isNewExpression(construct) &&
    !construct.typeArguments?.length &&
    (construct.arguments?.length ?? 0) === 0 &&
    decoderDefaultValue(state.context, construct.expression, "TextEncoder")
  );
}

function decoderEncodingCall(state, call) {
  if (
    !ts.isCallExpression(call) ||
    call.typeArguments?.length ||
    call.arguments.length !== 1 ||
    !decoderParameter(state, call.arguments[0], 0)
  )
    return false;
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "encode" &&
    decoderBuiltinEncoder(state, call.expression.expression)
  );
}

function decoderByteLength(state, expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "byteLength" &&
    decoderEncodingCall(state, expression.expression)
  );
}

function decoderBudgetGuard(state, statement) {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const expression = statement.expression;
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
    decoderGreaterLimit(state, expression.left) &&
    decoderGreaterLimit(state, expression.right) &&
    decoderTextLength(state, expression.left.left) &&
    decoderByteLength(state, expression.right.left) &&
    decoderBudgetThrow(state, statement.thenStatement)
  );
}

function decoderShapePreflight(state, statement) {
  if (!ts.isExpressionStatement(statement)) return false;
  const call = statement.expression;
  const declaration = decoderOwnedCall(state, call, "checkJsonShape", 1);
  return Boolean(
    declaration &&
    decoderParameter(state, call.arguments[0], 0) &&
    decoderPrimitiveSignature(
      state.context,
      declaration,
      [ts.SyntaxKind.StringKeyword],
      ts.SyntaxKind.VoidKeyword,
    ),
  );
}

function decoderRawLocal(statement) {
  if (
    !ts.isVariableStatement(statement) ||
    statement.declarationList.flags !== ts.NodeFlags.Let ||
    statement.declarationList.declarations.length !== 1
  )
    return null;
  const local = statement.declarationList.declarations[0];
  return ts.isIdentifier(local.name) &&
    !local.initializer &&
    local.type?.kind === ts.SyntaxKind.UnknownKeyword
    ? local
    : null;
}

function decoderBuiltinJsonTarget(state, target) {
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === "parse" &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "JSON" &&
    defaultLibrarySymbol(
      state.context,
      state.context.checker.getSymbolAtLocation(target.expression),
    ) &&
    defaultLibrarySymbol(state.context, state.context.checker.getSymbolAtLocation(target.name))
  );
}

function decoderBuiltinParse(state, call) {
  return (
    ts.isCallExpression(call) &&
    !call.typeArguments?.length &&
    call.arguments.length === 1 &&
    decoderParameter(state, call.arguments[0], 0) &&
    decoderBuiltinJsonTarget(state, call.expression)
  );
}

function decoderJsonAssignment(state, statement, local) {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression))
    return false;
  const assignment = statement.expression;
  return (
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    decoderSameSymbol(state.context, assignment.left, local.name) &&
    decoderBuiltinParse(state, assignment.right)
  );
}

function decoderCatch(state, caught) {
  return Boolean(
    caught &&
    !caught.variableDeclaration &&
    caught.block.statements.length === 1 &&
    decoderError(state, caught.block.statements[0], "corrupt-report"),
  );
}

function decoderTryAssignment(state, statement, local) {
  return (
    ts.isTryStatement(statement) &&
    !statement.finallyBlock &&
    statement.tryBlock.statements.length === 1 &&
    decoderJsonAssignment(state, statement.tryBlock.statements[0], local) &&
    decoderCatch(state, statement.catchClause)
  );
}

function decoderCanonicalCall(state, call, local, canonicalizer) {
  if (
    !typedForwardCall(call) ||
    call.arguments.length !== 1 ||
    !decoderSameSymbol(state.context, call.arguments[0], local.name)
  )
    return false;
  const declaration = state.context.checker.getSymbolAtLocation(call.expression)?.valueDeclaration;
  return Boolean(
    declaration &&
    declaration.getSourceFile() === state.source &&
    sameProducer(canonicalDeclaration(state.compiler, declaration, null), canonicalizer),
  );
}

function decoderCanonicalGuard(state, statement, local, canonicalizer) {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const expression = statement.expression;
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    decoderParameter(state, expression.right, 0) &&
    decoderCanonicalCall(state, expression.left, local, canonicalizer) &&
    decoderError(state, statement.thenStatement, "corrupt-report")
  );
}

function decoderSourceFlow(state, canonicalizer) {
  const statements = state.callable.body.statements;
  if (statements.length !== 6) return false;
  const local = decoderRawLocal(statements[2]);
  return Boolean(
    local &&
    decoderBudgetGuard(state, statements[0]) &&
    decoderShapePreflight(state, statements[1]) &&
    decoderTryAssignment(state, statements[3], local) &&
    decoderCanonicalGuard(state, statements[4], local, canonicalizer) &&
    ts.isReturnStatement(statements[5]) &&
    decoderSameSymbol(state.context, statements[5].expression, local.name),
  );
}

function canonicalDecoderFacts(compiler, identity, canonicalizer) {
  const state = { ...declarationCallable(compiler, identity), compiler };
  const output = declarationCallable(compiler, canonicalizer);
  if (
    identity.owner !== canonicalizer.owner ||
    !typedCallableShape(state.callable) ||
    !typedCallableShape(output.callable) ||
    !exportedDeclaration(state.callable) ||
    !exportedDeclaration(output.callable) ||
    !decoderPrimitiveSignature(
      state.context,
      state.callable,
      [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword],
      ts.SyntaxKind.UnknownKeyword,
    ) ||
    !decoderPrimitiveSignature(
      output.context,
      output.callable,
      [ts.SyntaxKind.UnknownKeyword],
      ts.SyntaxKind.StringKeyword,
    ) ||
    !decoderSourceFlow(state, canonicalizer)
  )
    throw new TypeError("unsupported-raw-canonical-json-decoder");
  return {
    producer: identity,
    canonicalizer,
    preflight: [
      "text-length",
      "utf8-bytes",
      "json-shape",
      "builtin-json-parse",
      "canonical-comparison",
    ],
    slot: { ...callableSlots(compiler, identity).result, rule: "anti-slop/no-unknown-returns" },
  };
}

function decoderWitnessLocal(statement) {
  if (
    !ts.isVariableStatement(statement) ||
    statement.declarationList.flags !== ts.NodeFlags.Const ||
    statement.declarationList.declarations.length !== 1
  )
    return null;
  const local = statement.declarationList.declarations[0];
  return ts.isIdentifier(local.name) && !local.type && typedForwardCall(local.initializer)
    ? { local, call: local.initializer }
    : null;
}

function decoderWitnessFlow(context, callable) {
  if (callable.body.statements.length !== 3) return null;
  const [rawStatement, resultStatement, returned] = callable.body.statements;
  const raw = decoderWitnessLocal(rawStatement);
  const result = decoderWitnessLocal(resultStatement);
  if (
    !raw ||
    !result ||
    !constAssignmentAndIdentifierReturn(resultStatement, returned) ||
    result.call.arguments.length !== 1 ||
    !decoderSameSymbol(context, result.call.arguments[0], raw.local.name) ||
    !decoderSameSymbol(context, returned.expression, result.local.name)
  )
    return null;
  return { raw, result, returned: returned.expression };
}

function decoderPublicCall(compiler, context, call, request, producer, parameters, result) {
  if (
    !parserImport(context, call, request.specifier) ||
    !directDiagnosticProducer(compiler, context, call, producer)
  )
    return false;
  const signatures = context.checker.getTypeAtLocation(call.expression).getCallSignatures();
  const declaration = context.checker.getResolvedSignature(call)?.declaration;
  return (
    signatures.length === 1 &&
    declaration &&
    decoderPrimitiveSignature(context, declaration, parameters, result)
  );
}

function decoderWitnessCalls(compiler, context, callable, flow, request, producer, canonicalizer) {
  return (
    decoderPublicCall(
      compiler,
      context,
      flow.raw.call,
      request,
      producer,
      [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword],
      ts.SyntaxKind.UnknownKeyword,
    ) &&
    decoderPublicCall(
      compiler,
      context,
      flow.result.call,
      request,
      canonicalizer,
      [ts.SyntaxKind.UnknownKeyword],
      ts.SyntaxKind.StringKeyword,
    ) &&
    flow.raw.call.arguments.length === 2 &&
    flow.raw.call.arguments.every((argument, index) =>
      decoderParameter({ context, callable }, argument, index),
    )
  );
}

function canonicalDecoderBinding(compiler, request, producer, canonicalizer) {
  const { context, source } = ownedSource(compiler, request.consumerPath, true);
  const module = context.checker.getSymbolAtLocation(source);
  const symbol = context.checker
    .getExportsOfModule(module)
    .find((entry) => entry.name === request.exportName);
  const callable = symbol?.declarations?.length === 1 ? symbol.declarations[0] : null;
  if (
    !typedCallableShape(callable) ||
    !decoderPrimitiveSignature(
      context,
      callable,
      [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword],
      ts.SyntaxKind.StringKeyword,
    )
  )
    return { bound: false, status: "incomplete" };
  const flow = decoderWitnessFlow(context, callable);
  if (
    !flow ||
    !decoderWitnessCalls(compiler, context, callable, flow, request, producer, canonicalizer)
  )
    return { bound: false, status: "incomplete" };
  return {
    bound: true,
    status: "ready",
    implementation: canonicalDeclaration(compiler, callable, null),
    calls: [flow.raw.call, flow.result.call].map((call) => ({
      path: request.consumerPath,
      start: call.getStart(),
      end: call.end,
    })),
  };
}

function canonicalDecoderOperations(compiler) {
  return {
    canonicalDecoderFacts: (identity, canonicalizer) => {
      compiler.assertCurrent();
      try {
        return canonicalDecoderFacts(compiler, identity, canonicalizer);
      } finally {
        compiler.assertCurrent();
      }
    },
    canonicalDecoderBinding: (request, producer, canonicalizer) => {
      compiler.assertCurrent();
      try {
        return canonicalDecoderBinding(compiler, request, producer, canonicalizer);
      } finally {
        compiler.assertCurrent();
      }
    },
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

function consumerIndexTarget(compiler, source, node) {
  const initializer = aliasInitializer(node);
  const callable = initializer ? rawParentheses(initializer) : node;
  return runtimeCallable(callable) ? rawCallableTarget(compiler, source, node, callable) : null;
}

function consumerStateIndex(compiler, implementation, companion = null) {
  const nodes = sourceNodes(compiler, implementation.source);
  const root = {
    ...implementation,
    compiler,
    nodes,
    declaration: implementation.callable,
    incoming: [],
    outgoing: [],
  };
  root.key = root.identity.producer.start;
  const states = new Map([[root.key, root]]);
  if (companion) {
    const key = companion.identity.producer.start;
    states.set(key, {
      ...root,
      ...companion,
      key,
      declaration: companion.callable,
      incoming: [],
      outgoing: [],
    });
  }
  for (const node of nodes) {
    const target = consumerIndexTarget(compiler, root.source, node);
    if (!target || exportedDeclaration(target.declaration)) continue;
    const key = target.identity.producer.start;
    if (!states.has(key)) states.set(key, { ...root, ...target, key, incoming: [], outgoing: [] });
  }
  for (const state of states.values()) {
    state.calls = consumerParticipatingCalls(compiler, state);
    for (const call of state.calls) consumerEdge(state, call, states);
  }
  return { root, states };
}

function consumerReachableKeys(root, states) {
  const reachable = new Set([root.key]);
  for (const key of reachable) for (const target of states.get(key).outgoing) reachable.add(target);
  return reachable;
}

function consumerWitnessKeys(compiler, states, reachable, producer) {
  return [...states.values()]
    .filter((state) => reachable.has(state.key))
    .filter((state) =>
      state.calls.some((call) => canonicalCall(compiler, state.context, call.expression, producer)),
    )
    .map((state) => state.key);
}

function consumerContributingKeys(root, states, reachable, witnesses, roots = new Set([root.key])) {
  const keys = new Set([...witnesses, ...roots]);
  for (const key of keys)
    for (const edge of states.get(key).incoming)
      if (reachable.has(edge.state)) keys.add(edge.state);
  return keys;
}

function consumerWitnessStates(root, index, keys, roots = new Set([root.key])) {
  if (keys.size > root.compiler.state.limits.aliases) throw new TypeError("symbol-alias-budget");
  const states = new Map(
    [...keys].map((key) => {
      const state = index.get(key);
      return [key, { ...state, incoming: state.incoming.filter((edge) => keys.has(edge.state)) }];
    }),
  );
  const complete = new Set();
  for (const key of states.keys()) assertConsumerAcyclic(states, key, new Set(), complete);
  return { root, states, qualified: qualifiedRawStates(root, states, roots) };
}

function consumerStates(compiler, implementation, producer, companion = null) {
  const { root, states } = consumerStateIndex(compiler, implementation, companion);
  const roots = new Set([root.key]);
  if (companion) roots.add(companion.identity.producer.start);
  const witnessesByRoot = [];
  const reachable = new Set();
  for (const key of roots) {
    const reached = consumerReachableKeys(states.get(key), states);
    witnessesByRoot.push(consumerWitnessKeys(compiler, states, reached, producer));
    for (const reachedKey of reached) reachable.add(reachedKey);
  }
  const witnesses = witnessesByRoot.flat();
  const keys = consumerContributingKeys(root, states, reachable, witnesses, roots);
  const graph = consumerWitnessStates(root, states, keys, roots);
  if (!companion) return graph;
  return {
    ...graph,
    witnessesByRoot: witnessesByRoot.map((entries) =>
      entries.filter((key) => graph.qualified.has(key)),
    ),
  };
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
  const candidate = states.get(key);
  if (!candidate) return;
  candidate.incoming.push({ state: state.key, call });
  state.outgoing.push(key);
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
  const { states, qualified } = consumerStates(compiler, implementation, producer);
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

function collectiveSourceNodes(compiler, source) {
  let cache = rawSourceNodeCaches.get(compiler);
  if (!cache) {
    cache = new WeakMap();
    rawSourceNodeCaches.set(compiler, cache);
  }
  if (!cache.has(source)) cache.set(source, sourceNodes(compiler, source));
  return cache.get(source);
}

function rawModulePath(compiler, source, specifier, mode = ts.ModuleKind.ESNext) {
  if (specifier.startsWith("file:")) specifier = fileURLToPath(specifier);
  const path = relative(compiler.state.subject.root, source.fileName).replaceAll("\\", "/");
  const { config } = compiler.context(path);
  const resolved = compiler.resolveModule(source.fileName, specifier, config, mode);
  if (!resolved) return null;
  const target = relative(compiler.state.subject.root, resolved.resolvedFileName).replaceAll(
    "\\",
    "/",
  );
  return compiler.state.subject.outputs.get(target) ?? target;
}

function rawModuleIndex(compiler) {
  compiler.assertCurrent();
  if (rawModuleIndexes.has(compiler)) return rawModuleIndexes.get(compiler);
  const receipt = preparedModuleReceipt(compiler.state.subject);
  if (receipt && preparedRawProfileCompatible(compiler.state.limits, receipt))
    return preparedRawModuleIndex(compiler, receipt);
  return unpreparedRawModuleIndex(compiler);
}

function preparedRawProfileCompatible(limits, receipt) {
  if (receipt.limits.aliases !== limits.aliases) return false;
  if (receipt.failure === "symbol-node-budget" && limits.nodes > receipt.limits.nodes) return false;
  if (receipt.failure === "symbol-source-budget" && limits.sourceBytes > receipt.limits.sourceBytes)
    return false;
  return true;
}

function recordRawModuleReferences(compiler, source, path, references, incoming) {
  for (const reference of references)
    for (const specifier of reference.specifiers)
      for (const target of new Set(
        [ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS].map((mode) =>
          rawModulePath(compiler, source, specifier, mode),
        ),
      )) {
        if (!target) continue;
        const entries = incoming.get(target) ?? [];
        entries.push({ path, start: reference.start, specifier });
        incoming.set(target, entries);
      }
}

function finishRawModuleIndex(compiler, modules, incoming) {
  const result = { modules, incoming, privacy: new Map(), references: new Map() };
  rawModuleIndexes.set(compiler, result);
  compiler.assertCurrent();
  return result;
}

function preparedRawModuleIndex(compiler, receipt) {
  if (receipt.failure) throw new TypeError(receipt.failure);
  const modules = new Map();
  const incoming = new Map();
  for (const row of receipt.rows) {
    // Only incoming entries read these statement facts; a row without targets creates none.
    if (!row.references.some((reference) => reference.specifiers.length > 0)) continue;
    if (policyDigest(compiler.read(row.path)) !== row.sourceSha256)
      throw new TypeError("symbol-module-facts-changed");
    const source = { fileName: join(compiler.state.subject.root, row.path) };
    modules.set(row.path, { statements: row.statements });
    recordRawModuleReferences(compiler, source, row.path, row.references, incoming);
  }
  return finishRawModuleIndex(compiler, modules, incoming);
}

function rawModuleStatements(compiler, source) {
  return source.statements.map((node) => {
    chargeSymbolVisits(compiler.state);
    if (ts.isImportDeclaration(node) && node.importClause?.name)
      return { start: node.getStart(), bindings: null };
    const bindings = ts.isImportDeclaration(node)
      ? node.importClause?.namedBindings
      : node.exportClause;
    return {
      start: node.getStart(),
      bindings:
        bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
          ? bindings.elements.map((binding) => {
              chargeSymbolVisits(compiler.state);
              return {
                name: (binding.propertyName ?? binding.name).text,
                isTypeOnly: binding.isTypeOnly,
              };
            })
          : null,
    };
  });
}

function unpreparedRawModuleIndex(compiler) {
  const modules = new Map();
  const incoming = new Map();
  for (const file of compiler.state.subject.inventory.files) {
    if (!file.production) continue;
    const source = ts.createSourceFile(
      file.path,
      compiler.read(file.path),
      ts.ScriptTarget.Latest,
      true,
    );
    if (source.parseDiagnostics.length) throw new TypeError("invalid-production-source");
    source.fileName = join(compiler.state.subject.root, file.path);
    const nodes = collectiveSourceNodes(compiler, source);
    const { config } = compiler.context(file.path);
    const references = productionModuleReferences(
      nodes,
      config.options,
      compiler.state.limits.aliases,
      (node) => visitCompilerNodes(compiler.state, node, () => undefined),
    );
    modules.set(file.path, { statements: rawModuleStatements(compiler, source) });
    recordRawModuleReferences(
      compiler,
      source,
      file.path,
      references.map(({ node, specifiers }) => ({ start: node.getStart(), specifiers })),
      incoming,
    );
  }
  return finishRawModuleIndex(compiler, modules, incoming);
}

function namedRawImport(node) {
  return (
    ts.isImportSpecifier(node) &&
    !node.isTypeOnly &&
    (node.propertyName ?? node.name).text !== "default" &&
    ts.isNamedImports(node.parent) &&
    node.parent.parent.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
    ts.isImportDeclaration(node.parent.parent.parent) &&
    node.parent.parent.parent.moduleSpecifier.text.startsWith(".")
  );
}

function importedRawAliasInitializer(state, symbol) {
  const initializer = aliasInitializer(symbol.valueDeclaration);
  if (
    !initializer ||
    exportedDeclaration(symbol.valueDeclaration) ||
    writtenSymbol(state.context, state.nodes, symbol)
  )
    return null;
  return initializer;
}

function importedRawCallable(state, expression, seen = new Set()) {
  expression = rawParentheses(expression);
  if (!ts.isIdentifier(expression)) return null;
  const symbol = state.context.checker.getSymbolAtLocation(expression);
  if (!symbol) return null;
  if (seen.has(symbol) || seen.size >= state.compiler.state.limits.aliases)
    throw new TypeError("symbol-alias-budget");
  seen.add(symbol);
  const declaration = symbol.declarations?.[0];
  if (declaration && namedRawImport(declaration)) return importedRawTarget(state, symbol);
  const initializer = importedRawAliasInitializer(state, symbol);
  if (!initializer) return null;
  return importedRawCallable(state, initializer, seen);
}

function importedRawTarget(state, symbol) {
  const compiler = state.compiler;
  const declaration = symbol.declarations[0];
  const imported = declaration.parent.parent.parent.moduleSpecifier.text;
  const modulePath = rawModulePath(compiler, state.source, imported);
  symbol = qualifiedAlias(state.context, symbol, compiler.state.limits.aliases);
  if (symbol.declarations.length !== 1) return null;
  const identity = canonicalDeclaration(compiler, symbol.declarations[0], null);
  if (identity.owner !== state.identity.owner || identity.producer.path !== modulePath) return null;
  if (!privateRawOutputBinding(compiler, identity.producer.path)) return null;
  const { context, source, node } = ownedDeclaration(compiler, identity);
  if (!ts.isFunctionDeclaration(node) || !node.name || node.parent !== source) return null;
  if (!runtimeCallable(node)) throw new TypeError("unsupported-responsibility-callable");
  return {
    context,
    source,
    callable: node,
    identity,
    declaration: node,
    nodes: collectiveSourceNodes(compiler, source),
    modulePrivate: true,
  };
}

function privateRawOutputBinding(compiler, path) {
  let bound = rawPrivateOutputBindings.get(compiler);
  if (!bound) {
    bound = new Set();
    rawPrivateOutputBindings.set(compiler, bound);
  }
  if (bound.has(path)) return true;
  const outputs = [...compiler.state.subject.outputs].filter(([, source]) => source === path);
  const declarations = outputs.filter(([output]) => /\.d\.[cm]?ts$/u.test(output));
  const runtimes = outputs.filter(([output]) => /\.[cm]?js$/u.test(output));
  if (declarations.length !== 1 || runtimes.length !== 1) return false;
  qualifiedDeclarationBytes(compiler, declarations[0][0]);
  compiler.read(runtimes[0][0]);
  bound.add(path);
  return true;
}

function collectiveRawCallable(state, expression) {
  const local = localRawCallable(state.compiler, state.context, state.source, expression);
  if (local && !exportedDeclaration(local.declaration)) return local;
  return importedRawCallable(state, expression);
}

function privatePublicSources(compiler, relevant) {
  const owners = [{ directory: "" }, ...compiler.state.subject.inventory.packages];
  return owners.flatMap(({ directory }) => {
    const manifest = JSON.parse(
      compiler.read(directory ? `${directory}/package.json` : "package.json"),
    );
    const sources = [...relevant].filter((path) => compiler.context(path).owner === directory);
    if (manifest.exports === undefined)
      sources.push(...privateContainedRuntimeSources(compiler, directory, relevant));
    const mainRelevant = privatePublicMainRelevant(compiler, directory, manifest.main, relevant);
    if (
      !sources.length &&
      !mainRelevant &&
      !privatePublicTargetRelevant(compiler, directory, manifest.exports, relevant)
    )
      return [];
    // Without exports, Node exposes package subpaths as well as main/default-index resolution.
    // Every relevant module here is already known to export the canonical helper.
    if (manifest.exports === undefined) return sources.length ? sources : [...relevant];
    if (!manifest.exports || typeof manifest.exports !== "object")
      throw new TypeError("unsupported-private-public-topology");
    return Object.entries(manifest.exports).flatMap(([name, target]) =>
      privatePublicTargetRelevant(compiler, directory, target, relevant)
        ? [privatePublicSource(compiler, directory, name, target)]
        : [],
    );
  });
}

function privateContainedRuntimeSources(compiler, directory, relevant) {
  const sources = new Set();
  for (const [output, source] of compiler.state.subject.outputs) {
    if (!relevant.has(source) || !/\.[cm]?js$/u.test(output)) continue;
    if (directory && !output.startsWith(`${directory}/`)) continue;
    if (!privateRawOutputBinding(compiler, source))
      throw new TypeError("unqualified-private-public-topology");
    sources.add(source);
  }
  return [...sources];
}

function privatePublicMainRelevant(compiler, directory, main, relevant) {
  if (typeof main !== "string") return false;
  const candidates = [
    main,
    `${main}.js`,
    `${main}.json`,
    `${main}.node`,
    `${main}/index.js`,
    `${main}/index.json`,
    `${main}/index.node`,
  ];
  return candidates.some((target) =>
    privatePublicTargetRelevant(compiler, directory, target, relevant),
  );
}

function privatePublicTargetRelevant(compiler, directory, target, relevant, depth = 0) {
  if (depth >= compiler.state.limits.aliases) throw new TypeError("symbol-alias-budget");
  if (typeof target !== "string") {
    if (!target || typeof target !== "object") return false;
    return Object.values(target).some((value) =>
      privatePublicTargetRelevant(compiler, directory, value, relevant, depth + 1),
    );
  }
  const path = join(directory, target).replaceAll("\\", "/");
  if (relevant.has(path) || relevant.has(compiler.state.subject.outputs.get(path))) return true;
  if (!path.includes("*")) return false;
  const parts = path.split("*");
  return [...compiler.state.subject.outputs].some(
    ([output, source]) =>
      relevant.has(source) && output.startsWith(parts[0]) && output.endsWith(parts.at(-1)),
  );
}

function privatePublicRuntime(target) {
  if (!target || Object.keys(target).length !== 2 || typeof target.types !== "string")
    throw new TypeError("unsupported-private-public-topology");
  const runtime = target.import ?? target.default;
  if (typeof runtime !== "string" || !runtime.startsWith("./") || !target.types.startsWith("./"))
    throw new TypeError("unsupported-private-public-topology");
  return runtime;
}

function privatePublicSource(compiler, directory, name, target) {
  if (!name.startsWith(".") || name.includes("*"))
    throw new TypeError("unsupported-private-public-topology");
  const runtime = privatePublicRuntime(target);
  const prefix = directory ? `${directory}/` : "";
  const source = compiler.state.subject.outputs.get(`${prefix}${target.types.slice(2)}`);
  if (!source || compiler.state.subject.outputs.get(`${prefix}${runtime.slice(2)}`) !== source)
    throw new TypeError("unqualified-private-public-topology");
  compiler.read(`${prefix}${runtime.slice(2)}`);
  compiler.read(`${prefix}${target.types.slice(2)}`);
  return source;
}

function privateExportExposes(state, context, symbol, seen = new Set()) {
  if (!privateValueExportSymbol(symbol)) return false;
  if (seen.has(symbol)) return false;
  if (seen.size >= state.compiler.state.limits.aliases) throw new TypeError("symbol-alias-budget");
  const next = new Set(seen).add(symbol);
  symbol = qualifiedAlias(context, symbol, state.compiler.state.limits.aliases);
  if (matchesProducer(state.compiler, symbol, state.identity)) return true;
  if ((symbol.flags & ts.SymbolFlags.Module) === 0) return false;
  return context.checker
    .getExportsOfModule(symbol)
    .some((entry) => privateExportExposes(state, context, entry, next));
}

function privateValueExportSymbol(symbol) {
  return !symbol.declarations?.length || symbol.declarations.some(privateValueExportDeclaration);
}

function privateValueExportDeclaration(declaration) {
  if (!ts.isExportSpecifier(declaration)) return true;
  const statement = declaration.parent.parent;
  return statement.moduleSpecifier
    ? Boolean(namedValueReexport(statement, declaration))
    : !statement.isTypeOnly && !declaration.isTypeOnly;
}

function privateIncomingModuleExposure(state, index, entry, target) {
  const relevant =
    target === state.identity.producer.path
      ? privateIncomingRelevant(state, index, entry)
      : privateIncomingTargetRelevant(state, index, entry, target);
  if (!relevant) return false;
  return privateModuleExportsHelper(state, entry.path);
}

function privateIncomingTargetRelevant(state, index, entry, target) {
  const node = index.modules
    .get(entry.path)
    ?.statements.find((statement) => statement.start === entry.start);
  if (!node?.bindings) return true;
  const bindings = node.bindings.filter((binding) => !binding.isTypeOnly);
  if (bindings.some((binding) => binding.name === "default")) return true;
  if (bindings.length === 0) return false;
  const owned = privateOwnedSource(state.compiler, target);
  if (!owned) return true;
  const module = owned.context.checker.getSymbolAtLocation(owned.source);
  if (!module) return true;
  const exports = owned.context.checker.getExportsOfModule(module);
  const relevant = bindings.some((binding) => {
    const symbol = exports.find((entry) => entry.name === binding.name);
    return !symbol || privateExportExposes(state, owned.context, symbol);
  });
  return relevant || !privateRawOutputBinding(state.compiler, target);
}

function privateReachableModules(state, index, path) {
  const reachable = new Set([path]);
  const queue = [path];
  for (const target of queue)
    for (const entry of index.incoming.get(target) ?? []) {
      if (reachable.has(entry.path)) continue;
      const exposed = privateIncomingModuleExposure(state, index, entry, target);
      if (exposed === null) return null;
      if (!exposed) continue;
      reachable.add(entry.path);
      queue.push(entry.path);
    }
  return reachable;
}

function privateModuleExportsHelper(state, path) {
  const owned = privateOwnedSource(state.compiler, path);
  if (!owned) return null;
  const module = owned.context.checker.getSymbolAtLocation(owned.source);
  if (!module) return null;
  return owned.context.checker
    .getExportsOfModule(module)
    .some((symbol) => privateExportExposes(state, owned.context, symbol));
}

function privateDirectPublicExposure(state) {
  const paths = privatePublicPaths(state.compiler, new Set([state.identity.producer.path]));
  return paths?.some((path) => privateModuleExportsHelper(state, path) === true) ?? false;
}

function privateRawPublicExposure(state, index) {
  const key = canonicalRawStateKey(state.identity, -1);
  if (index.privacy.has(key)) return index.privacy.get(key);
  if (privateDirectPublicExposure(state)) {
    index.privacy.set(key, true);
    return true;
  }
  const relevant = privateReachableModules(state, index, state.identity.producer.path);
  if (!relevant) return true;
  const paths = privatePublicPaths(state.compiler, relevant);
  if (!paths) return true;
  const exposed = paths.some((path) => {
    if (!relevant.has(path)) return false;
    const owned = privateOwnedSource(state.compiler, path);
    if (!owned) return true;
    const { context, source } = owned;
    const module = context.checker.getSymbolAtLocation(source);
    if (!module) throw new TypeError("unresolved-private-public-topology");
    return context.checker
      .getExportsOfModule(module)
      .some((symbol) => privateExportExposes(state, context, symbol));
  });
  index.privacy.set(key, exposed);
  return exposed;
}

function privatePublicPaths(compiler, relevant) {
  try {
    return privatePublicSources(compiler, relevant);
  } catch (error) {
    if (
      error.message === "unsupported-private-public-topology" ||
      error.message === "unqualified-private-public-topology"
    )
      return null;
    throw error;
  }
}

function privateOwnedSource(compiler, path) {
  try {
    return ownedSource(compiler, path);
  } catch (error) {
    if (error.message === "untyped-symbol-source") return null;
    throw error;
  }
}

function privateReferenceIdentity(state, context, node) {
  let symbol = referenceValueSymbol(context, node);
  if (!symbol) return false;
  const seen = new Set();
  while (symbol) {
    if (!symbol.declarations?.length) return false;
    symbol = qualifiedAlias(context, symbol, state.compiler.state.limits.aliases);
    if (matchesProducer(state.compiler, symbol, state.identity)) return true;
    if (seen.has(symbol) || seen.size >= state.compiler.state.limits.aliases)
      throw new TypeError("symbol-alias-budget");
    seen.add(symbol);
    const initializer = aliasInitializer(symbol.valueDeclaration);
    if (!initializer || !ts.isIdentifier(rawParentheses(initializer))) return false;
    symbol = context.checker.getSymbolAtLocation(rawParentheses(initializer));
  }
  return false;
}

function privateReferenceAlias(node) {
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

function privateReferenceFact(node, path) {
  if (declarationReference(node)) return { kind: "binding" };
  if (ts.isImportSpecifier(node.parent))
    return { kind: namedRawImport(node.parent) ? "binding" : "unsupported" };
  const call = referenceCall(node);
  if (call) return { kind: "call", path, start: call.getStart(), end: call.end };
  return { kind: privateReferenceAlias(node) ? "binding" : "unsupported" };
}

function privateUnsupportedReexport(state, owned, node) {
  return (
    !node.isTypeOnly &&
    node.exportClause.elements.some(
      (binding) =>
        !binding.isTypeOnly && privateReferenceIdentity(state, owned.context, binding.name),
    )
  );
}

function privateUnsupportedImportClause(state, owned, clause) {
  if (!clause || clause.isTypeOnly) return false;
  if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some(
    (binding) =>
      !binding.isTypeOnly &&
      privateReferenceIdentity(state, owned.context, binding.name) &&
      !namedRawImport(binding),
  );
}

function privateUnsupportedImport(state, owned, entry) {
  const node = owned.source.statements.find((statement) => statement.getStart() === entry.start);
  if (
    node &&
    ts.isExportDeclaration(node) &&
    node.exportClause &&
    ts.isNamedExports(node.exportClause)
  )
    return privateUnsupportedReexport(state, owned, node);
  if (!node || !ts.isImportDeclaration(node)) return true;
  return privateUnsupportedImportClause(state, owned, node.importClause);
}

function privateSourceReferenceFacts(state, path) {
  const owned = privateOwnedSource(state.compiler, path);
  if (!owned) return [{ kind: "unsupported" }];
  const nodes = collectiveSourceNodes(state.compiler, owned.source);
  return nodes.flatMap((node) => {
    if (!ts.isIdentifier(node) || privateTypeOnlyReference(node)) return [];
    if (!privateReferenceIdentity(state, owned.context, node)) return [];
    const symbol = owned.context.checker.getSymbolAtLocation(node);
    if (symbol && writtenSymbol(owned.context, nodes, symbol)) return [{ kind: "unsupported" }];
    return [privateReferenceFact(node, path)];
  });
}

function privateTypeOnlyReference(node) {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) return ts.isTypeOnlyImportDeclaration(parent);
  if (ts.isExportSpecifier(parent)) return parent.isTypeOnly || parent.parent.parent.isTypeOnly;
  for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isTypeNode(ancestor)) return true;
    if (ts.isExpression(ancestor) || ts.isStatement(ancestor)) return false;
  }
  return false;
}

function privateRawReferenceFacts(state, index) {
  const key = canonicalRawStateKey(state.identity, -1);
  if (index.references.has(key)) return index.references.get(key);
  const facts = [];
  const path = state.identity.producer.path;
  const incoming = (index.incoming.get(path) ?? []).filter((entry) =>
    privateIncomingRelevant(state, index, entry),
  );
  // A relevant foreign incoming reference already withholds this helper and its downstream slots.
  if (
    incoming.some(
      (entry) => state.compiler.context(entry.path).owner !== state.compiler.context(path).owner,
    )
  ) {
    facts.push({ kind: "unsupported" });
    index.references.set(key, facts);
    return facts;
  }
  if (privateRawPublicExposure(state, index)) facts.push({ kind: "unsupported" });
  for (const entry of incoming) {
    const owned = privateOwnedSource(state.compiler, entry.path);
    if (!owned || privateUnsupportedImport(state, owned, entry))
      facts.push({ kind: "unsupported" });
  }
  if (!facts.some((fact) => fact.kind === "unsupported"))
    for (const source of new Set([path, ...incoming.map((entry) => entry.path)]))
      facts.push(...privateSourceReferenceFacts(state, source));
  index.references.set(key, facts);
  return facts;
}

function privateRawUnsupportedUse(state) {
  const facts = privateRawReferenceFacts(state, rawModuleIndex(state.compiler));
  return facts.some(
    (fact) =>
      fact.kind === "unsupported" ||
      (fact.kind === "call" &&
        !state.incoming.some(
          (edge) =>
            edge.path === fact.path &&
            edge.call.getStart() === fact.start &&
            edge.call.end === fact.end,
        )),
  );
}

function privateIncomingRelevant(state, index, entry) {
  const node = index.modules
    .get(entry.path)
    ?.statements.find((statement) => statement.start === entry.start);
  if (!node?.bindings) return true;
  return node.bindings.some(
    (binding) => !binding.isTypeOnly && binding.name === state.callable.name.text,
  );
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

function canonicalRawStateKey(identity, index) {
  const { path, start, end, kind } = identity.producer;
  return JSON.stringify([identity.owner, path, start, end, kind, index]);
}

function rawState(compiler, context, source, nodes, target, index, collective = false) {
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
    key: collective
      ? canonicalRawStateKey(target.identity, index)
      : `${target.identity.producer.start}:${index}`,
    collective,
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

function collectiveRawArgument(state, argument) {
  const facts = typeFacts(state.context.checker.getTypeAtLocation(argument));
  return facts.kind === "unknown" || facts.indexes?.some((index) => index.kind === "unknown");
}

function rawEdgeCandidate(state, target, index, argument) {
  const origin = rawOrigin(state, argument);
  if (!origin || (state.collective && !collectiveRawArgument(state, argument))) return null;
  const candidate = rawState(
    state.compiler,
    target.context ?? state.context,
    target.source ?? state.source,
    target.nodes ?? state.nodes,
    target,
    index,
    state.collective,
  );
  return candidate ? { candidate, origin } : null;
}

function rawCallEdges(state, states, queue, stateLimit = state.compiler.state.limits.aliases) {
  for (const call of stateCalls(state)) {
    const target =
      state.collective && state.privateModules
        ? collectiveRawCallable(state, call.expression)
        : localRawCallable(state.compiler, state.context, state.source, call.expression);
    if (!target || (!target.modulePrivate && exportedDeclaration(target.declaration))) continue;
    rawCallArguments(state, target, call, states, queue, stateLimit);
  }
}

function rawCallArguments(state, target, call, states, queue, stateLimit) {
  for (const [index, argument] of call.arguments.entries()) {
    const edge = rawEdgeCandidate(state, target, index, argument);
    if (!edge) continue;
    const { candidate, origin } = edge;
    if (state.privateModules) candidate.privateModules = true;
    if (!states.has(candidate.key)) {
      if (state.collective && states.size >= stateLimit)
        throw collectiveHelperBudgetError(stateLimit, states.size + 1);
      states.set(candidate.key, candidate);
      queue.push(candidate);
    }
    const incoming = { state: state.key, call, origin };
    if (state.privateModules) incoming.path = state.identity.producer.path;
    states.get(candidate.key).incoming.push(incoming);
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
  if (state.incoming.some((edge) => edge.callbackReference === node)) return true;
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

function qualifiedRawStates(root, states, roots = new Set([root.key])) {
  const qualified = new Set(states.keys());
  for (const state of states.values()) {
    if (roots.has(state.key)) continue;
    if (rawStateHasUnsupportedUse(state)) qualified.delete(state.key);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const state of states.values()) {
      if (roots.has(state.key) || !qualified.has(state.key)) continue;
      if (state.incoming.some((edge) => !qualified.has(edge.state))) {
        qualified.delete(state.key);
        changed = true;
      }
    }
  }
  return qualified;
}

function rawStateHasUnsupportedUse(state) {
  return (
    ((state.collective || state.capturedUnknownTraversal) &&
      writtenSymbol(state.context, state.nodes, state.parameterSymbol)) ||
    (state.modulePrivate
      ? privateRawUnsupportedUse(state)
      : state.nodes.some(
          (node) => helperReference(state, node) && !permittedHelperReference(state, node),
        ))
  );
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

function rawTypeofOperand(context, expression, origin) {
  const type = context.checker.getTypeAtLocation(expression);
  if ((type.flags & ts.TypeFlags.Unknown) !== 0) return true;
  if (origin.length === 0) return false;
  const top = context.checker.getNonNullableType(context.checker.getUnknownType());
  const members = type.isUnion() ? type.types : [type];
  return (
    members.includes(top) &&
    members.every(
      (member) =>
        member === top || (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0,
    )
  );
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
      return origin && rawTypeofOperand(state.context, node.expression, origin)
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

function capturedNamedResultSymbol(state, annotation) {
  if (!ts.isTypeReferenceNode(annotation.type) || !ts.isIdentifier(annotation.type.typeName))
    return null;
  return state.context.checker.getSymbolAtLocation(annotation.type.typeName);
}

function capturedOwnedResult(state, symbol) {
  return (
    symbol?.declarations?.length === 1 && symbol.declarations[0].getSourceFile() === state.source
  );
}

function capturedPredicateRoot(state) {
  const signature = state.context.checker.getSignatureFromDeclaration(state.callable);
  const predicate = signature && typedIdentifierPredicate(state.context, state.callable, signature);
  if (!predicate) return false;
  const symbol = capturedNamedResultSymbol(state, state.callable.type);
  return (
    predicate.parameterIndex === state.index &&
    state.callable.parameters[state.index].type?.kind === ts.SyntaxKind.UnknownKeyword &&
    !state.callable.typeParameters?.length &&
    capturedOwnedResult(state, symbol)
  );
}

function capturedBindingInitializer(pattern) {
  const declaration = pattern.parent;
  if (
    !ts.isObjectBindingPattern(pattern) ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.type ||
    !declaration.initializer ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0 ||
    pattern.elements.some(
      (entry) => !ts.isIdentifier(entry.name) || entry.initializer || entry.dotDotDotToken,
    )
  )
    return null;
  return declaration.initializer;
}

function capturedBinding(state, argument) {
  if (!ts.isIdentifier(argument)) return null;
  const symbol = state.context.checker.getSymbolAtLocation(argument);
  const binding = symbol?.valueDeclaration;
  if (
    !binding ||
    !ts.isBindingElement(binding) ||
    writtenSymbol(state.context, state.nodes, symbol)
  )
    return null;
  const initializer = capturedBindingInitializer(binding.parent);
  return initializer ? { binding, initializer } : null;
}

function capturedUnknownOrigin(state, argument) {
  if (typeFacts(state.context.checker.getTypeAtLocation(argument)).kind !== "unknown") return null;
  const capture = capturedBinding(state, argument);
  if (!capture || !rawDictionaryMember(state, state.callable.parameters[state.index].type))
    return null;
  const origin = rawOrigin(state, capture.initializer);
  const property = capture.binding.propertyName ?? capture.binding.name;
  if (!origin || (!ts.isIdentifier(property) && !ts.isStringLiteral(property))) return null;
  return [...origin, property.text];
}

function capturedPredicateTarget(state, call) {
  const target = localRawCallable(state.compiler, state.context, state.source, call.expression);
  if (!target || exportedDeclaration(target.declaration) || target.callable.typeParameters?.length)
    return null;
  const signature = state.context.checker.getResolvedSignature(call);
  const predicate = signature && state.context.checker.getTypePredicateOfSignature(signature);
  return predicate?.kind === ts.TypePredicateKind.Identifier
    ? { target, index: predicate.parameterIndex }
    : null;
}

function capturedPredicateCall(state, call) {
  const target = capturedPredicateTarget(state, call);
  if (!target) return null;
  const argument = call.arguments[target.index];
  const origin = argument && capturedUnknownOrigin(state, argument);
  if (!origin) return null;
  const candidate = rawState(
    state.compiler,
    state.context,
    state.source,
    state.nodes,
    target.target,
    target.index,
  );
  if (candidate?.callable.parameters[candidate.index].type?.kind !== ts.SyntaxKind.UnknownKeyword)
    return null;
  candidate.capturedUnknownTraversal = true;
  return { candidate, call, state, argument, origin };
}

function optionalRequiredParameter(parameter) {
  return (
    parameter &&
    ts.isIdentifier(parameter.name) &&
    !parameter.questionToken &&
    !parameter.initializer &&
    !parameter.dotDotDotToken
  );
}

function optionalParameterReference(state, node, parameter) {
  return (
    ts.isIdentifier(node) &&
    state.context.checker.getSymbolAtLocation(node) ===
      state.context.checker.getSymbolAtLocation(parameter.name)
  );
}

function optionalUndefinedReference(state, node) {
  if (!ts.isIdentifier(node) || node.text !== "undefined") return false;
  const symbol = state.context.checker.getSymbolAtLocation(node);
  return (
    Boolean(symbol) &&
    !symbol.declarations?.length &&
    state.context.checker.getTypeAtLocation(node).flags === ts.TypeFlags.Undefined
  );
}

function optionalAbsentComparison(state, node, parameter) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    optionalParameterReference(state, node.left, parameter) &&
    optionalUndefinedReference(state, node.right)
  );
}

function optionalWrapperReturn(state, callable) {
  if (!ts.isBlock(callable.body) || callable.body.statements.length !== 1) return null;
  const returned = callable.body.statements[0];
  if (!ts.isReturnStatement(returned) || !returned.expression) return null;
  const expression = rawParentheses(returned.expression);
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.BarBarToken
  )
    return null;
  const absent = rawParentheses(expression.left);
  if (!optionalAbsentComparison(state, absent, callable.parameters[0])) return null;
  return rawParentheses(expression.right);
}

function optionalWrapperBody(state, callable) {
  const forwarded = optionalWrapperReturn(state, callable);
  return (
    forwarded &&
    ts.isCallExpression(forwarded) &&
    !forwarded.questionDotToken &&
    !forwarded.typeArguments?.length &&
    forwarded.arguments.length === 1 &&
    optionalParameterReference(state, forwarded.expression, callable.parameters[1]) &&
    optionalParameterReference(state, forwarded.arguments[0], callable.parameters[0])
  );
}

function optionalExportExpression(state, symbol) {
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = state.context.checker.getAliasedSymbol(symbol);
  const declaration = symbol.valueDeclaration;
  return declaration && ts.isExportAssignment(declaration)
    ? declaration.expression
    : declaration?.name;
}

function optionalExportedCallable(state, target) {
  const module = state.context.checker.getSymbolAtLocation(state.source);
  if (!module) return true;
  return state.context.checker.getExportsOfModule(module).some((symbol) => {
    const expression = optionalExportExpression(state, symbol);
    const exported =
      expression && localRawCallable(state.compiler, state.context, state.source, expression);
    return exported && sameProducer(exported.identity, target.identity);
  });
}

function optionalPrivateCallable(state, expression) {
  if (!ts.isIdentifier(expression)) return null;
  const target = localRawCallable(state.compiler, state.context, state.source, expression);
  const symbol = state.context.checker.getSymbolAtLocation(expression);
  if (!target || exportedDeclaration(target.declaration) || !symbol) return null;
  if (optionalExportedCallable(state, target)) return null;
  const declarationSymbol = state.context.checker.getSymbolAtLocation(target.declaration.name);
  return [symbol, declarationSymbol].some(
    (entry) => entry && writtenSymbol(state.context, state.nodes, entry),
  )
    ? null
    : target;
}

function optionalSynchronousCallable(callable, arity) {
  return (
    callable.parameters.length === arity &&
    callable.parameters.every(optionalRequiredParameter) &&
    !callable.typeParameters?.length &&
    !callable.asteriskToken &&
    !(ts.getCombinedModifierFlags(callable) & ts.ModifierFlags.Async)
  );
}

function optionalRawWrapper(state, call) {
  if (call.questionDotToken || call.typeArguments?.length || call.arguments.length !== 2)
    return null;
  const target = optionalPrivateCallable(state, call.expression);
  if (!target) return null;
  const callable = target.callable;
  if (!optionalSynchronousCallable(callable, 2)) return null;
  return optionalWrapperBody(state, callable) ? target : null;
}

function optionalRawPredicate(state, expression) {
  const target = optionalPrivateCallable(state, expression);
  if (!target) return null;
  const callable = target.callable;
  if (
    !optionalSynchronousCallable(callable, 1) ||
    callable.parameters[0].type?.kind !== ts.SyntaxKind.UnknownKeyword
  )
    return null;
  const signature = state.context.checker.getSignatureFromDeclaration(callable);
  return signature && typedIdentifierPredicate(state.context, callable, signature) ? target : null;
}

function optionalRawCallEdges(state, states, queue) {
  for (const call of stateCalls(state)) {
    if (!optionalRawWrapper(state, call)) continue;
    const target = optionalRawPredicate(state, call.arguments[1]);
    if (!target) continue;
    const edge = rawEdgeCandidate(state, target, 0, call.arguments[0]);
    if (!edge) continue;
    const { candidate, origin } = edge;
    if (!states.has(candidate.key)) {
      states.set(candidate.key, candidate);
      queue.push(candidate);
    }
    states.get(candidate.key).incoming.push({
      state: state.key,
      call,
      origin,
      callbackReference: call.arguments[1],
    });
  }
}

function capturedRawStates(root) {
  const ownedRoot = { ...root, incoming: [] };
  const states = new Map([[root.key, ownedRoot]]);
  const queue = [ownedRoot];
  for (const state of queue) {
    if (states.size > state.compiler.state.limits.aliases)
      throw new TypeError("symbol-alias-budget");
    state.capturedUnknownTraversal = true;
    rawCallEdges(state, states, queue);
    optionalRawCallEdges(state, states, queue);
  }
  assertRawAcyclic(states);
  return { states, qualified: qualifiedRawStates(ownedRoot, states) };
}

function capturedUnknownPredicateSlots(root, states, qualified) {
  if (!capturedPredicateRoot(root)) return [];
  const candidates = new Map();
  for (const state of states.values()) {
    if (!qualified.has(state.key)) continue;
    for (const call of stateCalls(state)) {
      const fact = capturedPredicateCall(state, call);
      if (!fact) continue;
      const entry = candidates.get(fact.candidate.key) ?? { target: fact.candidate, facts: [] };
      entry.target.incoming.push({ state: state.key, call, origin: fact.origin });
      entry.facts.push(fact);
      candidates.set(fact.candidate.key, entry);
    }
  }
  return [...candidates.values()].flatMap(({ target, facts }) =>
    rawStateHasUnsupportedUse(target)
      ? []
      : facts.map(({ state, argument, origin }) => ({
          ...rawOperationSlot(
            state,
            argument,
            "anti-slop/no-known-value-widening",
            "argument",
            origin,
          ),
          capturedUnknownPredicate: true,
        })),
  );
}

function capturedOptionalUnknownSlots(root) {
  if (!capturedPredicateRoot(root)) return [];
  const captured = capturedRawStates(root);
  return capturedUnknownPredicateSlots(root, captured.states, captured.qualified);
}

function rawCheckingSlots(compiler, identity, index, capturedUnknownPredicates = false) {
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
  if (capturedUnknownPredicates) slots.push(...capturedOptionalUnknownSlots(root));
  compiler.assertCurrent();
  return slots;
}

function collectiveRawRoot(compiler, request, privateModules = false) {
  const owned = declarationCallable(compiler, request.identity);
  const nodes = privateModules
    ? collectiveSourceNodes(compiler, owned.source)
    : sourceNodes(compiler, owned.source);
  const state = rawState(
    compiler,
    owned.context,
    owned.source,
    nodes,
    {
      callable: owned.callable,
      identity: { ...request.identity, entry: null },
      declaration: owned.callable,
    },
    request.index,
    true,
  );
  if (state && privateModules) state.privateModules = true;
  if (!state || writtenSymbol(state.context, nodes, state.parameterSymbol)) return null;
  const parameter = state.callable.parameters[state.index];
  return typeFacts(state.context.checker.getTypeAtLocation(parameter)).kind === "unknown"
    ? state
    : null;
}

function collectiveRawGraph(
  compiler,
  requests,
  privateModules = false,
  stateLimit = compiler.state.limits.aliases,
) {
  const states = new Map();
  const roots = new Map();
  const rootLimit = Math.min(compiler.state.limits.aliases, stateLimit);
  for (const request of requests) {
    const state = collectiveRawRoot(compiler, request, privateModules);
    if (!state) continue;
    if (!states.has(state.key) && states.size >= rootLimit)
      throw collectiveHelperBudgetError(rootLimit, states.size + 1);
    states.set(state.key, state);
    roots.set(state.key, [...(roots.get(state.key) ?? []), request.recordId]);
  }
  const queue = [...states.values()];
  for (const state of queue) rawCallEdges(state, states, queue, stateLimit);
  assertRawAcyclic(states);
  return { states, roots };
}

function contributingRawRoots(key, states, roots, cache) {
  if (roots.has(key)) return roots.get(key);
  if (!cache.has(key))
    cache.set(
      key,
      [
        ...new Set(
          states
            .get(key)
            .incoming.flatMap((edge) => contributingRawRoots(edge.state, states, roots, cache)),
        ),
      ].sort(compareStrings),
    );
  return cache.get(key);
}

function collectiveStateSlots(state) {
  const parameter = state.callable.parameters[state.index];
  const annotation = annotationSlot(
    state.context,
    state.source,
    parameter.type,
    state.identity,
    "parameter",
    state.index,
  );
  return [
    ...(annotation?.type.kind === "unknown"
      ? [{ ...annotation, rule: "anti-slop/no-unknown-parameters" }]
      : []),
    ...rawDictionaryAnnotations(state),
    ...rawTypeofSlots(state),
  ];
}

function collectiveRawFacts(compiler, requests, privateModules = false) {
  compiler.assertCurrent();
  if (requests.length > compiler.state.limits.aliases)
    throw collectiveHelperBudgetError(compiler.state.limits.aliases, requests.length);
  const stateLimit = privateModules
    ? collectivePrivateStateLimit(compiler, requests)
    : compiler.state.limits.aliases;
  const { states, roots } = collectiveRawGraph(compiler, requests, privateModules, stateLimit);
  const first = states.get(roots.keys().next().value);
  const qualified =
    roots.size === 0 ? new Set() : qualifiedRawStates(first, states, new Set(roots.keys()));
  return { states, roots, qualified };
}

function collectiveDetachedSlots(compiler, requests) {
  const { states, roots, qualified } = collectiveRawFacts(compiler, requests, true);
  const slots = [];
  const dependencies = new Map();
  for (const state of states.values()) {
    if (!qualified.has(state.key)) continue;
    const contributingResponsibilityIds = [
      ...new Set(contributingRawRoots(state.key, states, roots, dependencies)),
    ].sort(compareStrings);
    slots.push(
      ...collectiveStateSlots(state).map((slot) => ({
        ...slot,
        producerIdentity: state.identity,
        contributingResponsibilityIds,
      })),
    );
  }
  compiler.assertCurrent();
  return slots;
}

function collectiveRawCheckingSlots(compiler, requests, rule) {
  const key = detachedRawRequestKey(requests);
  const slots = detachedRawResult(compiler, rawDetachedSlots, key, () =>
    collectiveDetachedSlots(compiler, requests),
  );
  compiler.assertCurrent();
  return slots.filter((slot) => slot.rule === rule);
}

function collectiveDiscoveryKeys(compiler, request) {
  return detachedRawResult(compiler, rawDiscoveryKeys, detachedRawRequestKey([request]), () => [
    ...collectiveRawGraph(compiler, [request], true).states.keys(),
  ]);
}

function collectiveRawComponentFacts(compiler, requests) {
  compiler.assertCurrent();
  const components = [];
  for (const request of [...requests].sort((a, b) => compareStrings(a.recordId, b.recordId))) {
    const rootKey = canonicalRawStateKey(request.identity, request.index);
    let keys;
    // A fallback key preserves grouping, but never certifies complete discovery.
    let complete = false;
    try {
      keys = new Set(collectiveDiscoveryKeys(compiler, request));
      complete = keys.has(rootKey);
    } catch (error) {
      if (!collectiveHelperBudgetDetails(error)) throw error;
      keys = new Set([rootKey]);
    }
    const joined = { keys, roots: [request], complete };
    for (let index = components.length - 1; index >= 0; index -= 1) {
      const component = components[index];
      if (![...keys].some((key) => component.keys.has(key))) continue;
      for (const key of component.keys) keys.add(key);
      joined.roots.push(...component.roots);
      joined.complete &&= component.complete;
      components.splice(index, 1);
    }
    components.push(joined);
  }
  compiler.assertCurrent();
  return components;
}

function collectiveRawComponents(compiler, requests) {
  return collectiveRawComponentFacts(compiler, requests).map(({ roots }) => {
    roots.sort((a, b) => compareStrings(a.recordId, b.recordId));
    return roots;
  });
}

function collectivePrivateStateLimit(compiler, requests) {
  const limit = compiler.state.limits.aliases;
  // Equal profiles retain the original bound without needing a larger-context witness.
  if (compiler.state.limits.collectiveStates === limit) return limit;
  const requestedRoots = new Set(
    requests.map(({ identity, index }) => canonicalRawStateKey(identity, index)),
  );
  if (requestedRoots.size <= 1) return limit;
  const components = collectiveRawComponentFacts(compiler, requests);
  compiler.assertCurrent();
  if (components.length !== 1 || !components[0].complete) return limit;
  const component = components[0];
  const discoveredRoots = new Set(
    component.roots.map(({ identity, index }) => canonicalRawStateKey(identity, index)),
  );
  return discoveredRoots.size === requestedRoots.size &&
    [...requestedRoots].every((key) => discoveredRoots.has(key) && component.keys.has(key))
    ? compiler.state.limits.collectiveStates
    : limit;
}

function collectiveJsonByteMeasurement(compiler, requests) {
  return numericObjectSlots(compiler, requests, collectiveRawFacts(compiler, requests));
}

function numericObjectSlots(compiler, requests, graph) {
  const form = "json-utf8-byte-measurement";
  const facts = recognizeJsonByteMeasurement(
    compiler,
    {
      ...graph,
      referenceFacts: { valueSymbol: referenceValueSymbol, declaration: declarationReference },
    },
    requests,
    defaultLibrarySymbol,
  );
  compiler.assertCurrent();
  if (!facts) return { form, status: "withheld", reason: "unsupported-json-byte-form", slots: [] };
  const slots = [
    [facts.forwarded.state, facts.forwarded.ids],
    [facts.leaf, facts.ids],
  ].map(([state, contributingResponsibilityIds]) => ({
    ...annotationSlot(
      state.context,
      state.source,
      state.callable.parameters[state.index].type,
      state.identity,
      "parameter",
      state.index,
    ),
    rule: "anti-slop/no-object-parameters",
    producerIdentity: state.identity,
    contributingResponsibilityIds,
    objectForm: form,
    componentRoots: facts.componentRoots,
  }));
  return { form, status: "recognized", slots };
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

function rawReaderParameter(state, index, kind) {
  const parameter = state.callable.parameters[index];
  return (
    parameter &&
    ts.isIdentifier(parameter.name) &&
    !parameter.initializer &&
    !parameter.questionToken &&
    !parameter.dotDotDotToken &&
    (kind === "record"
      ? intrinsicReaderRecord(state, parameter.type)
      : parameter.type?.kind === ts.SyntaxKind.StringKeyword)
  );
}

function sameReaderParameter(state, expression, index) {
  return (
    ts.isIdentifier(expression) &&
    state.context.checker.getSymbolAtLocation(expression) ===
      state.context.checker.getSymbolAtLocation(state.callable.parameters[index].name)
  );
}

function defaultLibrarySymbol(context, symbol) {
  return (
    Boolean(symbol?.declarations?.length) &&
    symbol.declarations.every((declaration) =>
      context.program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    )
  );
}

function rawReaderCondition(state, expression) {
  if (
    !ts.isCallExpression(expression) ||
    expression.typeArguments?.length ||
    expression.arguments.length !== 2 ||
    !ts.isPropertyAccessExpression(expression.expression)
  )
    return false;
  return (
    rawReaderTarget(state, expression.expression) &&
    expression.arguments.every((argument, index) => sameReaderParameter(state, argument, index))
  );
}

function defaultLibraryPropertyTarget(state, target, receiver, member) {
  return (
    target.name.text === member &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === receiver &&
    defaultLibrarySymbol(state.context, expressionSymbol(state.compiler, state.context, target)) &&
    defaultLibrarySymbol(
      state.context,
      state.context.checker.getSymbolAtLocation(target.expression),
    )
  );
}

function rawReaderTarget(state, target) {
  return defaultLibraryPropertyTarget(state, target, "Object", "hasOwn");
}

function rawReaderExpression(state, expression) {
  if (
    !expression ||
    !ts.isConditionalExpression(expression) ||
    !rawReaderCondition(state, expression.condition)
  )
    return false;
  const present = expression.whenTrue;
  return (
    ts.isElementAccessExpression(present) &&
    sameReaderParameter(state, present.expression, 0) &&
    sameReaderParameter(state, present.argumentExpression, 1) &&
    rawReaderAbsent(state, expression.whenFalse)
  );
}

function rawReaderAbsent(state, absent) {
  const symbol = state.context.checker.getSymbolAtLocation(absent);
  return (
    ts.isIdentifier(absent) &&
    absent.text === "undefined" &&
    Boolean(state.context.checker.getTypeAtLocation(absent).flags & ts.TypeFlags.Undefined) &&
    (!symbol?.declarations?.length || defaultLibrarySymbol(state.context, symbol))
  );
}

function rawReaderSignature(state) {
  const { callable } = state;
  return (
    ts.isFunctionDeclaration(callable) &&
    callable.name &&
    !callable.typeParameters?.length &&
    callable.parameters.length === 2 &&
    rawReaderParameter(state, 0, "record") &&
    rawReaderParameter(state, 1, "key") &&
    callable.type?.kind === ts.SyntaxKind.UnknownKeyword
  );
}

function singleReaderReturn(callable) {
  if (!ts.isBlock(callable.body) || callable.body.statements.length !== 1) return null;
  const statement = callable.body.statements[0];
  return ts.isReturnStatement(statement) ? statement : null;
}

function rawReaderFacts(compiler, identity) {
  const implementation = declarationCallable(compiler, identity);
  const state = { ...implementation, compiler };
  const statement = singleReaderReturn(state.callable);
  if (!rawReaderSignature(state) || !statement || !rawReaderExpression(state, statement.expression))
    throw new TypeError("unsupported-raw-own-property-reader");
  compiler.assertCurrent();
  return {
    identity,
    slot: { ...callableSlots(compiler, identity).result, rule: "anti-slop/no-unknown-returns" },
  };
}

function observationParameter(parameter, kind) {
  return (
    parameter &&
    ts.isIdentifier(parameter.name) &&
    !parameter.initializer &&
    !parameter.questionToken &&
    !parameter.dotDotDotToken &&
    parameter.type?.kind === kind
  );
}

function observationKey(context, key) {
  if (!observationParameter(key, ts.SyntaxKind.TypeReference)) return false;
  const annotation = key.type;
  return (
    ts.isIdentifier(annotation.typeName) &&
    annotation.typeName.text === "PropertyKey" &&
    !annotation.typeArguments?.length &&
    defaultLibrarySymbol(context, context.checker.getSymbolAtLocation(annotation.typeName))
  );
}

function privateObservationCallable(callable, result) {
  return (
    ts.isFunctionDeclaration(callable) &&
    !exportedDeclaration(callable) &&
    !callable.typeParameters?.length &&
    !callable.asteriskToken &&
    !callable.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    callable.parameters.length === 2 &&
    callable.type?.kind === result
  );
}

function observationSignature(state) {
  return (
    privateObservationCallable(state.callable, ts.SyntaxKind.UnknownKeyword) &&
    observationParameter(state.callable.parameters[0], ts.SyntaxKind.ObjectKeyword) &&
    observationKey(state.context, state.callable.parameters[1])
  );
}

function observationTarget(state, target) {
  return defaultLibraryPropertyTarget(state, target, "Reflect", "get");
}

function observationCall(state, call) {
  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.typeArguments?.length ||
    call.arguments.length !== 2 ||
    !ts.isPropertyAccessExpression(call.expression)
  )
    return false;
  return (
    observationTarget(state, call.expression) &&
    call.arguments.every((argument, index) => sameReaderParameter(state, argument, index))
  );
}

function observationBody(state) {
  if (state.callable.body?.statements.length !== 2) return null;
  const [assignment, returned] = state.callable.body.statements;
  if (!constAssignmentAndIdentifierReturn(assignment, returned)) return null;
  const local = assignment.declarationList.declarations[0];
  if (
    !ts.isIdentifier(local.name) ||
    local.type?.kind !== ts.SyntaxKind.UnknownKeyword ||
    !observationCall(state, local.initializer) ||
    state.context.checker.getSymbolAtLocation(local.name) !==
      state.context.checker.getSymbolAtLocation(returned.expression)
  )
    return null;
  return local.initializer;
}

function reachedObservationCallables(compiler, identity) {
  const root = declarationCallable(compiler, identity);
  const states = new Map([[identity.producer.start, { ...root, identity, compiler }]]);
  for (const state of states.values()) {
    for (const call of consumerParticipatingCalls(compiler, state)) {
      const target = localRawCallable(compiler, state.context, state.source, call.expression);
      if (
        !target ||
        exportedDeclaration(target.declaration) ||
        states.has(target.identity.producer.start)
      )
        continue;
      if (states.size >= compiler.state.limits.aliases) throw new TypeError("symbol-alias-budget");
      states.set(target.identity.producer.start, { ...state, ...target });
    }
  }
  return [...states.values()];
}

function privateObservationReferences(state) {
  return !sourceNodes(state.compiler, state.source).some(
    (node) => helperReference(state, node) && !referenceCall(node),
  );
}

function observationIdentifier(state, node, declaration) {
  return (
    ts.isIdentifier(node) &&
    state.context.checker.getSymbolAtLocation(node) ===
      state.context.checker.getSymbolAtLocation(declaration.name)
  );
}

function observationConst(statement) {
  if (!ts.isVariableStatement(statement)) return null;
  const list = statement.declarationList;
  if (!(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1) return null;
  const declaration = list.declarations[0];
  return ts.isIdentifier(declaration.name) && !declaration.type && declaration.initializer
    ? declaration
    : null;
}

function observationLibraryCall(state, call, method, count) {
  if (
    !ts.isCallExpression(call) ||
    call.typeArguments?.length ||
    call.arguments.length !== count ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== method
  )
    return false;
  const signature = state.context.checker.getResolvedSignature(call);
  return (
    defaultLibrarySymbol(
      state.context,
      state.context.checker.getSymbolAtLocation(call.expression.name),
    ) &&
    Boolean(signature?.declaration) &&
    state.context.program.isSourceFileDefaultLibrary(signature.declaration.getSourceFile())
  );
}

function observationOwnKeys(state, call, index) {
  return (
    observationLibraryCall(state, call, "ownKeys", 1) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "Reflect" &&
    defaultLibrarySymbol(
      state.context,
      state.context.checker.getSymbolAtLocation(call.expression.expression),
    ) &&
    sameReaderParameter(state, call.arguments[0], index)
  );
}

function observationSetTarget(state, expression) {
  return (
    ts.isIdentifier(expression) &&
    expression.text === "Set" &&
    defaultLibrarySymbol(state.context, state.context.checker.getSymbolAtLocation(expression))
  );
}

function observationKeySet(state, node) {
  if (!ts.isNewExpression(node) || node.typeArguments?.length || node.arguments?.length !== 1)
    return false;
  const signature = state.context.checker.getResolvedSignature(node);
  return (
    observationSetTarget(state, node.expression) &&
    Boolean(signature?.declaration) &&
    state.context.program.isSourceFileDefaultLibrary(signature.declaration.getSourceFile()) &&
    observationOwnKeys(state, node.arguments[0], 1)
  );
}

function observationMember(state, node, name, declaration) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === name &&
    observationIdentifier(state, node.expression, declaration) &&
    defaultLibrarySymbol(state.context, state.context.checker.getSymbolAtLocation(node.name))
  );
}

function observationKeyCount(state, node, left, right) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    observationMember(state, node.left, "length", left) &&
    observationMember(state, node.right, "size", right)
  );
}

function observationCallbackParameter(parameter) {
  return (
    ts.isIdentifier(parameter.name) &&
    !parameter.type &&
    !parameter.initializer &&
    !parameter.questionToken &&
    !parameter.dotDotDotToken
  );
}

function observationKeyCallback(callback) {
  if (!ts.isArrowFunction(callback)) return false;
  if (callback.modifiers?.length || callback.typeParameters?.length || callback.type) return false;
  return callback.parameters.length === 1 && observationCallbackParameter(callback.parameters[0]);
}

function observationMembership(state, call, left, right) {
  if (
    !observationLibraryCall(state, call, "every", 1) ||
    !observationIdentifier(state, call.expression.expression, left)
  )
    return false;
  const callback = call.arguments[0];
  if (!observationKeyCallback(callback)) return false;
  const contains = callback.body;
  return (
    observationLibraryCall(state, contains, "has", 1) &&
    observationIdentifier(state, contains.expression.expression, right) &&
    observationIdentifier(state, contains.arguments[0], callback.parameters[0])
  );
}

function ownKeyObservationSignature(state) {
  return (
    privateObservationCallable(state.callable, ts.SyntaxKind.BooleanKeyword) &&
    state.callable.parameters.every((parameter) =>
      observationParameter(parameter, ts.SyntaxKind.ObjectKeyword),
    )
  );
}

function observationOwnKeyReturn(state, result, left, right) {
  return (
    ts.isBinaryExpression(result) &&
    result.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    observationKeyCount(state, result.left, left, right) &&
    observationMembership(state, result.right, left, right)
  );
}

function ownKeyObservationBody(state) {
  if (state.callable.body?.statements.length !== 3) return false;
  const [first, second, returned] = state.callable.body.statements;
  const left = observationConst(first);
  const right = observationConst(second);
  if (!left || !right || !ts.isReturnStatement(returned) || !returned.expression) return false;
  return (
    observationOwnKeys(state, left.initializer, 0) &&
    observationKeySet(state, right.initializer) &&
    observationOwnKeyReturn(state, returned.expression, left, right)
  );
}

function observationObjectSlots(state) {
  return state.callable.parameters.map((parameter, index) => ({
    ...annotationSlot(
      state.context,
      state.source,
      parameter.type,
      state.identity,
      "parameter",
      index,
    ),
    rule: "anti-slop/no-object-parameters",
  }));
}

function observationRootFacts(identity, root) {
  if (
    !exportedDeclaration(root.callable) ||
    root.callable.parameters.length !== 1 ||
    !observationParameter(root.callable.parameters[0], ts.SyntaxKind.ObjectKeyword)
  )
    throw new TypeError("unsupported-property-observation-input");
  return {
    slots: observationObjectSlots(root),
    fact: { form: "raw-object-input", identity },
  };
}

function observationOwnKeyFacts(states) {
  const candidates = states.filter(ownKeyObservationSignature);
  if (
    candidates.length !== 1 ||
    !privateObservationReferences(candidates[0]) ||
    !ownKeyObservationBody(candidates[0])
  )
    throw new TypeError("unsupported-own-key-observation");
  return {
    slots: observationObjectSlots(candidates[0]),
    fact: { form: "own-key-identity", identity: candidates[0].identity },
  };
}

function wholeObservationAlias(symbol) {
  const declaration = symbol?.valueDeclaration;
  return declaration && !declaration.type && !exportedDeclaration(declaration)
    ? aliasInitializer(declaration)
    : null;
}

function wholeObservationOrigin(state, expression) {
  if (rawOrigin(state, expression)?.length !== 0) return false;
  const seen = new Set();
  let node = rawParentheses(expression);
  while (ts.isIdentifier(node)) {
    const symbol = state.context.checker.getSymbolAtLocation(node);
    if (symbol === state.parameterSymbol) return true;
    if (seen.has(symbol) || seen.size >= state.compiler.state.limits.aliases)
      throw new TypeError("symbol-alias-budget");
    seen.add(symbol);
    const initializer = wholeObservationAlias(symbol);
    if (!initializer) return false;
    node = rawParentheses(initializer);
  }
  return false;
}

function observationReceiverAlias(node) {
  const declaration = node.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer === node &&
    !declaration.type &&
    !exportedDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    Boolean(aliasInitializer(declaration))
  );
}

function observationReceiverCall(call, receiver) {
  return (
    ts.isCallExpression(call) &&
    call.arguments.length === 2 &&
    call.arguments[0] === receiver &&
    !call.typeArguments?.length
  );
}

function observationReceiverUse(state, node, observer) {
  if (!directRawBody(node, state.callable)) return false;
  if (declarationReference(node)) return true;
  let outer = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  if (observationReceiverAlias(outer)) return true;
  const call = outer.parent;
  if (!observationReceiverCall(call, outer)) return false;
  const target = localRawCallable(state.compiler, state.context, state.source, call.expression);
  return Boolean(target && sameProducer(target.identity, observer.identity));
}

function observationReceiverReference(state, node) {
  const symbol = referenceValueSymbol(state.context, node);
  if (symbol === state.parameterSymbol) return true;
  const initializer = wholeObservationAlias(symbol);
  return Boolean(initializer && wholeObservationOrigin(state, initializer));
}

function writtenObservationAlias(state, node) {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer)
    return false;
  if (!wholeObservationOrigin(state, node.initializer)) return false;
  const symbol = state.context.checker.getSymbolAtLocation(node.name);
  return Boolean(symbol && writtenSymbol(state.context, state.nodes, symbol));
}

function observationReceiverSafe(state, observer) {
  if (writtenSymbol(state.context, state.nodes, state.parameterSymbol)) return false;
  if (state.nodes.some((node) => writtenObservationAlias(state, node))) return false;
  return !state.nodes.some(
    (node) =>
      ts.isIdentifier(node) &&
      node.getStart() >= state.callable.body.getStart() &&
      node.end <= state.callable.body.end &&
      observationReceiverReference(state, node) &&
      !observationReceiverUse(state, node, observer),
  );
}

function directObservationChecker(state, root, qualified, observer) {
  const parameter = state.callable.parameters[state.index];
  if (state.callable.parameters.some((candidate) => candidate.initializer)) return false;
  return (
    state.key !== root.key &&
    qualified.has(state.key) &&
    observationParameter(parameter, ts.SyntaxKind.ObjectKeyword) &&
    state.incoming.length > 0 &&
    state.incoming.every(
      (edge) =>
        edge.state === root.key &&
        edge.origin.length === 0 &&
        wholeObservationOrigin(root, edge.call.arguments[state.index]),
    ) &&
    observationReceiverSafe(state, observer)
  );
}

function physicalObservationCallable(state, call, count, index, result) {
  if (!markerDirectCall(call, count)) return null;
  const target = localRawCallable(state.compiler, state.context, state.source, call.expression);
  if (
    !target ||
    !markerPrivateCallable(target, count) ||
    !physicalProtocolCallable(target) ||
    target.callable.type?.kind !== result ||
    !observationParameter(target.callable.parameters[index], ts.SyntaxKind.ObjectKeyword)
  )
    return null;
  const signature = typedNamedCallable(state.context, target.callable);
  return signature && state.context.checker.getResolvedSignature(call) === signature
    ? rawState(state.compiler, state.context, state.source, state.nodes, target, index)
    : null;
}

function physicalObservationReferences(state, call) {
  return !state.nodes.some((node) => helperReference(state, node) && referenceCall(node) !== call);
}

function physicalProtocolCallable(state) {
  return (
    !state.callable.typeParameters?.length &&
    !state.callable.asteriskToken &&
    !state.callable.modifiers?.some((entry) => entry.kind === ts.SyntaxKind.AsyncKeyword) &&
    !state.callable.parameters.some((entry) => entry.initializer)
  );
}

function physicalRegistrationProtocol(root, call) {
  const reader = markerCallable(root, call, 1);
  const read = reader && registrationTransportRead(reader);
  if (!read || !physicalProtocolCallable(reader)) return null;
  const candidates = root.source.statements
    .filter(ts.isFunctionDeclaration)
    .map((callable) => ({
      ...root,
      callable,
      declaration: callable,
      identity: canonicalDeclaration(root.compiler, callable, null),
    }))
    .filter(metadataSourceSignature)
    .map((state) => ({ state, flow: registrationTransportFlow(state) }))
    .filter(
      ({ state, flow }) =>
        flow && canonicalCall(root.compiler, state.context, flow.read.expression, reader.identity),
    );
  if (candidates.length !== 1) return null;
  const { state, flow } = candidates[0];
  const writer = markerCallable(state, flow.write, 2);
  const write = writer && registrationTransportWrite(writer);
  return write && physicalProtocolCallable(writer) && registrationTransportKey(state, read, write)
    ? { reader, writer, copier: state }
    : null;
}

function physicalRegistrationRefusalCondition(state, condition, local) {
  return (
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    observationIdentifier(state, condition.left, local) &&
    rawReaderAbsent(state, condition.right)
  );
}

function physicalRegistrationRefusal(state, statement, local) {
  if (
    !ts.isIfStatement(statement) ||
    statement.elseStatement ||
    !physicalRegistrationRefusalCondition(state, statement.expression, local)
  )
    return false;
  const body = statement.thenStatement;
  return (
    ts.isBlock(body) && body.statements.length === 1 && ts.isThrowStatement(body.statements[0])
  );
}

function physicalRegistrationCapture(root, statement, index) {
  const local = observationConst(statement);
  if (
    !local ||
    !markerDirectCall(local.initializer, 1) ||
    !wholeObservationOrigin(root, local.initializer.arguments[0])
  )
    return null;
  const refusal = root.callable.body.statements[index + 1];
  const protocol = physicalRegistrationProtocol(root, local.initializer);
  return protocol && refusal && physicalRegistrationRefusal(root, refusal, local)
    ? { local, refusal, protocol }
    : null;
}

function physicalNamedParameter(state, index, domain) {
  const parameter = state.callable.parameters[index];
  return (
    parameter?.type &&
    ts.isTypeReferenceNode(parameter.type) &&
    state.context.checker.getTypeAtLocation(parameter.type) === domain
  );
}

function physicalCanonicalResult(root, target, node, domain) {
  return (
    target?.callable.type &&
    ts.isTypeReferenceNode(target.callable.type) &&
    root.context.checker.getTypeAtLocation(target.callable.type) === domain &&
    root.context.checker.getTypeAtLocation(node) === domain
  );
}

function physicalCanonicalArgument(root, node, domain) {
  if (!ts.isIdentifier(node)) return false;
  const declaration = root.context.checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.type ||
    !aliasInitializer(declaration) ||
    !markerDirectCall(declaration.initializer, 1) ||
    !wholeObservationOrigin(root, declaration.initializer.arguments[0])
  )
    return false;
  const target = markerCallable(root, declaration.initializer, 1);
  return physicalCanonicalResult(root, target, node, domain);
}

function physicalLocalReferences(root, capture, call) {
  const symbol = root.context.checker.getSymbolAtLocation(capture.local.name);
  return !root.nodes.some(
    (node) =>
      ts.isIdentifier(node) &&
      referenceValueSymbol(root.context, node) === symbol &&
      !declarationReference(node) &&
      node !== capture.refusal.expression.left &&
      node !== call.arguments[1],
  );
}

function physicalWrapperCall(root, capture, domain) {
  const calls = stateCalls(root).filter(
    (call) =>
      markerDirectCall(call, 3) &&
      call.getStart() > capture.refusal.end &&
      observationIdentifier(root, call.arguments[1], capture.local),
  );
  if (calls.length !== 1 || !physicalLocalReferences(root, capture, calls[0])) return null;
  const call = calls[0];
  const wrapper = physicalObservationCallable(root, call, 3, 1, ts.SyntaxKind.VoidKeyword);
  return wrapper &&
    wholeObservationOrigin(root, call.arguments[0]) &&
    physicalCanonicalArgument(root, call.arguments[2], domain) &&
    observationParameter(wrapper.callable.parameters[0], ts.SyntaxKind.ObjectKeyword) &&
    physicalNamedParameter(wrapper, 2, domain) &&
    physicalObservationReferences(wrapper, call)
    ? { wrapper, call }
    : null;
}

function physicalComparisonCall(wrapper, domain) {
  const parameter = wrapper.callable.parameters[wrapper.index];
  const calls = stateCalls(wrapper).filter(
    (call) =>
      markerDirectCall(call, 2) &&
      observationIdentifier(wrapper, call.arguments[0], parameter) &&
      observationIdentifier(wrapper, call.arguments[1], wrapper.callable.parameters[2]),
  );
  if (calls.length !== 1) return null;
  const call = calls[0];
  const comparison = physicalObservationCallable(wrapper, call, 2, 0, ts.SyntaxKind.BooleanKeyword);
  return comparison &&
    physicalNamedParameter(comparison, 1, domain) &&
    physicalObservationReferences(comparison, call)
    ? { comparison, call }
    : null;
}

function physicalReceiverReferences(state) {
  return state.nodes.filter(
    (node) =>
      ts.isIdentifier(node) &&
      referenceValueSymbol(state.context, node) === state.parameterSymbol &&
      !declarationReference(node),
  );
}

function physicalWrapperReferences(wrapper, call) {
  const references = physicalReceiverReferences(wrapper);
  return (
    references.length === 1 &&
    references[0] === call.arguments[0] &&
    directRawBody(references[0], wrapper.callable)
  );
}

function physicalOwnKeyCall(state, call, observer) {
  if (
    !markerDirectCall(call, 2) ||
    !observationIdentifier(state, call.arguments[1], state.callable.parameters[1])
  )
    return false;
  const target = localRawCallable(state.compiler, state.context, state.source, call.expression);
  const owned = target && { ...state, ...target };
  return (
    owned &&
    !sameProducer(owned.identity, observer.identity) &&
    ownKeyObservationSignature(owned) &&
    privateObservationReferences(owned) &&
    ownKeyObservationBody(owned)
  );
}

function physicalComparisonReferences(state, observer) {
  const references = physicalReceiverReferences(state);
  return (
    references.length > 0 &&
    references.every((node) => {
      const call = node.parent;
      if (!directRawBody(node, state.callable) || !observationReceiverCall(call, node))
        return false;
      return (
        canonicalCall(state.compiler, state.context, call.expression, observer.identity) ||
        physicalOwnKeyCall(state, call, observer)
      );
    })
  );
}

function physicalRegistrationSlots(root, legacy, states, capture, observer, domain) {
  const selected = physicalWrapperCall(root, capture, domain);
  if (
    !selected ||
    !legacy.some(
      (state) =>
        state.identity.producer.start === selected.wrapper.identity.producer.start &&
        state.index === 0,
    )
  )
    return [];
  const compared = physicalComparisonCall(selected.wrapper, domain);
  if (
    !compared ||
    !physicalWrapperReferences(selected.wrapper, compared.call) ||
    !physicalComparisonReferences(compared.comparison, observer)
  )
    return [];
  const supported = [selected.wrapper, compared.comparison];
  const keys = new Set(states.keys());
  for (const state of [
    ...supported,
    capture.protocol.reader,
    capture.protocol.writer,
    capture.protocol.copier,
  ])
    for (let index = 0; index < state.callable.parameters.length; index += 1)
      keys.add(`${state.identity.producer.start}:${index}`);
  if (keys.size > root.compiler.state.limits.aliases) throw new TypeError("symbol-alias-budget");
  return supported.map((state) => ({
    ...annotationSlot(
      state.context,
      state.source,
      state.callable.parameters[state.index].type,
      state.identity,
      "parameter",
      state.index,
    ),
    rule: "anti-slop/no-object-parameters",
    physicalRegistrationInput: true,
    observationRoots: [{ identity: root.identity, index: 0 }],
  }));
}

function physicalRegistrationObservationFacts(root, legacy, states, observer) {
  if (!root.callable.type) return [];
  const domain = root.context.checker.getTypeAtLocation(root.callable.type);
  if (!namedObjectResult(domain) || !observationOwnedResult(root.compiler, domain, root.identity))
    return [];
  const captures = root.callable.body.statements
    .map((statement, index) => physicalRegistrationCapture(root, statement, index))
    .filter(Boolean);
  return captures.length === 1
    ? physicalRegistrationSlots(root, legacy, states, captures[0], observer, domain)
    : [];
}

function directObservationCheckerFacts(compiler, reached, observer) {
  const owned = reached[0];
  // Validate the actual boundary signature without implicitly adapting its coordinate.
  observationRootFacts(owned.identity, owned);
  const nodes = sourceNodes(compiler, owned.source);
  const root = rawState(compiler, owned.context, owned.source, nodes, owned, 0);
  if (!root || writtenSymbol(root.context, nodes, root.parameterSymbol))
    throw new TypeError("unsupported-direct-observation-root");
  const states = new Map([[root.key, root]]);
  // This capability is intentionally DIRECT: only the actual root's call arguments form edges.
  rawCallEdges(root, states, [root]);
  if (states.size > compiler.state.limits.aliases) throw new TypeError("symbol-alias-budget");
  assertRawAcyclic(states);
  const qualified = qualifiedRawStates(root, states);
  const supported = [...states.values()].filter((state) =>
    directObservationChecker(state, root, qualified, observer),
  );
  if (supported.length === 0) throw new TypeError("unsupported-direct-observation-checkers");
  const slots = supported.map((state) => ({
    ...annotationSlot(
      state.context,
      state.source,
      state.callable.parameters[state.index].type,
      state.identity,
      "parameter",
      state.index,
    ),
    rule: "anti-slop/no-object-parameters",
    observationRoots: [{ identity: root.identity, index: 0 }],
  }));
  slots.push(...physicalRegistrationObservationFacts(root, supported, states, observer));
  return slots;
}

function assertObservationOptions(options) {
  if (options.rawObjectInput !== undefined && options.rawObjectInput !== true)
    throw new TypeError("unsupported-property-observation-input");
  if (options.directRawCheckerInputs !== undefined && options.directRawCheckerInputs !== true)
    throw new TypeError("unsupported-direct-observation-option");
  const forms = options.additionalObservationForms;
  if (
    forms !== undefined &&
    (!Array.isArray(forms) || forms.length !== 1 || forms[0] !== "own-key-identity")
  )
    throw new TypeError("unsupported-property-observation-form");
  if (
    Object.keys(options).some(
      (key) =>
        key !== "rawObjectInput" &&
        key !== "additionalObservationForms" &&
        key !== "directRawCheckerInputs",
    )
  )
    throw new TypeError("unsupported-property-observation-option");
}

function additionalObservationFacts(compiler, identity, states, options, observer) {
  assertObservationOptions(options);
  const slots = [];
  const facts = [];
  if (options.rawObjectInput === true) {
    const root = observationRootFacts(identity, states[0]);
    slots.push(...root.slots);
    facts.push(root.fact);
  }
  if (options.additionalObservationForms !== undefined) {
    const keys = observationOwnKeyFacts(states);
    slots.push(...keys.slots);
    facts.push(keys.fact);
  }
  if (options.directRawCheckerInputs === true)
    slots.push(...directObservationCheckerFacts(compiler, states, observer));
  compiler.assertCurrent();
  return { slots, facts };
}

function booleanObservationFacts(compiler, identity, states, observer, options) {
  assertObservationOptions(options);
  const root = states[0];
  const signatures = root.context.checker.getTypeAtLocation(root.callable).getCallSignatures();
  if (
    !objectValidatorSignature(root.callable) ||
    root.callable.type.kind !== ts.SyntaxKind.BooleanKeyword ||
    signatures.length !== 1 ||
    (root.context.checker.getReturnTypeOfSignature(signatures[0]).flags &
      ts.TypeFlags.BooleanLike) ===
      0 ||
    options.additionalObservationForms !== undefined ||
    options.directRawCheckerInputs !== undefined
  )
    throw new TypeError("unsupported-object-observation-boundary");
  const { slots } = observationRootFacts(identity, root);
  compiler.assertCurrent();
  return {
    identity: observer.identity,
    root: identity,
    slots: slots.map((slot) => ({ ...slot, observationRoots: [{ identity, index: 0 }] })),
    additionalObservations: [{ form: "boolean-object-observation", identity }],
  };
}

function propertyObservationFacts(compiler, identity, options = {}) {
  const states = reachedObservationCallables(compiler, identity);
  const candidates = states.filter((state) => observationSignature(state));
  if (candidates.length !== 1) throw new TypeError("unsupported-property-observation-helper");
  const state = candidates[0];
  if (!privateObservationReferences(state))
    throw new TypeError("unsupported-property-observation-exposure");
  const call = observationBody(state);
  if (!call) throw new TypeError("unsupported-property-observation-body");
  if (
    options.rawObjectInput === true &&
    states[0].callable.type?.kind === ts.SyntaxKind.BooleanKeyword
  )
    return booleanObservationFacts(compiler, identity, states, state, options);
  const slots = [
    {
      ...annotationSlot(
        state.context,
        state.source,
        state.callable.parameters[0].type,
        state.identity,
        "parameter",
        0,
      ),
      rule: "anti-slop/no-object-parameters",
    },
    {
      ...annotationSlot(state.context, state.source, state.callable.type, state.identity, "return"),
      rule: "anti-slop/no-unknown-returns",
    },
    {
      kind: "operation",
      path: state.identity.producer.path,
      ...nativeDiagnosticPosition(state.source, call.expression.getStart(state.source)),
      start: call.expression.getStart(state.source),
      end: call.expression.end,
      rule: "anti-slop/no-reflect-get",
    },
  ];
  const additional = additionalObservationFacts(compiler, identity, states, options, state);
  slots.push(...additional.slots);
  compiler.assertCurrent();
  return {
    identity: state.identity,
    root: identity,
    slots,
    ...(additional.facts.length ? { additionalObservations: additional.facts } : {}),
  };
}

function metadataTargetReference(state, annotation) {
  return (
    annotation &&
    ts.isTypeReferenceNode(annotation) &&
    ts.isIdentifier(annotation.typeName) &&
    !annotation.typeArguments?.length &&
    state.context.checker.getSymbolAtLocation(annotation.typeName) ===
      state.context.checker.getSymbolAtLocation(state.callable.typeParameters[0].name)
  );
}

function metadataSourceCallable(callable) {
  return (
    typedFunctionDeclaration(callable) &&
    exportedDeclaration(callable) &&
    !callable.asteriskToken &&
    !callable.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    callable.typeParameters?.length === 1 &&
    callable.parameters.length === 2
  );
}

function metadataSourceSignature(state) {
  const callable = state.callable;
  const parameter = callable.typeParameters?.[0];
  return (
    metadataSourceCallable(callable) &&
    parameter.constraint?.kind === ts.SyntaxKind.ObjectKeyword &&
    !parameter.default &&
    observationParameter(callable.parameters[0], ts.SyntaxKind.ObjectKeyword) &&
    observationParameter(callable.parameters[1], ts.SyntaxKind.TypeReference) &&
    metadataTargetReference(state, callable.parameters[1].type) &&
    metadataTargetReference(state, callable.type)
  );
}

function metadataTargetType(state, signature) {
  const { checker } = state.context;
  const parameter = state.callable.typeParameters[0];
  const target = checker.getTypeAtLocation(parameter);
  return (
    signature.typeParameters?.length === 1 &&
    !signature.thisParameter &&
    signature.typeParameters[0] === target &&
    checker.getTypeAtLocation(state.callable.parameters[1].type) === target &&
    checker.getTypeAtLocation(state.callable.type) === target &&
    checker.getReturnTypeOfSignature(signature) === target
  );
}

function metadataSourceFacts(compiler, identity) {
  const state = { ...declarationCallable(compiler, identity), identity };
  const signatures = state.context.checker.getTypeAtLocation(state.callable).getCallSignatures();
  if (
    !metadataSourceSignature(state) ||
    signatures.length !== 1 ||
    !metadataTargetType(state, signatures[0])
  )
    throw new TypeError("unsupported-metadata-source-boundary");
  const slot = annotationSlot(
    state.context,
    state.source,
    state.callable.parameters[0].type,
    identity,
    "parameter",
    0,
  );
  compiler.assertCurrent();
  return {
    identity,
    slots: [{ ...slot, rule: "anti-slop/no-object-parameters", rawMetadataSourceInput: true }],
  };
}

function markerDirectCall(call, count) {
  return (
    call &&
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    !call.typeArguments?.length &&
    call.arguments.length === count
  );
}

function markerWriterCall(statement) {
  const single =
    ts.isBlock(statement) && statement.statements.length === 1
      ? statement.statements[0]
      : statement;
  return ts.isExpressionStatement(single) && markerDirectCall(single.expression, 2)
    ? single.expression
    : null;
}

function markerCopyCondition(state, condition, local) {
  return (
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    observationIdentifier(state, condition.left, local) &&
    rawReaderAbsent(state, condition.right)
  );
}

function markerCopyArguments(state, local, write, returned) {
  return (
    markerDirectCall(local.initializer, 1) &&
    observationIdentifier(state, local.initializer.arguments[0], state.callable.parameters[0]) &&
    Boolean(write) &&
    observationIdentifier(state, write.arguments[0], state.callable.parameters[1]) &&
    observationIdentifier(state, write.arguments[1], local) &&
    Boolean(returned.expression) &&
    observationIdentifier(state, returned.expression, state.callable.parameters[1])
  );
}

function markerCopyFlow(state) {
  const statements = state.callable.body.statements;
  if (statements.length < 3) return null;
  const local = observationConst(statements.at(-3));
  const branch = statements.at(-2);
  const returned = statements.at(-1);
  if (
    !local ||
    !ts.isIfStatement(branch) ||
    branch.elseStatement ||
    !ts.isReturnStatement(returned)
  )
    return null;
  const write = markerWriterCall(branch.thenStatement);
  return markerCopyCondition(state, branch.expression, local) &&
    markerCopyArguments(state, local, write, returned)
    ? { read: local.initializer, write }
    : null;
}

function markerPrivateCallable(target, count) {
  return (
    Boolean(target) &&
    target.declaration === target.callable &&
    !exportedDeclaration(target.callable) &&
    target.callable.parameters.length === count &&
    observationParameter(target.callable.parameters[0], ts.SyntaxKind.ObjectKeyword)
  );
}

function markerCallable(state, call, count) {
  if (!markerDirectCall(call, count)) return null;
  const target = localRawCallable(state.compiler, state.context, state.source, call.expression);
  if (!markerPrivateCallable(target, count)) return null;
  const signature = typedNamedCallable(state.context, target.callable);
  const owned = { ...state, ...target, signature };
  return signature &&
    state.context.checker.getResolvedSignature(call) === signature &&
    target.identity.owner === state.identity.owner &&
    privateObservationReferences(owned)
    ? owned
    : null;
}

function markerBuiltin(state, call, base, method, count) {
  return (
    observationLibraryCall(state, call, method, count) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === base &&
    defaultLibrarySymbol(
      state.context,
      state.context.checker.getSymbolAtLocation(call.expression.expression),
    )
  );
}

function markerDescriptorProperties(node) {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 4) return null;
  const properties = new Map();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return null;
    if (properties.has(property.name.text)) return null;
    properties.set(property.name.text, property.initializer);
  }
  return properties;
}

function markerDescriptor(state, node) {
  const properties = markerDescriptorProperties(node);
  if (!properties) return false;
  return (
    Boolean(properties.get("value")) &&
    observationIdentifier(state, properties.get("value"), state.callable.parameters[1]) &&
    properties.get("enumerable")?.kind === ts.SyntaxKind.FalseKeyword &&
    properties.get("configurable")?.kind === ts.SyntaxKind.FalseKeyword &&
    properties.get("writable")?.kind === ts.SyntaxKind.FalseKeyword
  );
}

function markerWrite(state) {
  if (
    state.callable.type.kind !== ts.SyntaxKind.VoidKeyword ||
    state.callable.body.statements.length !== 1
  )
    return null;
  return markerDescriptorWrite(state, state.callable.body.statements[0]);
}

function markerDescriptorWrite(state, statement) {
  if (!ts.isExpressionStatement(statement)) return null;
  const call = statement.expression;
  return markerBuiltin(state, call, "Object", "defineProperty", 3) &&
    observationIdentifier(state, call.arguments[0], state.callable.parameters[0]) &&
    ts.isIdentifier(call.arguments[1]) &&
    markerDescriptor(state, call.arguments[2])
    ? call
    : null;
}

function markerReadResult(state, local, result) {
  return (
    markerDirectCall(local.initializer, 2) &&
    observationIdentifier(state, local.initializer.arguments[0], state.callable.parameters[0]) &&
    ts.isIdentifier(local.initializer.arguments[1]) &&
    typedPredicateCall(result.condition) &&
    observationIdentifier(state, result.condition.arguments[0], local) &&
    observationIdentifier(state, result.whenTrue, local) &&
    rawReaderAbsent(state, result.whenFalse)
  );
}

function markerRead(state) {
  if (state.callable.body.statements.length !== 2) return null;
  const local = observationConst(state.callable.body.statements[0]);
  const returned = state.callable.body.statements[1];
  if (
    !local ||
    !ts.isReturnStatement(returned) ||
    !returned.expression ||
    !ts.isConditionalExpression(returned.expression)
  )
    return null;
  if (!markerReadResult(state, local, returned.expression)) return null;
  const observer = markerCallable(state, local.initializer, 2);
  return observer && observationSignature(observer) && observationBody(observer)
    ? { read: local.initializer, check: returned.expression.condition }
    : null;
}

function markerResultDomain(state, annotation, domain) {
  if (!ts.isUnionTypeNode(annotation) || annotation.types.length !== 2) return false;
  const named = annotation.types.find((arm) => ts.isTypeReferenceNode(arm));
  const result = named && typedDomain(state.compiler, state.context, named);
  return (
    annotation.types.some((arm) => arm.kind === ts.SyntaxKind.UndefinedKeyword) &&
    Boolean(result) &&
    JSON.stringify(result.identity) === JSON.stringify(domain.identity)
  );
}

function markerDomain(state, reader, check) {
  const domain = typedDomain(state.compiler, state.context, state.callable.parameters[1].type);
  const predicate = typedDirectPredicate(state.compiler, reader, check);
  const declaration = typedPredicateDeclaration(reader, check);
  return (
    Boolean(domain) &&
    domain.identity.producer.path === state.identity.producer.path &&
    Boolean(predicate) &&
    !exportedDeclaration(declaration) &&
    JSON.stringify(predicate.domain.identity) === JSON.stringify(domain.identity) &&
    markerResultDomain(state, reader.callable.type, domain)
  );
}

function markerTypeKeyReference(node) {
  const computed = node.parent;
  return (
    ts.isComputedPropertyName(computed) &&
    computed.expression === node &&
    ts.isPropertySignature(computed.parent)
  );
}

function markerOwnedKey(state, declaration) {
  return (
    declaration.getSourceFile() === state.source &&
    !declaration.type &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    declaration.parent.declarations.length === 1 &&
    Boolean(declaration.parent.flags & ts.NodeFlags.Const) &&
    declaration.parent.parent.parent === state.source
  );
}

function markerPrivateKey(state, declaration) {
  return markerOwnedKey(state, declaration) && !exportedDeclaration(declaration.parent.parent);
}

function markerKeyDeclaration(state, symbol) {
  const declaration = symbol?.valueDeclaration;
  if (
    !symbol ||
    symbol.declarations?.length !== 1 ||
    !declaration ||
    !ts.isVariableDeclaration(declaration)
  )
    return null;
  return markerPrivateKey(state, declaration) ? declaration : null;
}

function markerKeyInitializer(state, declaration) {
  const call = declaration.initializer;
  return (
    Boolean(call) &&
    markerBuiltin(state, call, "Symbol", "for", 1) &&
    ts.isStringLiteral(call.arguments[0])
  );
}

function markerKey(state, read, write) {
  const { checker } = state.context;
  const symbol = checker.getSymbolAtLocation(read.arguments[1]);
  const declaration = markerKeyDeclaration(state, symbol);
  if (
    !declaration ||
    !markerKeyInitializer(state, declaration) ||
    checker.getSymbolAtLocation(write.arguments[1]) !== symbol
  )
    return false;
  return !sourceNodes(state.compiler, state.source).some(
    (node) =>
      ts.isIdentifier(node) &&
      referenceValueSymbol(state.context, node) === symbol &&
      node !== declaration.name &&
      node !== read.arguments[1] &&
      node !== write.arguments[1] &&
      !markerTypeKeyReference(node),
  );
}

function markerFlowCallables(state, flow) {
  const reader = flow && markerCallable(state, flow.read, 1);
  const writer = flow && markerCallable(state, flow.write, 2);
  return { reader, writer };
}

function markerPairFacts(compiler, identity) {
  const state = { ...declarationCallable(compiler, identity), identity, compiler };
  const flow = markerCopyFlow(state);
  const { reader, writer } = markerFlowCallables(state, flow);
  const read = reader && markerRead(reader);
  const write = writer && markerWrite(writer);
  if (
    !read ||
    !write ||
    !markerDomain(writer, reader, read.check) ||
    !markerKey(state, read.read, write)
  )
    throw new TypeError("unsupported-owned-marker-pair");
  const identities = new Set(
    [identity, reader.identity, writer.identity].map((entry) => JSON.stringify(entry)),
  );
  if (identities.size > compiler.state.limits.aliases) throw new TypeError("symbol-alias-budget");
  const slots = [writer, reader].map((owned) => ({
    ...annotationSlot(
      owned.context,
      owned.source,
      owned.callable.parameters[0].type,
      owned.identity,
      "parameter",
      0,
    ),
    rule: "anti-slop/no-object-parameters",
    rawMetadataSourceInput: true,
    ownedMarkerPairInput: true,
  }));
  return { identities, slots };
}

function markerPairSlots(compiler, identity) {
  return markerPairFacts(compiler, identity).slots;
}

function metadataMarkerPairFacts(compiler, identity) {
  compiler.assertCurrent();
  try {
    const facts = metadataSourceFacts(compiler, identity);
    return { ...facts, slots: [...facts.slots, ...markerPairSlots(compiler, identity)] };
  } finally {
    compiler.assertCurrent();
  }
}

function registrationTransportFlow(state) {
  const statements = state.callable.body.statements;
  if (statements.length !== 4 || !markerCopyFlow(state)) return null;
  const write = markerWriterCall(statements[0]);
  const read = write?.arguments[1];
  return write &&
    markerDirectCall(read, 1) &&
    observationIdentifier(state, write.arguments[0], state.callable.parameters[1]) &&
    observationIdentifier(state, read.arguments[0], state.callable.parameters[0])
    ? { read, write }
    : null;
}

function registrationObjectResult(annotation) {
  return Boolean(
    annotation &&
    ts.isUnionTypeNode(annotation) &&
    annotation.types.length === 2 &&
    annotation.types.some((arm) => arm.kind === ts.SyntaxKind.ObjectKeyword) &&
    annotation.types.some((arm) => arm.kind === ts.SyntaxKind.UndefinedKeyword),
  );
}

function registrationObjectTypeof(state, expression, local) {
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isTypeOfExpression(expression.left) &&
    observationIdentifier(state, expression.left.expression, local) &&
    ts.isStringLiteral(expression.right) &&
    expression.right.text === "object"
  );
}

function registrationObjectCondition(state, condition, local) {
  if (
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
  )
    return false;
  const nonnull = condition.right;
  return (
    registrationObjectTypeof(state, condition.left, local) &&
    ts.isBinaryExpression(nonnull) &&
    nonnull.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    observationIdentifier(state, nonnull.left, local) &&
    nonnull.right.kind === ts.SyntaxKind.NullKeyword
  );
}

function registrationReadResult(state, local, result) {
  return (
    markerDirectCall(local.initializer, 2) &&
    observationIdentifier(state, local.initializer.arguments[0], state.callable.parameters[0]) &&
    ts.isIdentifier(local.initializer.arguments[1]) &&
    registrationObjectCondition(state, result.condition, local) &&
    observationIdentifier(state, result.whenTrue, local) &&
    rawReaderAbsent(state, result.whenFalse)
  );
}

function registrationReadObserver(state, call) {
  const observer = markerCallable(state, call, 2);
  return observer && observationSignature(observer) && observationBody(observer) ? call : null;
}

function registrationTransportRead(state) {
  if (!registrationObjectResult(state.callable.type) || state.callable.body.statements.length !== 2)
    return null;
  const local = observationConst(state.callable.body.statements[0]);
  const returned = state.callable.body.statements[1];
  if (
    !local ||
    local.type ||
    !ts.isReturnStatement(returned) ||
    !returned.expression ||
    !ts.isConditionalExpression(returned.expression)
  )
    return null;
  const result = returned.expression;
  if (!registrationReadResult(state, local, result)) return null;
  return registrationReadObserver(state, local.initializer);
}

function registrationTransportWrite(state) {
  const payload = state.callable.parameters[1];
  if (
    state.callable.type.kind !== ts.SyntaxKind.VoidKeyword ||
    !registrationObjectResult(payload.type) ||
    state.callable.body.statements.length !== 1
  )
    return null;
  const branch = state.callable.body.statements[0];
  if (
    !ts.isIfStatement(branch) ||
    branch.elseStatement ||
    !markerCopyCondition(state, branch.expression, payload)
  )
    return null;
  const single =
    ts.isBlock(branch.thenStatement) && branch.thenStatement.statements.length === 1
      ? branch.thenStatement.statements[0]
      : branch.thenStatement;
  return markerDescriptorWrite(state, single);
}

function registrationTransportKey(state, read, write) {
  const { checker } = state.context;
  const symbol = checker.getSymbolAtLocation(read.arguments[1]);
  const declaration = symbol?.valueDeclaration;
  if (
    !symbol ||
    symbol.declarations?.length !== 1 ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !markerOwnedKey(state, declaration) ||
    !markerKeyInitializer(state, declaration) ||
    checker.getSymbolAtLocation(write.arguments[1]) !== symbol
  )
    return false;
  return !sourceNodes(state.compiler, state.source).some(
    (node) =>
      ts.isIdentifier(node) &&
      referenceValueSymbol(state.context, node) === symbol &&
      node !== declaration.name &&
      node !== read.arguments[1] &&
      node !== write.arguments[1] &&
      !markerTypeKeyReference(node) &&
      !ts.isExportSpecifier(node.parent),
  );
}

function registrationTransportFacts(compiler, identity) {
  const state = { ...declarationCallable(compiler, identity), identity, compiler };
  const flow = registrationTransportFlow(state);
  const { reader, writer } = markerFlowCallables(state, flow);
  const read = reader && registrationTransportRead(reader);
  const write = writer && registrationTransportWrite(writer);
  if (!read || !write || !registrationTransportKey(state, read, write))
    throw new TypeError("unsupported-owned-registration-transport");
  const marker = markerPairFacts(compiler, identity);
  const identities = new Set([
    ...marker.identities,
    JSON.stringify(reader.identity),
    JSON.stringify(writer.identity),
  ]);
  if (identities.size > compiler.state.limits.aliases) throw new TypeError("symbol-alias-budget");
  const slots = [
    [writer, 0],
    [writer, 1],
    [reader, 0],
  ].map(([owned, index]) => ({
    ...annotationSlot(
      owned.context,
      owned.source,
      owned.callable.parameters[index].type,
      owned.identity,
      "parameter",
      index,
    ),
    rule: "anti-slop/no-object-parameters",
    rawMetadataSourceInput: true,
    ownedRegistrationTransportInput: true,
  }));
  return { slots, markerSlots: marker.slots };
}

function metadataRegistrationTransportFacts(compiler, identity, ownedMarkerPair) {
  compiler.assertCurrent();
  try {
    const facts = metadataSourceFacts(compiler, identity);
    const transport = registrationTransportFacts(compiler, identity);
    return {
      ...facts,
      slots: [
        ...facts.slots,
        ...(ownedMarkerPair ? transport.markerSlots : []),
        ...transport.slots,
      ],
    };
  } finally {
    compiler.assertCurrent();
  }
}

function metadataConsumerPair(compiler, primary, companion, owner) {
  const first = consumerImplementation(compiler, primary);
  const second = consumerImplementation(compiler, companion);
  const production = (identity) =>
    compiler.state.subject.inventory.files.some(
      (file) => file.path === identity.producer.path && file.production,
    );
  if (
    first.identity.owner !== owner ||
    second.identity.owner !== owner ||
    !production(first.identity) ||
    !production(second.identity) ||
    first.source !== second.source ||
    sameProducer(first.identity, second.identity) ||
    !exportedDeclaration(first.callable) ||
    !exportedDeclaration(second.callable)
  )
    throw new TypeError("unsupported-metadata-source-consumers");
  return { first, second };
}

function metadataSourceBinding(compiler, primary, companion, producer, owner) {
  if (producer.owner !== owner) throw new TypeError("foreign-responsibility-owner");
  const { first, second } = metadataConsumerPair(compiler, primary, companion, owner);
  const graph = consumerStates(compiler, first, producer, second);
  const [firstWitnesses, secondWitnesses] = graph.witnessesByRoot;
  const witnesses = new Set([...firstWitnesses, ...secondWitnesses]);
  const calls = [...witnesses].flatMap((key) => {
    const state = graph.states.get(key);
    return state.calls
      .filter((call) => canonicalCall(compiler, state.context, call.expression, producer))
      .map((call) => ({
        path: state.identity.producer.path,
        start: call.getStart(),
        end: call.end,
      }));
  });
  const bound = firstWitnesses.length > 0 && secondWitnesses.length > 0;
  compiler.assertCurrent();
  return {
    implementations: [first.identity, second.identity],
    calls,
    bound,
    status: bound ? "ready" : "incomplete",
  };
}

function objectValidatorSignature(callable) {
  return (
    typedFunctionDeclaration(callable) &&
    exportedDeclaration(callable) &&
    !callable.typeParameters?.length &&
    !callable.asteriskToken &&
    !callable.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    callable.parameters.length === 1 &&
    observationParameter(callable.parameters[0], ts.SyntaxKind.ObjectKeyword) &&
    callable.type !== undefined
  );
}

function namedObjectResult(type) {
  const declarations = (type.aliasSymbol ?? type.symbol)?.declarations;
  return (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    declarations?.length === 1 &&
    (ts.isInterfaceDeclaration(declarations[0]) || ts.isTypeAliasDeclaration(declarations[0])) &&
    !typeFacts(type).indexes?.some((entry) => ["unknown", "any"].includes(entry.kind))
  );
}

function optionalOwnedObjectResult(compiler, state, signature) {
  const type = state.context.checker.getReturnTypeOfSignature(signature);
  if (
    !type.isUnion() ||
    type.types.length !== 2 ||
    state.context.checker.getTypeAtLocation(state.callable.type) !== type
  )
    return false;
  const defined = type.types.find((arm) => (arm.flags & ts.TypeFlags.Undefined) === 0);
  return (
    type.types.some((arm) => arm.flags === ts.TypeFlags.Undefined) &&
    defined !== undefined &&
    namedObjectResult(defined) &&
    observationOwnedResult(compiler, defined, state.identity)
  );
}

function ownedStageCheck(state, condition, local) {
  if (
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
  )
    return null;
  const present = rawParentheses(condition.left);
  const check = rawParentheses(condition.right);
  if (
    !ts.isBinaryExpression(present) ||
    present.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    !observationIdentifier(state, present.left, local) ||
    !rawReaderAbsent(state, present.right) ||
    !typedPredicateCall(check)
  )
    return null;
  return check;
}

function ownedStageAssignment(callable) {
  if (!directDiagnosticCallable(callable)) return null;
  const flow = diagnosticEnvelopeAssignment(callable);
  return flow && !flow.local.type && ts.isIdentifier(flow.local.name) ? flow : null;
}

function ownedStageFlow(state) {
  const flow = ownedStageAssignment(state.callable);
  if (!flow) return null;
  const check = ownedStageCheck(state, rawParentheses(flow.result.condition), flow.local);
  if (
    !check ||
    !observationIdentifier(state, check.arguments[0], flow.local) ||
    !observationIdentifier(state, flow.result.whenTrue, flow.local) ||
    !rawReaderAbsent(state, flow.result.whenFalse) ||
    !typedPredicateCall(flow.local.initializer) ||
    !observationIdentifier(state, flow.local.initializer.arguments[0], state.callable.parameters[0])
  )
    return null;
  return { read: flow.local.initializer, check };
}

function ownedStageCallable(state, call) {
  const declaration = typedPredicateDeclaration(state, call);
  const signature = declaration && typedNamedCallable(state.context, declaration);
  if (
    !signature ||
    signature.thisParameter ||
    exportedDeclaration(declaration) ||
    !observationParameter(declaration.parameters[0], ts.SyntaxKind.ObjectKeyword) ||
    state.context.checker.getResolvedSignature(call) !== signature
  )
    return null;
  const identity = canonicalDeclaration(state.compiler, declaration, null);
  return identity.owner === state.identity.owner
    ? { ...state, callable: declaration, declaration, identity, signature }
    : null;
}

function ownedStageRawResult(state) {
  const annotation = state.callable.type;
  if (
    !ts.isUnionTypeNode(annotation) ||
    annotation.types.length !== 2 ||
    !annotation.types.some((type) => type.kind === ts.SyntaxKind.ObjectKeyword) ||
    !annotation.types.some((type) => type.kind === ts.SyntaxKind.UndefinedKeyword)
  )
    return false;
  const result = state.context.checker.getReturnTypeOfSignature(state.signature);
  const kinds = new Set([ts.TypeFlags.NonPrimitive, ts.TypeFlags.Undefined]);
  return (
    result.isUnion() &&
    result.types.length === 2 &&
    result.types.every((arm) => kinds.has(arm.flags))
  );
}

function ownedStagePredicate(state, call, result) {
  const predicate = ownedStageCallable(state, call);
  if (!predicate) return null;
  const narrowed = typedIdentifierPredicate(state.context, predicate.callable, predicate.signature);
  if (!narrowed || narrowed.type !== result) return null;
  const references = state.nodes.filter((node) => helperReference(predicate, node));
  return references.length === 1 &&
    references[0] === call.expression &&
    referenceCall(references[0]) === call
    ? predicate
    : null;
}

function ownedPredicateStageSlot(compiler, root, signature) {
  const state = { ...root, compiler, nodes: sourceNodes(compiler, root.source) };
  const flow = ownedStageFlow(state);
  const reader = flow && ownedStageCallable(state, flow.read);
  const output = state.context.checker.getReturnTypeOfSignature(signature);
  const defined = output.types.find((arm) => arm.flags !== ts.TypeFlags.Undefined);
  const predicate =
    reader && ownedStageRawResult(reader) && ownedStagePredicate(state, flow.check, defined);
  if (!predicate) throw new TypeError("unsupported-owned-predicate-stage");
  return {
    ...annotationSlot(
      predicate.context,
      predicate.source,
      predicate.callable.parameters[0].type,
      predicate.identity,
      "parameter",
      0,
    ),
    rule: "anti-slop/no-object-parameters",
    rawObjectValidatorInput: true,
    ownedPredicateStageInput: true,
  };
}

function objectValidatorFacts(compiler, identity, ownedPredicateStage = false) {
  compiler.assertCurrent();
  const state = { ...declarationCallable(compiler, identity), identity };
  const signatures = state.context.checker.getTypeAtLocation(state.callable).getCallSignatures();
  const signature = signatures.length === 1 ? signatures[0] : undefined;
  if (
    !objectValidatorSignature(state.callable) ||
    !signature ||
    signature.typeParameters?.length ||
    signature.thisParameter ||
    !optionalOwnedObjectResult(compiler, state, signature)
  )
    throw new TypeError("unsupported-object-validator-boundary");
  const slot = annotationSlot(
    state.context,
    state.source,
    state.callable.parameters[0].type,
    identity,
    "parameter",
    0,
  );
  const slots = [
    { ...slot, rule: "anti-slop/no-object-parameters", rawObjectValidatorInput: true },
  ];
  try {
    if (ownedPredicateStage) slots.push(ownedPredicateStageSlot(compiler, state, signature));
    return { identity, slots };
  } finally {
    compiler.assertCurrent();
  }
}

function observationConsumer(context, source, name) {
  const module = context.checker.getSymbolAtLocation(source);
  const declarations = context.checker
    .getExportsOfModule(module)
    .find((entry) => entry.name === name)?.declarations;
  if (declarations?.length !== 1 || !ts.isFunctionDeclaration(declarations[0])) return null;
  const callable = declarations[0];
  return directDiagnosticCallable(callable) &&
    callable.type &&
    !callable.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    observationParameter(callable.parameters[0], ts.SyntaxKind.ObjectKeyword)
    ? callable
    : null;
}

function observationOwnedResult(compiler, type, producer) {
  const declarations = (type.aliasSymbol ?? type.symbol)?.declarations;
  if (declarations?.length !== 1) return false;
  const identity = canonicalDeclaration(compiler, declarations[0], null);
  return (
    identity.owner === producer.owner &&
    compiler.state.subject.inventory.files.some(
      (file) => file.path === identity.producer.path && file.production,
    )
  );
}

function observationResultOwner(compiler, context, callable, signature, producer) {
  if (!signature || signature.typeParameters?.length || signature.parameters.length !== 1)
    return false;
  const parameter = signature.parameters[0].valueDeclaration;
  if (!observationParameter(parameter, ts.SyntaxKind.ObjectKeyword)) return false;
  const type = context.checker.getReturnTypeOfSignature(signature);
  return (
    context.checker.getTypeAtLocation(callable.type) === type &&
    observationOwnedResult(compiler, type, producer)
  );
}

function publicObservationFlow(compiler, request, producer) {
  const { context, source } = ownedSource(compiler, request.consumerPath, true);
  const callable = observationConsumer(context, source, request.exportName);
  const result = callable && parserResult(callable);
  return result &&
    parserImport(context, result.call, request.specifier) &&
    directDiagnosticProducer(compiler, context, result.call, producer) &&
    sameParserFlow(context, callable, result)
    ? { context, callable, result }
    : null;
}

function booleanObservationBinding(compiler, request, producer) {
  const flow = publicObservationFlow(compiler, request, producer);
  if (!flow) return { bound: false, status: "incomplete" };
  const { context, callable, result } = flow;
  const signatures = context.checker.getTypeAtLocation(result.call.expression).getCallSignatures();
  const signature = context.checker.getResolvedSignature(result.call);
  const bound =
    signatures.length === 1 &&
    signature?.parameters.length === 1 &&
    !signature.typeParameters?.length &&
    callable.type.kind === ts.SyntaxKind.BooleanKeyword &&
    (context.checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.BooleanLike) !== 0 &&
    context.checker.getTypeAtLocation(callable.type) ===
      context.checker.getReturnTypeOfSignature(signature);
  compiler.assertCurrent();
  return {
    bound,
    status: bound ? "ready" : "incomplete",
    implementation: canonicalDeclaration(compiler, callable, null),
    calls: [{ path: request.consumerPath, start: result.call.getStart(), end: result.call.end }],
  };
}

function observationBinding(compiler, request, producer) {
  const flow = publicObservationFlow(compiler, request, producer);
  if (!flow) return { bound: false, status: "incomplete" };
  const { context, callable, result } = flow;
  const signatures = context.checker.getTypeAtLocation(result.call.expression).getCallSignatures();
  const signature = context.checker.getResolvedSignature(result.call);
  const bound =
    signatures.length === 1 &&
    observationResultOwner(compiler, context, callable, signature, producer);
  compiler.assertCurrent();
  return {
    bound,
    status: bound ? "ready" : "incomplete",
    implementation: canonicalDeclaration(compiler, callable, null),
    calls: [{ path: request.consumerPath, start: result.call.getStart(), end: result.call.end }],
  };
}

function intrinsicReaderRecord(state, annotation) {
  if (
    !annotation ||
    !ts.isTypeReferenceNode(annotation) ||
    !ts.isIdentifier(annotation.typeName) ||
    annotation.typeName.text !== "Record" ||
    annotation.typeArguments?.length !== 2
  )
    return false;
  return (
    annotation.typeArguments[0].kind === ts.SyntaxKind.StringKeyword &&
    annotation.typeArguments[1].kind === ts.SyntaxKind.UnknownKeyword &&
    defaultLibrarySymbol(
      state.context,
      state.context.checker.getSymbolAtLocation(annotation.typeName),
    )
  );
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

export function exportFactKey(request, proof) {
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

function typedRecheckOperations(compiler) {
  return {
    typedRecheckFacts: (identity, index) => {
      compiler.assertCurrent();
      try {
        return typedRecheckFacts(compiler, identity, index);
      } finally {
        compiler.assertCurrent();
      }
    },
    typedRecheckBinding: (request, producer) => {
      compiler.assertCurrent();
      try {
        return typedRecheckBinding(compiler, request, producer);
      } finally {
        compiler.assertCurrent();
      }
    },
  };
}

function assertCapturedPredicateOption(value) {
  if (typeof value !== "boolean") throw new TypeError("unsupported-captured-predicate-option");
}

function validationBoundaryOperations(compiler) {
  return {
    diagnosticBinding: (request, producer) => diagnosticBinding(compiler, request, producer),
    booleanObservationBinding: (request, producer) =>
      booleanObservationBinding(compiler, request, producer),
    parserBinding: (request, producer) => parserBinding(compiler, request, producer),
    objectValidatorFacts: (identity, ownedPredicateStage = false) => {
      if (typeof ownedPredicateStage !== "boolean")
        throw new TypeError("unsupported-owned-predicate-stage-option");
      return objectValidatorFacts(compiler, identity, ownedPredicateStage);
    },
    metadataSourceFacts: (
      identity,
      ownedMarkerPair = false,
      ownedRegistrationTransport = false,
    ) => {
      if (typeof ownedMarkerPair !== "boolean")
        throw new TypeError("unsupported-owned-marker-pair-option");
      if (typeof ownedRegistrationTransport !== "boolean")
        throw new TypeError("unsupported-owned-registration-transport-option");
      if (ownedRegistrationTransport)
        return metadataRegistrationTransportFacts(compiler, identity, ownedMarkerPair);
      return ownedMarkerPair
        ? metadataMarkerPairFacts(compiler, identity)
        : metadataSourceFacts(compiler, identity);
    },
    metadataSourceConsumer: (request) => resolveProofConsumer(compiler, request, false),
    metadataSourceBinding: (primary, companion, producer, owner) =>
      metadataSourceBinding(compiler, primary, companion, producer, owner),
  };
}

function cachedRawCheckingSlots(compiler, rawSlots, identity, index, capturedUnknownPredicates) {
  assertCapturedPredicateOption(capturedUnknownPredicates);
  compiler.assertCurrent();
  const key = policyDigest(JSON.stringify({ identity, index, capturedUnknownPredicates }));
  if (!rawSlots.has(key))
    rawSlots.set(key, rawCheckingSlots(compiler, identity, index, capturedUnknownPredicates));
  return structuredClone(rawSlots.get(key));
}

export function createSymbolResolver(subject, options = {}, proofRoots = []) {
  const compiler = createCompilerContext(subject, options, proofRoots);
  const rawSlots = new Map();
  const exportFacts = createExportFactCache(compiler);
  return {
    resolveExport: (request) => exportFacts.resolve(request),
    resolveProofExport: (request) => exportFacts.resolve(request, true),
    resolveProofConsumer: (request) => resolveProofConsumer(compiler, request),
    ...validationBoundaryOperations(compiler),
    ...typedRecheckOperations(compiler),
    ...canonicalDecoderOperations(compiler),
    describeAt: (request) => describeAt(compiler, request),
    incomingUses: (identity, paths) => incomingUses(compiler, identity, paths),
    rawReaderFacts: (identity) => rawReaderFacts(compiler, identity),
    propertyObservationFacts: (identity, options) =>
      propertyObservationFacts(compiler, identity, options),
    observationBinding: (request, producer) => observationBinding(compiler, request, producer),
    callableSlots: (identity) => callableSlots(compiler, identity),
    rawCheckingSlots: (identity, index, capturedUnknownPredicates = false) =>
      cachedRawCheckingSlots(compiler, rawSlots, identity, index, capturedUnknownPredicates),
    collectiveRawCheckingSlots: (roots, rule) => collectiveRawCheckingSlots(compiler, roots, rule),
    collectiveRawComponents: (roots) => collectiveRawComponents(compiler, roots),
    collectiveJsonByteMeasurement: (roots) => collectiveJsonByteMeasurement(compiler, roots),
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
      rawModuleIndexes.delete(compiler);
      rawSourceNodeCaches.delete(compiler);
      rawPrivateOutputBindings.delete(compiler);
      rawDiscoveryKeys.delete(compiler);
      rawDetachedSlots.delete(compiler);
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
