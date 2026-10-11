import { Buffer } from "node:buffer";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import { collectPolicyMembership, policyDigest } from "./code-quality-inventory.mjs";

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

function regularSource(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
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

export function createCompilerContext(subject, options = {}) {
  const state = {
    subject,
    limits: limitsFrom(options),
    inputs: observedInputs(subject),
    fingerprint: subjectFingerprint(subject),
    snapshots: new Map(),
    programs: new Map(),
    emissions: new Map(),
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
    assertCurrent: () => assertCurrent(state),
    close: () => {
      state.programs.clear();
      state.emissions.clear();
      state.snapshots.clear();
      state.closed = true;
    },
  };
}

function assertOpen(state) {
  if (state.closed) throw new TypeError("symbol-resolver-closed");
}

function snapshot(state, absolute, text) {
  const digest = policyDigest(text);
  const previous = state.snapshots.get(absolute);
  if (previous && previous.digest !== digest) throw new TypeError("symbol-subject-changed");
  if (!previous) {
    state.bytes += Buffer.byteLength(text);
    if (state.bytes > state.limits.sourceBytes) throw new TypeError("symbol-source-budget");
    state.snapshots.set(absolute, { digest, text });
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
  if (expected !== undefined && policyDigest(text) !== expected)
    throw new TypeError("symbol-subject-changed");
  return snapshot(state, absolute, text);
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

function programFor(state, path) {
  assertOpen(state);
  const { owner, config } = ownerContext(state, path);
  if (!config) throw new TypeError("symbol-context-missing");
  const cached = state.programs.get(owner);
  if (cached) {
    state.programs.delete(owner);
    state.programs.set(owner, cached);
    return cached;
  }
  assertCurrent(state);
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
    projectReferences: config.projectReferences,
    host: compilerHost(state, config),
  });
  const context = {
    owner,
    config,
    program,
    checker: program.getTypeChecker(),
    qualified: new Set(),
  };
  state.created += 1;
  state.programs.set(owner, context);
  if (state.programs.size > state.limits.programs)
    state.programs.delete(state.programs.keys().next().value);
  return context;
}

function assertCurrent(state) {
  assertOpen(state);
  if (subjectFingerprint(state.subject) !== state.fingerprint)
    throw new TypeError("symbol-context-changed");
  const current = collectPolicyMembership(state.subject.root).paths;
  if (current.join("\0") !== state.subject.membership.paths.join("\0"))
    throw new TypeError("symbol-membership-changed");
  for (const [path, expected] of state.inputs) {
    const absolute = join(state.subject.root, path);
    regularSource(absolute);
    if (policyDigest(readFileSync(absolute)) !== expected)
      throw new TypeError("symbol-subject-changed");
  }
  for (const [path, { digest }] of state.snapshots) {
    if (policyDigest(readFileSync(path)) !== digest) throw new TypeError("symbol-subject-changed");
  }
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
