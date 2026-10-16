import { Buffer } from "node:buffer";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import { collectPolicyPaths, policyDigest } from "./code-quality-inventory.mjs";
import { compareStrings } from "./compare-strings.mjs";

// Witnesses remain private: exposed compiler metadata cannot rewrite the admitted text or bytes.
const SNAPSHOT_WITNESSES = new WeakMap();

const DEFAULT_LIMITS = Object.freeze({
  programs: 2,
  sourceBytes: 64 * 1024 * 1024,
  nodes: 5_000_000,
  aliases: 64,
  emitBytes: 16 * 1024 * 1024,
  emissionTimeout: 10_000,
  emissionOutputBytes: 1024 * 1024,
});

export function subjectPath(subject, absolute) {
  const path = relative(subject.root, absolute).replaceAll("\\", "/");
  if (isAbsolute(path) || path === ".." || path.startsWith("../"))
    throw new TypeError("symbol-source-escape");
  return path;
}

function observedInputs(subject) {
  const inputs = new Map(subject.inventory.files.map((file) => [file.path, file.sha256]));
  for (const build of [
    subject.inventory.rootBuild,
    ...subject.inventory.packages.map((owner) => owner.build),
  ]) {
    for (const config of build.configs) inputs.set(config.path, config.sha256);
  }
  inputs.set("package.json", subject.inventory.rootManifestSha256);
  inputs.set("package-lock.json", subject.inventory.lockSha256);
  for (const owner of subject.inventory.packages)
    inputs.set(`${owner.directory}/package.json`, owner.manifestSha256);
  return inputs;
}

// Native realpath needs procfs on musl; the ordinary API remains the compatibility fallback.
function canonicalSourcePath(path) {
  if (process.platform !== "linux") return realpathSync(path);
  try {
    const resolved = realpathSync.native(path);
    if (resolved === path) return resolved;
  } catch {
    return realpathSync(path);
  }
  return realpathSync(path);
}

function regularSource(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || canonicalSourcePath(path) !== path)
    throw new TypeError("unsafe-symbol-source");
}

function limitsFrom(options) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (
    Object.keys(limits).some(
      (key) => !(key in DEFAULT_LIMITS) || !Number.isSafeInteger(limits[key]) || limits[key] < 1,
    )
  )
    throw new TypeError("invalid-symbol-budget");
  return limits;
}

function subjectFingerprint(subject) {
  const contexts = [...subject.contexts].map(([owner, config]) => ({
    owner,
    files: config.fileNames,
    options: Object.fromEntries(
      Object.entries(config.options).filter(([key]) => key !== "configFile"),
    ),
    references: config.projectReferences,
  }));
  const ownership = {
    packages: subject.inventory.packages.map(({ name, directory }) => ({ name, directory })),
    files: subject.inventory.files.map(({ path, scope, production }) => ({
      path,
      scope,
      production,
    })),
  };
  return policyDigest(
    JSON.stringify({
      contexts,
      outputs: [...subject.outputs],
      ownership,
      membership: subject.membership.paths,
    }),
  );
}

function proofManifest(subject, roots) {
  const entries = roots
    .map(({ owner, paths }) => {
      if (!subject.contexts.has(owner) || !Array.isArray(paths))
        throw new TypeError("invalid-proof-context");
      const selected = [...new Set(paths)].sort(compareStrings);
      for (const path of selected) {
        const file = subject.inventory.files.find((entry) => entry.path === path);
        const actual = [...subject.contexts.keys()]
          .filter((key) => key === "" || path.startsWith(`${key}/`))
          .sort((a, b) => b.length - a.length)[0];
        if (!file || file.production || !/\.test\.[cm]?tsx?$/u.test(path) || actual !== owner)
          throw new TypeError("invalid-proof-root");
        regularSource(join(subject.root, path));
      }
      return Object.freeze({ owner, paths: Object.freeze(selected) });
    })
    .sort((a, b) => a.owner.localeCompare(b.owner));
  if (new Set(entries.map(({ owner }) => owner)).size !== entries.length)
    throw new TypeError("duplicate-proof-owner");
  return Object.freeze(entries);
}

