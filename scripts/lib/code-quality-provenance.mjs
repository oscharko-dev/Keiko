import { dirname, join, relative, resolve } from "node:path";
import { readFileSync, mkdtempSync, readdirSync, lstatSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire, SourceMap } from "node:module";
import { isDeepStrictEqual } from "node:util";
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

export function nativeCompilerExecutable() {
  const require = createRequire(import.meta.url);
  const native = JSON.parse(
    readFileSync(require.resolve("@typescript/native/package.json"), "utf8"),
  );
  const platform = `@typescript/typescript-${process.platform}-${process.arch}`;
  const packagePath = require.resolve(`${platform}/package.json`);
  const installed = JSON.parse(readFileSync(packagePath, "utf8"));
  if (native.version !== installed.version) throw new TypeError("unqualified-native-compiler");
  return join(dirname(packagePath), "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
}

function collectEmitted(compiler, directory, originalDirectory, outputs) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectEmitted(compiler, path, originalDirectory, outputs);
      continue;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("unsafe-declaration-emission");
    compiler.state.emittedBytes += stat.size;
    if (compiler.state.emittedBytes > compiler.state.limits.emitBytes)
      throw new TypeError("symbol-emission-budget");
    outputs.set(
      relative(originalDirectory, path).replaceAll("\\", "/"),
      readFileSync(path, "utf8"),
    );
  }
}

function invokeNative(compiler, options, directory, scratch) {
  try {
    execFileSync(
      nativeCompilerExecutable(),
      [
        "-p",
        options.configFilePath,
        "--emitDeclarationOnly",
        "--outDir",
        directory,
        ...(options.declarationDir ? ["--declarationDir", directory] : []),
        "--tsBuildInfoFile",
        join(scratch, "private.tsbuildinfo"),
      ],
      {
        cwd: compiler.state.subject.root,
        timeout: compiler.state.limits.emissionTimeout,
        killSignal: "SIGKILL",
        maxBuffer: compiler.state.limits.emissionOutputBytes,
        encoding: "utf8",
      },
    );
  } catch (cause) {
    throw new TypeError("unqualified-declaration-emission", { cause });
  }
}

function nativeEmission(compiler, context) {
  const options = context.config.options;
  if (
    !options.configFilePath ||
    !options.outDir ||
    !options.declaration ||
    options.noEmit ||
    options.outFile
  )
    throw new TypeError("unqualified-declaration-emission");
  if (ts.getPreEmitDiagnostics(context.program).length > 0)
    throw new TypeError("unqualified-declaration-emission");
  compiler.assertCurrent();
  const scratch = mkdtempSync(join(tmpdir(), "keiko-symbol-emission-"));
  const directory = join(scratch, "dist");
  try {
    invokeNative(compiler, options, directory, scratch);
    compiler.assertCurrent();
    const outputs = new Map();
    collectEmitted(compiler, directory, directory, outputs);
    compiler.state.emittedBytes += lstatSync(join(scratch, "private.tsbuildinfo")).size;
    if (compiler.state.emittedBytes > compiler.state.limits.emitBytes)
      throw new TypeError("symbol-emission-budget");
    return { outputs, directory, outDir: options.declarationDir ?? options.outDir };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function emitProducer(compiler, path) {
  const { owner } = compiler.context(path);
  const cached = compiler.state.emissions.get(owner);
  if (cached?.error) throw cached.error;
  if (cached) return cached;
  try {
    const emitted = nativeEmission(compiler, compiler.program(path));
    compiler.state.emissions.set(owner, emitted);
    return emitted;
  } catch (error) {
    compiler.state.emissions.set(owner, { error: new TypeError(error.message) });
    throw error;
  }
}

function normalizedMap(compiler, text, mapPath) {
  const payload = JSON.parse(text);
  if (
    payload.version !== 3 ||
    !Array.isArray(payload.sources) ||
    payload.sources.some((source) => typeof source !== "string") ||
    (payload.sourceRoot !== undefined && typeof payload.sourceRoot !== "string")
  )
    throw new TypeError("invalid-declaration-map");
  const sources = payload.sources.map((source) =>
    subjectPath(
      compiler.state.subject,
      realpathSync(resolve(dirname(mapPath), payload.sourceRoot ?? "", source)),
    ),
  );
  return { ...payload, sourceRoot: "", sources };
}

function matchingMap(compiler, emitted, outputPath, freshMap, mapPath, mapText) {
  try {
    return isDeepStrictEqual(
      normalizedMap(compiler, freshMap, join(emitted.directory, `${outputPath}.map`)),
      normalizedMap(compiler, mapText, join(compiler.state.subject.root, mapPath)),
    );
  } catch (cause) {
    throw new TypeError("stale-declaration-provenance", { cause });
  }
}

function qualifiedDeclarationBytes(compiler, path) {
  const source = compiler.state.subject.outputs.get(path);
  if (!source) throw new TypeError("unqualified-declaration-owner");
  const emitted = emitProducer(compiler, source);
  const outputPath = relative(emitted.outDir, join(compiler.state.subject.root, path)).replaceAll(
    "\\",
    "/",
  );
  const mapPath = `${path}.map`;
  const declarationText = compiler.read(path);
  const mapText = compiler.read(mapPath);
  const freshMap = emitted.outputs.get(`${outputPath}.map`);
  if (
    emitted.outputs.get(outputPath) !== declarationText ||
    freshMap === undefined ||
    !matchingMap(compiler, emitted, outputPath, freshMap, mapPath, mapText)
  )
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
