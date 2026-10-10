import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { policyDigest } from "./code-quality-inventory.mjs";
import {
  NON_COSMETIC_RULES,
  RUNNER_VERSION,
  UPSTREAM_COMMIT,
  UPSTREAM_VERSION,
} from "./code-quality-policy.mjs";
import {
  POLICY_TOOL_ROOT as toolRoot,
  POLICY_PLUGIN_ROOT as pluginRoot,
  policyPluginSources,
  withCompiledPolicyPlugin,
} from "./code-quality-plugin.mjs";

const RECEIPT_CODE = "keiko-coverage(program)";

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateToolIdentity(manifest, lock, plugin, installed, bridge, source) {
  const packageLock = lock.packages["node_modules/oxlint-plugin-anti-slop"];
  const checks = [
    manifest.devDependencies.oxlint === RUNNER_VERSION,
    installed.version === RUNNER_VERSION,
    manifest.devDependencies[plugin.name] === source,
    plugin.version === UPSTREAM_VERSION,
    packageLock.resolved === source,
    packageLock.dev === true,
    plugin.license === "MIT",
    bridge.version === RUNNER_VERSION,
    lock.packages["node_modules/oxlint"].version === RUNNER_VERSION,
  ];
  if (!checks.every(Boolean)) throw new TypeError("tool-identity-mismatch");
  if (
    ["oxlint", plugin.name].some(
      (name) =>
        manifest.dependencies?.[name] !== undefined || manifest.bundleDependencies.includes(name),
    )
  )
    throw new TypeError("runtime-tool-dependency");
}

export function runnerIdentity() {
  const manifest = json(join(toolRoot, "package.json"));
  const lock = json(join(toolRoot, "package-lock.json"));
  const plugin = json(join(pluginRoot, "package.json"));
  const packageLock = lock.packages["node_modules/oxlint-plugin-anti-slop"];
  const source = `https://github.com/dmmulroy/anti-slop/archive/${UPSTREAM_COMMIT}.tar.gz`;
  const installed = json(join(toolRoot, "node_modules/oxlint/package.json"));
  const bridge = json(join(toolRoot, "node_modules/@oxlint/plugins/package.json"));
  validateToolIdentity(manifest, lock, plugin, installed, bridge, source);
  const upstream = qualifiedUpstreamSources(plugin.version);
  return {
    runner: installed.version,
    bridge: bridge.version,
    plugin: plugin.version,
    compiler: ts.version,
    upstream: UPSTREAM_COMMIT,
    integrity: packageLock.integrity,
    sources: upstream.files,
    coveragePluginSha256: policyDigest(
      readFileSync(join(toolRoot, "scripts/code-quality-coverage-plugin.mjs")),
    ),
  };
}

function qualifiedUpstreamSources(version) {
  const upstream = json(join(toolRoot, "scripts/code-quality-upstream.json"));
  if (
    upstream.commit !== UPSTREAM_COMMIT ||
    upstream.license !== "MIT" ||
    upstream.version !== version
  ) {
    throw new TypeError("upstream-identity-mismatch");
  }
  const expected = [...policyPluginSources(), "LICENSE", "package.json"].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    expected.join("\0") !==
    upstream.files
      .map((entry) => entry.path)
      .sort((left, right) => left.localeCompare(right))
      .join("\0")
  ) {
    throw new TypeError("upstream-source-inventory-mismatch");
  }
  for (const entry of upstream.files) {
    if (
      !/^(?:src\/[a-zA-Z0-9./-]+|LICENSE|package\.json)$/u.test(entry.path) ||
      entry.path.split("/").includes("..") ||
      policyDigest(readFileSync(join(pluginRoot, entry.path))) !== entry.sha256
    ) {
      throw new TypeError("upstream-source-mismatch");
    }
  }
  return upstream;
}

function nativeConfig(compiled) {
  return {
    options: { respectEslintDisableDirectives: false },
    categories: { correctness: "off" },
    plugins: ["oxc"],
    jsPlugins: [
      { name: "anti-slop", specifier: join(compiled, "src/index.js") },
      { name: "anti-slop-effect", specifier: join(compiled, "src/effect/index.js") },
      {
        name: "keiko-coverage",
        specifier: join(toolRoot, "scripts/code-quality-coverage-plugin.mjs"),
      },
    ],
    rules: {
      ...Object.fromEntries(NON_COSMETIC_RULES.map((id) => [id, "error"])),
      "keiko-coverage/program": "warn",
    },
  };
}

