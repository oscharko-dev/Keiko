import { Buffer } from "node:buffer";
import { types } from "node:util";
import { policyDigest } from "./code-quality-inventory.mjs";
import { compareStrings } from "./compare-strings.mjs";
import { join, relative } from "node:path";
import ts from "typescript";
import { recognizeJsonByteMeasurement } from "./code-quality-json-byte-form.mjs";
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

function consumerStateIndex(compiler, implementation) {
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

function consumerContributingKeys(root, states, reachable, witnesses) {
  const keys = new Set(witnesses).add(root.key);
  for (const key of keys)
    for (const edge of states.get(key).incoming)
      if (reachable.has(edge.state)) keys.add(edge.state);
  return keys;
}

function consumerWitnessStates(root, index, keys) {
  if (keys.size > root.compiler.state.limits.aliases) throw new TypeError("symbol-alias-budget");
  const states = new Map(
    [...keys].map((key) => {
      const state = index.get(key);
      return [key, { ...state, incoming: state.incoming.filter((edge) => keys.has(edge.state)) }];
    }),
  );
  const complete = new Set();
  for (const key of states.keys()) assertConsumerAcyclic(states, key, new Set(), complete);
  return { root, states, qualified: qualifiedRawStates(root, states) };
}

function consumerStates(compiler, implementation, producer) {
  const { root, states } = consumerStateIndex(compiler, implementation);
  const reachable = consumerReachableKeys(root, states);
  const witnesses = consumerWitnessKeys(compiler, states, reachable, producer);
  const keys = consumerContributingKeys(root, states, reachable, witnesses);
  return consumerWitnessStates(root, states, keys);
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
    state.context,
    state.source,
    state.nodes,
    target,
    index,
    state.collective,
  );
  return candidate ? { candidate, origin } : null;
}

function rawCallEdges(state, states, queue) {
  for (const call of stateCalls(state)) {
    const target = localRawCallable(state.compiler, state.context, state.source, call.expression);
    if (!target || exportedDeclaration(target.declaration)) continue;
    rawCallArguments(state, target, call, states, queue);
  }
}

