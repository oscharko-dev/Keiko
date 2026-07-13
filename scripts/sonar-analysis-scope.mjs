#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const binaryExtension =
  /\.(?:7z|aiff?|avi|bin|bmp|class|dll|dmg|dylib|eot|exe|gif|gz|icns|ico|jpe?g|m4a|map|mov|mp3|mp4|obj|ogg|otf|pdf|png|so|svg|tar|tgz|tiff?|ttf|wasm|wav|webm|webp|woff2?|zip)$/iu;
const codeExtension =
  /\.(?:c|cc|cjs|cs|csproj|css|cts|cxx|editorconfig|example|gitattributes|gitignore|h|hh|html?|js|jsx|json|md|mjs|mts|plist|prettierignore|properties|ps1|rc|scss|sh|toml|ts|tsx|txt|webmanifest|xml|ya?ml)$/iu;
const coverableExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/iu;
const nativeExtension = /\.(?:c|cc|cs|cxx|h|hh)$/iu;
const generatedPath =
  /(^|\/)(?:\.claude|\.codex|\.next|\.portable-runtime|coverage|dist|node_modules|out)(\/|$)/u;

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function nativeEntryPath(entry) {
  return typeof entry.path === "string" ? normalizePath(entry.path) : "<missing>";
}

export function isTestPath(input) {
  const path = normalizePath(input);
  return (
    path.startsWith("tests/") ||
    path.includes("/__tests__/") ||
    path.includes("/testing/") ||
    /\.(?:spec|test)\.[^/]+$/u.test(path) ||
    /\/(?:_support|test-fixtures|test-support|testing)\.[^/]+$/u.test(path)
  );
}

export function isGeneratedOrBinaryPath(input) {
  const path = normalizePath(input);
  return (
    generatedPath.test(path) ||
    path.startsWith("docs/design-system/evidence/") ||
    binaryExtension.test(path) ||
    path.endsWith(".d.ts") ||
    /\.(?:generated|min)\.[^/]+$/u.test(path)
  );
}

export function isCoverableProductSource(input) {
  const path = normalizePath(input);
  if (isTestPath(path) || isGeneratedOrBinaryPath(path) || !coverableExtension.test(path)) {
    return false;
  }
  if (path.startsWith("src/") || path.startsWith("scripts/")) return true;
  return path.startsWith("packages/") && path.includes("/src/");
}

export function classifyAnalysisPath(input, nativeSources = new Set()) {
  const path = normalizePath(input);
  if (nativeSources.has(path)) return "native-compensated";
  if (isTestPath(path)) return "test";
  if (nativeExtension.test(path)) return "unclassified-native";
  if (isGeneratedOrBinaryPath(path)) return "excluded";
  return codeExtension.test(path) || path.endsWith("/CODEOWNERS") ? "source" : "ignored";
}

function propertyPatterns(properties, key) {
  const prefix = `${key}=`;
  const line = properties.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? [] : line.slice(prefix.length).split(",");
}

function matchesScopePattern(path, pattern) {
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2));
  return path === pattern;
}

function nativeExclusionFailures(nativeEntries, properties) {
  const patterns = propertyPatterns(properties, "sonar.exclusions");
  return nativeEntries
    .map(nativeEntryPath)
    .filter((path) => !patterns.some((pattern) => matchesScopePattern(path, pattern)))
    .map((path) => `native quality source is not excluded from Sonar analysis: ${path}`);
}

export function coverageDisposition(input, nativeSources = new Set()) {
  const path = normalizePath(input);
  const scope = classifyAnalysisPath(path, nativeSources);
  if (scope === "native-compensated") return "native-quality";
  if (scope !== "source") return undefined;
  if (isCoverableProductSource(path)) return "lcov";
  if (path.startsWith(".github/workflows/")) return "actionlint-zizmor";
  if (/\.(?:ps1|sh)$/u.test(path)) return "shell-guardrails";
  if (path.startsWith("packages/keiko-ui/public/")) return "browser-smoke";
  return "static-analysis";
}

export function readNativeScope(root, read = readFileSync) {
  const path = resolve(root, "scripts/native-quality-scope.json");
  const payload = JSON.parse(read(path, "utf8"));
  if (payload.version !== 1 || !Array.isArray(payload.sources)) {
    throw new Error("native quality scope has an unsupported shape");
  }
  return payload.sources;
}

function missingGateFailures(gates, required, label, path) {
  return required
    .filter((gate) => !gates.has(gate))
    .map((gate) => `${label} entry is missing ${gate}: ${path}`);
}