function hasDisableDirective(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      (token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia) &&
      /\boxlint-(?:disable|enable)\b/u.test(scanner.getTokenText())
    )
      return true;
  }
  return false;
}

function diagnosticPath(root, filename) {
  if (typeof filename !== "string") throw new TypeError("unknown-diagnostic");
  const path = relative(root, resolve(root, filename)).replaceAll("\\", "/");
  if (isAbsolute(path) || path.startsWith("../")) throw new TypeError("unknown-diagnostic");
  return path;
}

function normalizedDiagnostic(root, entry) {
  const match = /^([^()]+)\(([^()]+)\)$/u.exec(entry.code ?? "");
  const rule = match === null ? undefined : `${match[1]}/${match[2]}`;
  const span = entry.labels?.[0]?.span;
  if (
    !NON_COSMETIC_RULES.includes(rule) ||
    !Number.isSafeInteger(span?.line) ||
    !Number.isSafeInteger(span?.column)
  )
    throw new TypeError("unknown-diagnostic");
  return { path: diagnosticPath(root, entry.filename), rule, line: span.line, column: span.column };
}

export function validateNativeResult(root, files, result) {
  validateProcessResult(result);
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed.diagnostics)) throw new TypeError("invalid-runner-report");
  const visits = new Map(files.map((file) => [file.path, 0]));
  const diagnostics = [];
  for (const entry of parsed.diagnostics) {
    const path = diagnosticPath(root, entry.filename);
    if (!visits.has(path)) throw new TypeError("unknown-diagnostic");
    if (entry.code === RECEIPT_CODE && entry.message === "keiko-program-visited-v1") {
      visits.set(path, visits.get(path) + 1);
    } else diagnostics.push(normalizedDiagnostic(root, entry));
  }
  if (files.length === 0 || [...visits.values()].some((count) => count !== 1)) {
    throw new TypeError("incomplete-parser-visitation");
  }
  if ((result.status === 1) !== diagnostics.length > 0) throw new TypeError("runner-exit-mismatch");
  return { diagnostics, visited: visits.size };
}

function validateProcessResult(result) {
  if (![0, 1].includes(result.status) || result.error !== undefined || result.stderr.length > 0) {
    throw new TypeError("runner-execution-failed");
  }
}

export function runNativePolicy(root, files) {
  if (files.some((file) => hasDisableDirective(readFileSync(join(root, file.path), "utf8")))) {
    throw new TypeError("inline-policy-suppression");
  }
  return withCompiledPolicyPlugin((compiled) => executeNativePolicy(root, files, compiled));
}

function executeNativePolicy(root, files, compiled) {
  const temporary = mkdtempSync(join(tmpdir(), "keiko-policy-"));
  const config = nativeConfig(compiled);
  const path = join(temporary, "config.json");
  try {
    writeFileSync(path, JSON.stringify(config));
    const scans = policyBatches(files).map((batch) => {
      const result = spawnSync(
        process.execPath,
        [
          join(toolRoot, "node_modules/oxlint/bin/oxlint"),
          "--config",
          path,
          "--format",
          "json",
          "--no-ignore",
          "--disable-nested-config",
          ...batch.map((file) => file.path),
        ],
        { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 128 * 1024 * 1024 },
      );
      return validateNativeResult(root, batch, result);
    });
    const identity = {
      ...config,
      jsPlugins: config.jsPlugins.map((plugin) => ({
        ...plugin,
        specifier: relative(
          plugin.name === "keiko-coverage" ? toolRoot : compiled,
          plugin.specifier,
        ).replaceAll("\\", "/"),
      })),
    };
    return {
      diagnostics: scans.flatMap((scan) => scan.diagnostics),
      visited: scans.reduce((sum, scan) => sum + scan.visited, 0),
      configSha256: policyDigest(JSON.stringify(identity)),
      batches: scans.length,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// Windows limits the command line to 32,767 UTF-16 units. Each file belongs to exactly one batch;
// batching does not repeat an analyzer evaluation or permit a missing Program receipt.
export function policyBatches(files, limit = process.platform === "win32" ? 24_000 : 1_000_000) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const file of files) {
    const cost = file.path.length + 3;
    if (cost > limit) throw new TypeError("source-argument-too-long");
    if (size + cost > limit) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