export function createCompilerContext(subject, options = {}, roots = []) {
  const state = {
    subject,
    proofRoots: roots,
    proofManifest: proofManifest(subject, roots),
    proofFingerprint: policyDigest(JSON.stringify(roots)),
    limits: limitsFrom(options),
    inputs: observedInputs(subject),
    fingerprint: subjectFingerprint(subject),
    snapshots: new Map(),
    programs: new Map(),
    emissions: new Map(),
    declarations: new Map(),
    proofFailures: new Map(),
    bytes: 0,
    nodes: 0,
    emittedBytes: 0,
    created: 0,
    closed: false,
  };
  return {
    state,
    read: (path) => readOwned(state, path),
    context: (path) => ownerContext(state, path),
    program: (path) => programFor(state, path),
    proofProgram: (path) => programFor(state, path, "proof"),
    resolveModule: (source, specifier, config, mode) =>
      ts.resolveModuleName(
        specifier,
        source,
        config.options,
        compilerHost(state, config),
        undefined,
        undefined,
        mode,
      ).resolvedModule,
    assertCurrent: () => assertCurrent(state),
    close: () => {
      state.programs.clear();
      state.emissions.clear();
      state.declarations.clear();
      state.proofFailures.clear();
      for (const previous of state.snapshots.values()) SNAPSHOT_WITNESSES.delete(previous);
      state.snapshots.clear();
      state.closed = true;
    },
  };
}

function assertOpen(state) {
  if (state.closed) throw new TypeError("symbol-resolver-closed");
}

function snapshot(state, absolute, text, digest = policyDigest(text)) {
  const previous = state.snapshots.get(absolute);
  if (previous && previous.digest !== digest) throw new TypeError("symbol-subject-changed");
  if (!previous) {
    state.bytes += Buffer.byteLength(text);
    if (state.bytes > state.limits.sourceBytes) throw new TypeError("symbol-source-budget");
    const admitted = { digest };
    SNAPSHOT_WITNESSES.set(admitted, text.includes("\uFFFD") ? Buffer.from(text, "utf8") : text);
    state.snapshots.set(absolute, admitted);
  }
  return text;
}

function readOwned(state, path) {
  assertOpen(state);
  const absolute = join(state.subject.root, path);
  subjectPath(state.subject, absolute);
  regularSource(absolute);
  const text = readFileSync(absolute, "utf8");
  const expected = state.inputs.get(path);
  const digest = policyDigest(text);
  if (expected !== undefined && digest !== expected) throw new TypeError("symbol-subject-changed");
  return snapshot(state, absolute, text, digest);
}

function ownerContext(state, path) {
  assertOpen(state);
  const owners = [...state.subject.contexts.keys()].filter(
    (owner) => owner === "" || path.startsWith(`${owner}/`),
  );
  owners.sort((left, right) => right.length - left.length);
  return { owner: owners[0], config: state.subject.contexts.get(owners[0]) };
}

function compilerHost(state, config) {
  const host = ts.createCompilerHost(config.options, true);
  const read = host.readFile;
  host.readFile = (absolute) => {
    const text = read(absolute);
    if (text === undefined) return undefined;
    const path = relative(state.subject.root, absolute).replaceAll("\\", "/");
    if (state.inputs.has(path) || state.subject.outputs.has(path)) return readOwned(state, path);
    return snapshot(state, absolute, text);
  };
  return host;
}

function immutableProofOption(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableProofOption));
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, option]) => [key, immutableProofOption(option)]),
    ),
  );
}

function proofConfiguration(config, fileNames) {
  const options = Object.fromEntries(
    Object.entries(config.options).map(([key, value]) => [
      key,
      // The compiler's original config AST is not a plain option collection and stays untouched.
      key === "configFile" ? value : immutableProofOption(value),
    ]),
  );
  const configFile = Object.getOwnPropertyDescriptor(config.options, "configFile");
  if (configFile) Object.defineProperty(options, "configFile", configFile);
  options.noEmit = true;
  return Object.freeze({
    ...config,
    fileNames: Object.freeze(fileNames),
    options: Object.freeze(options),
  });
}