function cEntryFailures(gates, path) {
  const failures = missingGateFailures(
    gates,
    ["compiler-warnings-as-errors", "native-static-analysis"],
    "native C",
    path,
  );
  const hasBehaviorGate = [...gates].some(
    (gate) => gate.endsWith("behavior") || gate.endsWith("boundary"),
  );
  if (!hasBehaviorGate) failures.push(`native C entry has no behavior or boundary gate: ${path}`);
  return failures;
}

function csharpEntryFailures(gates, path) {
  return missingGateFailures(
    gates,
    ["dotnet-analyzers", "compiler-warnings-as-errors", "rfc3161-fixtures"],
    "native C#",
    path,
  );
}

function languageGateFailures(language, gates, path) {
  if (language === "c") return cEntryFailures(gates, path);
  if (language === "csharp") return csharpEntryFailures(gates, path);
  return [`native quality entry has unsupported language: ${path}`];
}

function nativeEntryFailures(entry) {
  const failures = [];
  const path = nativeEntryPath(entry);
  if (!nativeExtension.test(path)) failures.push(`native quality entry has invalid path: ${path}`);
  if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
    failures.push(`native quality entry has no owning platform: ${path}`);
  }
  const gates = new Set(Array.isArray(entry.gates) ? entry.gates : []);
  failures.push(...languageGateFailures(entry.language, gates, path));
  return failures;
}

function requiredPropertyFailures(properties) {
  const required = [
    "sonar.sources=.",
    "sonar.tests=.",
    "sonar.sourceEncoding=UTF-8",
    "sonar.test.inclusions=",
    "sonar.test.exclusions=native/portable-launcher/**,packages/keiko-quality-intelligence/src/export/__tests__/textSafety.test.ts",
    "native/portable-launcher/**",
    "scripts/windows-portable-rfc3161.cs",
  ];
  return required
    .filter((entry) => !properties.includes(entry))
    .map((entry) => `sonar-project.properties is missing ${entry}`);
}

function sourceTestDisjointnessFailures(properties) {
  const testPatterns = propertyPatterns(properties, "sonar.test.inclusions");
  const sourceExclusions = new Set(propertyPatterns(properties, "sonar.exclusions"));
  return testPatterns
    .filter((pattern) => !sourceExclusions.has(pattern))
    .map((pattern) => `Sonar test inclusion overlaps source scope: ${pattern}`);
}

export function analysisScopeFailures({ files, nativeEntries, properties }) {
  const nativeSources = new Set(nativeEntries.map(nativeEntryPath));
  const tracked = new Set(files.map(normalizePath));
  const failures = requiredPropertyFailures(properties);
  failures.push(...sourceTestDisjointnessFailures(properties));
  failures.push(...nativeEntries.flatMap(nativeEntryFailures));
  failures.push(...nativeExclusionFailures(nativeEntries, properties));
  for (const path of nativeSources) {
    if (!tracked.has(path)) failures.push(`native quality source is not tracked: ${path}`);
  }
  for (const path of tracked) {
    if (classifyAnalysisPath(path, nativeSources) === "unclassified-native") {
      failures.push(`native source has no compensating quality gate: ${path}`);
    }
  }
  return failures;
}

function trackedFiles(root, execute = execFileSync) {
  return execute("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function resolveScopeInputs(input) {
  const root = input.root ?? process.cwd();
  const read = input.read ?? readFileSync;
  return {
    files: input.files ?? trackedFiles(root, input.execute),
    nativeEntries: input.nativeEntries ?? readNativeScope(root, read),
    properties: input.properties ?? read(resolve(root, "sonar-project.properties"), "utf8"),
    root,
  };
}

function classifiedCount(counts, key) {
  return counts[key]?.length ?? 0;
}

function scopeReceipt(files, nativeEntries) {
  const nativeSources = new Set(nativeEntries.map(nativeEntryPath));
  const counts = Object.groupBy(files, (path) => classifyAnalysisPath(path, nativeSources));
  return (
    `sonar-analysis-scope: PASS - ${String(files.length)} repository files; ` +
    `${String(classifiedCount(counts, "source"))} source, ` +
    `${String(classifiedCount(counts, "test"))} test, ` +
    `${String(classifiedCount(counts, "native-compensated"))} native-compensated.`
  );
}

export function runAnalysisScopeCheck(input = {}) {
  const { files, nativeEntries, properties } = resolveScopeInputs(input);
  const failures = analysisScopeFailures({ files, nativeEntries, properties });
  if (failures.length > 0) throw new Error(failures.join("\n"));
  (input.log ?? console.log)(scopeReceipt(files, nativeEntries));
  return { failures, files, nativeEntries };
}

export function executeAnalysisScopeCli(input = {}) {
  try {
    (input.run ?? runAnalysisScopeCheck)();
  } catch (error) {
    (input.error ?? console.error)(
      `sonar-analysis-scope: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (input.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) executeAnalysisScopeCli();
