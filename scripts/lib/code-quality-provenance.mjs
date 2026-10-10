import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { SourceMap } from "node:module";
import ts from "typescript";
import { subjectPath, visitCompilerNodes } from "./code-quality-compiler.mjs";

export function compilerNodeAt(compiler, source, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= source.text.length)
    throw new TypeError("invalid-symbol-position");
  let selected = source;
  visitCompilerNodes(compiler.state, source, (node) => {
    if (
      node.getStart(source) <= offset &&
      node.end > offset &&
      node.end - node.pos <= selected.end - selected.pos
    )
      selected = node;
  });
  return selected;
}

function ownerOf(subject, path) {
  const owner = subject.inventory.packages.find((entry) => path.startsWith(`${entry.directory}/`));
  if (owner) return owner.name;
  const file = subject.inventory.files.find((entry) => entry.path === path);
  if (!file) throw new TypeError("unqualified-symbol-owner");
  return file.scope;
}

function emitProducer(compiler, path) {
  const context = compiler.program(path);
  const cached = context.emitted.get(path);
  if (cached) return cached;
  if (context.config.options.noEmit) throw new TypeError("unqualified-declaration-emission");
  const source = context.program.getSourceFile(join(compiler.state.subject.root, path));
  if (!source || ts.getPreEmitDiagnostics(context.program).length > 0)
    throw new TypeError("unqualified-declaration-emission");
  const outputs = new Map();
  const result = context.program.emit(
    source,
    (name, text) => {
      compiler.state.emittedBytes += Buffer.byteLength(text);
      if (compiler.state.emittedBytes > compiler.state.limits.emitBytes)
        throw new TypeError("symbol-emission-budget");
      outputs.set(subjectPath(compiler.state.subject, name), text);
    },
    undefined,
    true,
  );
  if (result.emitSkipped || result.diagnostics.length > 0)
    throw new TypeError("unqualified-declaration-emission");
  context.emitted.set(path, outputs);
  return outputs;
}

function qualifiedDeclarationBytes(compiler, path) {
  const source = compiler.state.subject.outputs.get(path);
  if (!source) throw new TypeError("unqualified-declaration-owner");
  const outputs = emitProducer(compiler, source);
  const mapPath = `${path}.map`;
  const declarationText = compiler.read(path);
  const mapText = compiler.read(mapPath);
  if (outputs.get(path) !== declarationText || outputs.get(mapPath) !== mapText)
    throw new TypeError("stale-declaration-provenance");
  return { source, mapPath, mapText };
}

export function qualifyContextDeclarations(compiler, context) {
  for (const source of context.program.getSourceFiles()) {
    if (!source.isDeclarationFile) continue;
    const path = subjectPathOrExternal(compiler.state.subject, source.fileName);
    if (!compiler.state.subject.outputs.has(path)) continue;
    if (context.qualified.has(path)) continue;
    qualifiedDeclarationBytes(compiler, path);
    context.qualified.add(path);
  }
}

function subjectPathOrExternal(subject, absolute) {
  try {
    return subjectPath(subject, absolute);
  } catch (error) {
    if (error.message !== "symbol-source-escape") throw error;
    return null;
  }
}

function declarationProducer(compiler, declaration, path) {
  const { source, mapPath, mapText } = qualifiedDeclarationBytes(compiler, path);
  return mappedDeclaration(compiler, declaration, source, mapPath, mapText);
}

export function declarationMapPosition(declaration, text) {
  const payload = JSON.parse(text);
  if (payload.version !== 3 || !Array.isArray(payload.sources) || payload.sources.length !== 1)
    throw new TypeError("invalid-declaration-map");
  const built = declaration.getSourceFile();
  const position = built.getLineAndCharacterOfPosition(
    (declaration.name ?? declaration).getStart(built),
  );
  const mapped = new SourceMap(payload).findEntry(position.line, position.character);
  if (
    !Number.isSafeInteger(mapped.originalLine) ||
    !Number.isSafeInteger(mapped.originalColumn) ||
    typeof mapped.originalSource !== "string"
  )
    throw new TypeError("unmapped-declaration-position");
  return { payload, mapped };
}

function mappedDeclaration(compiler, declaration, expected, mapPath, text) {
  const { payload, mapped } = declarationMapPosition(declaration, text);
  const path = subjectPath(
    compiler.state.subject,
    join(
      compiler.state.subject.root,
      dirname(mapPath),
      payload.sourceRoot ?? "",
      mapped.originalSource,
    ),
  );
  if (path !== expected) throw new TypeError("mismatched-declaration-owner");
  const context = compiler.program(path);
  const source = context.program.getSourceFile(join(compiler.state.subject.root, path));
  const offset = source.getPositionOfLineAndCharacter(mapped.originalLine, mapped.originalColumn);
  let node = compilerNodeAt(compiler, source, offset);
  while (node && node.kind !== declaration.kind) node = node.parent;
  if (!node) throw new TypeError("mismatched-declaration-kind");
  return { path, declaration: node };
}

export function canonicalDeclaration(compiler, declaration, entry) {
  const subject = compiler.state.subject;
  let path = subjectPath(subject, declaration.getSourceFile().fileName);
  if (/\.d\.[cm]?ts$/u.test(path)) {
    ({ path, declaration } = declarationProducer(compiler, declaration, path));
  } else if (!subject.inventory.files.some((file) => file.path === path)) {
    throw new TypeError("unqualified-symbol-owner");
  }
  return {
    owner: ownerOf(subject, path),
    entry,
    producer: {
      path,
      start: declaration.getStart(),
      end: declaration.end,
      kind: ts.SyntaxKind[declaration.kind],
    },
  };
}