function rawCallArguments(state, target, call, states, queue) {
  for (const [index, argument] of call.arguments.entries()) {
    const edge = rawEdgeCandidate(state, target, index, argument);
    if (!edge) continue;
    const { candidate, origin } = edge;
    if (!states.has(candidate.key)) {
      if (state.collective && states.size >= state.compiler.state.limits.aliases)
        throw collectiveHelperBudgetError(state.compiler.state.limits.aliases, states.size + 1);
      states.set(candidate.key, candidate);
      queue.push(candidate);
    }
    states.get(candidate.key).incoming.push({ state: state.key, call, origin });
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
    (state.collective && writtenSymbol(state.context, state.nodes, state.parameterSymbol)) ||
    state.nodes.some(
      (node) => helperReference(state, node) && !permittedHelperReference(state, node),
    )
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

function collectiveRawRoot(compiler, request) {
  const owned = declarationCallable(compiler, request.identity);
  const nodes = sourceNodes(compiler, owned.source);
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
  if (!state || writtenSymbol(state.context, nodes, state.parameterSymbol)) return null;
  const parameter = state.callable.parameters[state.index];
  return typeFacts(state.context.checker.getTypeAtLocation(parameter)).kind === "unknown"
    ? state
    : null;
}

function collectiveRawGraph(compiler, requests) {
  const states = new Map();
  const roots = new Map();
  for (const request of requests) {
    const state = collectiveRawRoot(compiler, request);
    if (!state) continue;
    if (!states.has(state.key) && states.size >= compiler.state.limits.aliases)
      throw collectiveHelperBudgetError(compiler.state.limits.aliases, states.size + 1);
    states.set(state.key, state);
    roots.set(state.key, [...(roots.get(state.key) ?? []), request.recordId]);
  }
  const queue = [...states.values()];
  for (const state of queue) rawCallEdges(state, states, queue);
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

function collectiveRawFacts(compiler, requests) {
  compiler.assertCurrent();
  if (requests.length > compiler.state.limits.aliases)
    throw collectiveHelperBudgetError(compiler.state.limits.aliases, requests.length);
  const { states, roots } = collectiveRawGraph(compiler, requests);
  const first = states.get(roots.keys().next().value);
  const qualified =
    roots.size === 0 ? new Set() : qualifiedRawStates(first, states, new Set(roots.keys()));
  return { states, roots, qualified };
}

function collectiveRawCheckingSlots(compiler, requests, rule) {
  const { states, roots, qualified } = collectiveRawFacts(compiler, requests);
  const slots = [];
  const dependencies = new Map();
  for (const state of states.values()) {
    if (!qualified.has(state.key)) continue;
    const contributingResponsibilityIds = [
      ...new Set(contributingRawRoots(state.key, states, roots, dependencies)),
    ].sort(compareStrings);
    slots.push(
      ...collectiveStateSlots(state)
        .filter((slot) => slot.rule === rule)
        .map((slot) => ({
          ...slot,
          producerIdentity: state.identity,
          contributingResponsibilityIds,
        })),
    );
  }
  compiler.assertCurrent();
  return slots;
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

function rawReaderTarget(state, target) {
  return (
    target.name.text === "hasOwn" &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "Object" &&
    defaultLibrarySymbol(state.context, expressionSymbol(state.compiler, state.context, target)) &&
    defaultLibrarySymbol(
      state.context,
      state.context.checker.getSymbolAtLocation(target.expression),
    )
  );
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

function privateObservationCallable(callable) {
  return (
    ts.isFunctionDeclaration(callable) &&
    !exportedDeclaration(callable) &&
    !callable.typeParameters?.length &&
    !callable.asteriskToken &&
    !callable.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    callable.parameters.length === 2 &&
    callable.type?.kind === ts.SyntaxKind.UnknownKeyword
  );
}

function observationSignature(state) {
  return (
    privateObservationCallable(state.callable) &&
    observationParameter(state.callable.parameters[0], ts.SyntaxKind.ObjectKeyword) &&
    observationKey(state.context, state.callable.parameters[1])
  );
}

function observationTarget(state, target) {
  return (
    target.name.text === "get" &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "Reflect" &&
    defaultLibrarySymbol(state.context, expressionSymbol(state.compiler, state.context, target)) &&
    defaultLibrarySymbol(
      state.context,
      state.context.checker.getSymbolAtLocation(target.expression),
    )
  );
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
  return [...states.values()].filter((state) => observationSignature(state));
}

function privateObservationReferences(state) {
  return !sourceNodes(state.compiler, state.source).some(
    (node) => helperReference(state, node) && !referenceCall(node),
  );
}

function propertyObservationFacts(compiler, identity) {
  const candidates = reachedObservationCallables(compiler, identity);
  if (candidates.length !== 1) throw new TypeError("unsupported-property-observation-helper");
  const state = candidates[0];
  if (!privateObservationReferences(state))
    throw new TypeError("unsupported-property-observation-exposure");
  const call = observationBody(state);
  if (!call) throw new TypeError("unsupported-property-observation-body");
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
  compiler.assertCurrent();
  return { identity: state.identity, root: identity, slots };
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

function observationBinding(compiler, request, producer) {
  const { context, source } = ownedSource(compiler, request.consumerPath, true);
  const callable = observationConsumer(context, source, request.exportName);
  const result = callable && parserResult(callable);
  if (
    !result ||
    !parserImport(context, result.call, request.specifier) ||
    !directDiagnosticProducer(compiler, context, result.call, producer) ||
    !sameParserFlow(context, callable, result)
  )
    return { bound: false, status: "incomplete" };
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

export function createSymbolResolver(subject, options = {}, proofRoots = []) {
  const compiler = createCompilerContext(subject, options, proofRoots);
  const rawSlots = new Map();
  const exportFacts = createExportFactCache(compiler);
  return {
    resolveExport: (request) => exportFacts.resolve(request),
    resolveProofExport: (request) => exportFacts.resolve(request, true),
    resolveProofConsumer: (request) => resolveProofConsumer(compiler, request),
    diagnosticBinding: (request, producer) => diagnosticBinding(compiler, request, producer),
    parserBinding: (request, producer) => parserBinding(compiler, request, producer),
    ...typedRecheckOperations(compiler),
    ...canonicalDecoderOperations(compiler),
    describeAt: (request) => describeAt(compiler, request),
    incomingUses: (identity, paths) => incomingUses(compiler, identity, paths),
    rawReaderFacts: (identity) => rawReaderFacts(compiler, identity),
    propertyObservationFacts: (identity) => propertyObservationFacts(compiler, identity),
    observationBinding: (request, producer) => observationBinding(compiler, request, producer),
    callableSlots: (identity) => callableSlots(compiler, identity),
    rawCheckingSlots: (identity, index) => {
      compiler.assertCurrent();
      const key = policyDigest(JSON.stringify({ identity, index }));
      if (!rawSlots.has(key)) rawSlots.set(key, rawCheckingSlots(compiler, identity, index));
      return structuredClone(rawSlots.get(key));
    },
    collectiveRawCheckingSlots: (roots, rule) => collectiveRawCheckingSlots(compiler, roots, rule),
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