function programConfig(state, path, role) {
  const { owner, config } = ownerContext(state, path);
  if (!config) throw new TypeError("symbol-context-missing");
  if (role === "production") return { owner, config, key: JSON.stringify([owner, role, []]) };
  const entry = state.proofManifest.find((value) => value.owner === owner);
  if (!entry?.paths.includes(path)) throw new TypeError("undeclared-proof-root");
  const fileNames = [
    ...new Set([...config.fileNames, ...entry.paths.map((root) => join(state.subject.root, root))]),
  ].sort(compareStrings);
  return {
    owner,
    config: proofConfiguration(config, fileNames),
    key: JSON.stringify([owner, role, entry.paths]),
  };
}

function programFor(state, path, role = "production") {
  assertOpen(state);
  if (role === "proof") assertCurrent(state);
  const { owner, config, key } = programConfig(state, path, role);
  const failure = state.proofFailures.get(key);
  if (failure) throw failure;
  const cached = state.programs.get(key);
  if (cached) {
    state.programs.delete(key);
    state.programs.set(key, cached);
    return cached;
  }
  assertCurrent(state);
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
    projectReferences: config.projectReferences,
    host: compilerHost(state, config),
  });
  state.created += 1;
  if (role === "proof" && ts.getPreEmitDiagnostics(program).length) {
    const error = new TypeError("unqualified-proof-context");
    state.proofFailures.set(key, error);
    throw error;
  }
  const context = {
    role,
    owner,
    config,
    program,
    checker: program.getTypeChecker(),
    qualified: new Set(),
  };
  state.programs.set(key, context);
  if (state.programs.size > state.limits.programs)
    state.programs.delete(state.programs.keys().next().value);
  return context;
}

function assertCurrent(state) {
  assertOpen(state);
  if (policyDigest(JSON.stringify(state.proofRoots)) !== state.proofFingerprint)
    throw new TypeError("symbol-proof-context-changed");
  if (subjectFingerprint(state.subject) !== state.fingerprint)
    throw new TypeError("symbol-context-changed");
  const current = collectPolicyPaths(state.subject.root);
  if (current.join("\0") !== state.subject.membership.paths.join("\0"))
    throw new TypeError("symbol-membership-changed");
  for (const [path, expected] of state.inputs) {
    const absolute = join(state.subject.root, path);
    regularSource(absolute);
    if (!hasCurrentDigest(absolute, state.snapshots.get(absolute), expected))
      throw new TypeError("symbol-subject-changed");
  }
  for (const [path, previous] of state.snapshots) {
    if (!hasCurrentDigest(path, previous, previous.digest))
      throw new TypeError("symbol-subject-changed");
  }
}

function hasCurrentDigest(path, previous, expected) {
  const witness = SNAPSHOT_WITNESSES.get(previous);
  // Invalid UTF8 decodes with U+FFFD, so it cannot equal an admitted string without that character.
  if (previous?.digest === expected && typeof witness === "string")
    return readFileSync(path, "utf8") === witness;
  const bytes = readFileSync(path);
  if (previous?.digest === expected && Buffer.isBuffer(witness) && bytes.equals(witness))
    return true;
  return policyDigest(bytes) === expected;
}

export function visitCompilerNodes(state, node, visit) {
  state.nodes += 1;
  if (state.nodes > state.limits.nodes) throw new TypeError("symbol-node-budget");
  visit(node);
  ts.forEachChild(node, (child) => visitCompilerNodes(state, child, visit));
}

export function qualifiedAlias(context, symbol, limit) {
  const seen = new Set();
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    if (seen.has(symbol) || seen.size >= limit) throw new TypeError("symbol-alias-budget");
    seen.add(symbol);
    symbol = context.checker.getAliasedSymbol(symbol);
  }
  if (!symbol?.declarations?.length) throw new TypeError("unresolved-owner-symbol");
  return symbol;
}
