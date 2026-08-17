#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const binaryExtensions = new Set([
  "7z",
  "aif",
  "aiff",
  "avi",
  "bin",
  "bmp",
  "class",
  "dll",
  "dmg",
  "dylib",
  "eot",
  "exe",
  "gif",
  "gz",
  "icns",
  "ico",
  "jpeg",
  "jpg",
  "m4a",
  "map",
  "mov",
  "mp3",
  "mp4",
  "obj",
  "ogg",
  "otf",
  "pdf",
  "png",
  "so",
  "svg",
  "tar",
  "tgz",
  "tif",
  "tiff",
  "ttf",
  "wasm",
  "wav",
  "webm",
  "webp",
  "woff",
  "woff2",
  "zip",
]);
const codeExtensions = new Set([
  "c",
  "cc",
  "cjs",
  "cs",
  "csproj",
  "css",
  "cts",
  "cxx",
  "editorconfig",
  "example",
  "gitattributes",
  "gitignore",
  "h",
  "hh",
  "htm",
  "html",
  "js",
  "jsx",
  "json",
  "md",
  "m",
  "mjs",
  "mm",
  "mts",
  "plist",
  "prettierignore",
  "properties",
  "ps1",
  "rc",
  "scss",
  "sh",
  "toml",
  "ts",
  "tsx",
  "txt",
  "webmanifest",
  "xml",
  "yaml",
  "yml",
]);
const coverableExtensions = new Set(["cjs", "cts", "js", "jsx", "mjs", "mts", "ts", "tsx"]);
const nativeExtensions = new Set(["c", "cc", "cs", "cxx", "h", "hh", "m", "mm"]);
const generatedPath =
  /(^|\/)(?:\.claude|\.codex|\.keiko|\.next|\.portable-runtime|coverage|dist|node_modules|out)(\/|$)/u;
const nativeSupportPath = /^scripts\/native-quality(?:\/|$)/u;
const nativeSonarExclusions = Object.freeze([
  "**/*.c",
  "**/*.cc",
  "**/*.cxx",
  "**/*.h",
  "**/*.hh",
  "**/*.m",
  "**/*.mm",
  "**/*.cs",
]);
const approvedScopeValueDigests = new Map([
  ["sonar.sources", "cdb4ee2aea69cc6a83331bbe96dc2caa9a299d21329efb0336fc02a82e1839a8"],
  ["sonar.tests", "cdb4ee2aea69cc6a83331bbe96dc2caa9a299d21329efb0336fc02a82e1839a8"],
  // Digest re-pinned after appending shared test-infrastructure modules under `native/`
  // (protocol-harness.mjs + c-source-scanner.mjs) to both the exclusions and the test
  // inclusions. Both are imported ONLY by the three test-protocol.mjs files that already sit
  // in those lists, so they carry the same Sonar disposition. Re-computed the SHA-256 of the
  // raw value after `=` via `createHash("sha256").update(value).digest("hex")`.
  ["sonar.exclusions", "28dbb80db07631cfe6f0a3a35633ea19d2fa152cdf60a67ecfb77ec1249122f4"],
  ["sonar.test.inclusions", "fc189ed7f62a535e41c6175c2893fe3bd3d690ce4bd85c65683db13cb8c2ec58"],
  ["sonar.test.exclusions", "5a01270e497c669e4f0abd5cef680f9eb0139bb8b82da51719b443b076fcd638"],
  [
    "sonar.typescript.tsconfigPaths",
    "016c8b1bfc0b97a73ee1b5680a7b1f46ccb5c24206229367ea88a266fe20c0d5",
  ],
]);
const forbiddenScopeProperties = Object.freeze([
  "sonar.inclusions",
  "sonar.javascript.exclusions",
  "sonar.javascript.file.suffixes",
  "sonar.modules",
  "sonar.projectBaseDir",
  "sonar.typescript.file.suffixes",
]);
const testScopeRules = Object.freeze([
  ["tests/**", (path) => path.startsWith("tests/")],
  ["**/__tests__/**", (path) => path.startsWith("__tests__/") || path.includes("/__tests__/")],
  ["**/testing/**", (path) => path.startsWith("testing/") || path.includes("/testing/")],
  ["**/*.test.*", (path) => /\.test\.[^/]+$/u.test(path)],
  ["**/*.spec.*", (path) => /\.spec\.[^/]+$/u.test(path)],
  ["**/_support.*", (path) => /(?:^|\/)_support\.[^/]+$/u.test(path)],
  ["**/test-support.*", (path) => /(?:^|\/)test-support\.[^/]+$/u.test(path)],
  // KEIKO-0130: shared per-package test-fixture modules live under `src/test-support/`, never
  // in the packaged surface. Excluded from Sonar main-source scope for the same reason
  // `**/test-support.*` is.
  ["**/test-support/**", (path) => /(?:^|\/)test-support\//u.test(path)],
  ["**/test-fixtures.*", (path) => /(?:^|\/)test-fixtures\.[^/]+$/u.test(path)],
  ["**/testing.*", (path) => /(?:^|\/)testing\.[^/]+$/u.test(path)],
  [
    "native/secure-workspace-read/test-protocol.mjs",
    (path) => path === "native/secure-workspace-read/test-protocol.mjs",
  ],
  [
    "native/runtime-supervisor/test-protocol.mjs",
    (path) => path === "native/runtime-supervisor/test-protocol.mjs",
  ],
  [
    "native/runtime-supervisor/macos/test-protocol.mjs",
    (path) => path === "native/runtime-supervisor/macos/test-protocol.mjs",
  ],
  // KEIKO-0304 (review-follow-up on #3202): shared codec/process helpers imported ONLY by the
  // three test-protocol.mjs files above. It carries their Sonar disposition — test infrastructure,
  // not main-code — so an exact-path classifier here matches the sibling entries rather than
  // introducing a broader wildcard that could pick up other native `.mjs` in the future.
  [
    "native/runtime-supervisor/protocol-harness.mjs",
    (path) => path === "native/runtime-supervisor/protocol-harness.mjs",
  ],
  // Coderabbit 3793145636: shared C source scanner (line splicing, comment/literal handling,
  // disabled-preprocessor-branch state machine) imported ONLY by the three test-protocol.mjs
  // harnesses. Same disposition as `protocol-harness.mjs` above.
  ["native/lib/c-source-scanner.mjs", (path) => path === "native/lib/c-source-scanner.mjs"],
]);
export const SONAR_TEST_INCLUSION_PATTERNS = Object.freeze(
  testScopeRules.map(([pattern]) => pattern),
);

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function fileExtension(path) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}

function nativeEntryPath(entry) {
  return typeof entry.path === "string" ? normalizePath(entry.path) : "<missing>";
}

export function isTestPath(input) {
  const path = normalizePath(input);
  return testScopeRules.some(([, matches]) => matches(path));
}

export function partitionSonarInclusions(paths) {
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    throw new TypeError("Sonar inclusion paths must be an array of strings");
  }
  if (sonarInclusionPathsNeedFullScan(paths)) {
    throw new TypeError("Sonar inclusion paths cannot be represented exactly");
  }
  const partitions = { sources: [], tests: [] };
  const normalizedPaths = [...new Set(paths.map((path) => normalizePath(path)))].sort(
    (left, right) => left.localeCompare(right),
  );
  if (normalizedPaths.includes("")) throw new TypeError("Sonar inclusion paths must not be empty");
  for (const path of normalizedPaths) {
    (isTestPath(path) ? partitions.tests : partitions.sources).push(path);
  }
  return partitions;
}

export function sonarInclusionPathsNeedFullScan(paths) {
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) return true;
  return paths.some(
    (path) =>
      path.length === 0 ||
      /[,*?[\]\\\r\n]/u.test(path) ||
      (path.codePointAt(0) ?? 0) <= 0x20 ||
      (path.codePointAt(path.length - 1) ?? 0) <= 0x20,
  );
}

export function serializeSonarInclusionPartition(source) {
  try {
    return JSON.stringify(partitionSonarInclusions(JSON.parse(source)));
  } catch {
    throw new TypeError("Sonar inclusion payload is invalid");
  }
}

export function executeSonarInclusionPartitionCli(input = {}) {
  try {
    const source = input.source ?? readFileSync(0, "utf8");
    (input.log ?? console.log)(serializeSonarInclusionPartition(source));
    return 0;
  } catch {
    (input.error ?? console.error)("sonar-inclusion-partition: FAIL - invalid path inventory");
    return 1;
  }
}

export function executeSonarInclusionSafetyCli(input = {}) {
  try {
    const source = input.source ?? readFileSync(0, "utf8");
    const paths = JSON.parse(source);
    (input.log ?? console.log)(sonarInclusionPathsNeedFullScan(paths) ? "yes" : "no");
    return 0;
  } catch {
    (input.error ?? console.error)("sonar-inclusion-safety: FAIL - invalid path inventory");
    return 1;
  }
}

export function isGeneratedOrBinaryPath(input) {
  const path = normalizePath(input);
  return (
    generatedPath.test(path) ||
    nativeSupportPath.test(path) ||
    path.startsWith("docs/design-system/evidence/") ||
    binaryExtensions.has(fileExtension(path)) ||
    path.endsWith(".d.ts") ||
    /\.(?:generated|min)\.[^/]+$/u.test(path)
  );
}

// Top-level subprocess gates whose behavior cannot cross the Linux v8 coverage boundary.
const NON_LCOV_SCRIPTS = new Set(["scripts/arch-check-negative.mjs"]);

export function isCoverableProductSource(input) {
  const path = normalizePath(input);
  if (
    isTestPath(path) ||
    isGeneratedOrBinaryPath(path) ||
    !coverableExtensions.has(fileExtension(path)) ||
    NON_LCOV_SCRIPTS.has(path)
  ) {
    return false;
  }
  if (path.startsWith("src/") || path.startsWith("scripts/")) return true;
  return path.startsWith("packages/") && path.includes("/src/");
}

export function classifyAnalysisPath(input, nativeSources = new Set()) {
  const path = normalizePath(input);
  if (nativeSources.has(path)) return "native-compensated";
  if (isTestPath(path)) return "test";
  if (nativeExtensions.has(fileExtension(path))) return "unclassified-native";
  if (isGeneratedOrBinaryPath(path)) return "excluded";
  return codeExtensions.has(fileExtension(path)) || path.endsWith("/CODEOWNERS")
    ? "source"
    : "ignored";
}

function propertyPatterns(properties, key) {
  const prefix = `${key}=`;
  const line = properties.split(/\r\n?|\n/u).find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? [] : line.slice(prefix.length).split(",");
}

function activePropertyLines(properties) {
  return properties
    .split(/\r\n?|\n/u)
    .filter((line) => line.trim().length > 0 && !/^[#!]/u.test(line.trimStart()));
}

function propertyKey(line) {
  const trimmed = line.trimStart();
  return /^([^:=\s]+)(?:\s*[=:]\s*|\s+)/u.exec(trimmed)?.[1] ?? trimmed;
}

function propertySyntaxFailures(properties) {
  return activePropertyLines(properties).flatMap((line) => {
    const key = /^[^:=\s]*/u.exec(line.trimStart())?.[0] ?? "";
    return [
      ...(key.includes("\\") ? ["Sonar property keys must not use escapes"] : []),
      ...(line.trimEnd().endsWith("\\") ? ["Sonar properties must not use continuations"] : []),
    ];
  });
}

function canonicalPropertyDeclarationFailures(properties, key, expectedDigest) {
  const declarations = activePropertyLines(properties).filter((line) => propertyKey(line) === key);
  if (declarations.length !== 1) return [`${key} must have exactly one declaration`];
  const declaration = declarations[0];
  if (declaration?.startsWith(`${key}=`) !== true) {
    return [`${key} must use one canonical key=value declaration`];
  }
  const valueDigest = createHash("sha256")
    .update(declaration.slice(key.length + 1))
    .digest("hex");
  return valueDigest === expectedDigest ? [] : [`${key} differs from the approved analysis scope`];
}

function scopePropertyContractFailures(properties) {
  const lines = activePropertyLines(properties);
  const failures = [...approvedScopeValueDigests].flatMap(([key, expectedDigest]) =>
    canonicalPropertyDeclarationFailures(properties, key, expectedDigest),
  );
  for (const key of forbiddenScopeProperties) {
    if (lines.some((line) => propertyKey(line) === key)) {
      failures.push(`${key} must not be declared in sonar-project.properties`);
    }
  }
  return failures;
}

function matchesScopePattern(path, pattern) {
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2));
  if (pattern.startsWith("**/*.")) return path.endsWith(pattern.slice(4));
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
  if (NON_LCOV_SCRIPTS.has(path)) return "static-analysis";
  if (isCoverableProductSource(path)) return "lcov";
  if (path.startsWith(".github/workflows/")) return "actionlint-zizmor";
  if (/\.(?:ps1|sh)$/u.test(path)) return "shell-guardrails";
  if (path.startsWith("packages/keiko-ui/public/")) return "browser-smoke";
  return "static-analysis";
}

export function systemGitExecutable(platform = process.platform) {
  if (platform !== "win32") return "/usr/bin/git";
  const programFiles = process.env.ProgramFiles ?? "C:/Program Files";
  const separator = programFiles.endsWith("/") || programFiles.endsWith("\\") ? "" : "/";
  return `${programFiles}${separator}Git/cmd/git.exe`;
}

export function optionValue(argv, name) {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
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
  if (language === "objective-c") return cEntryFailures(gates, path);
  if (language === "csharp") return csharpEntryFailures(gates, path);
  return [`native quality entry has unsupported language: ${path}`];
}

function nativeEntryFailures(entry) {
  const failures = [];
  const path = nativeEntryPath(entry);
  if (!nativeExtensions.has(fileExtension(path))) {
    failures.push(`native quality entry has invalid path: ${path}`);
  }
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
    "sonar.typescript.tsconfigPaths=tsconfig.json,packages/*/tsconfig.json,tests/e2e/servers/tsconfig.json",
    "sonar.plsql.file.suffixes=-",
    "sonar.test.inclusions=",
    "sonar.test.exclusions=native/portable-launcher/**,scripts/native-quality/**,packages/keiko-quality-intelligence/src/export/__tests__/textSafety.test.ts",
    "sonar.cpd.exclusions=packages/keiko-ui/src/lib/i18n-messages.*.ts,packages/keiko-ui/src/**/*-i18n.ts,packages/keiko-ui/src/**/*-i18n.de.ts,packages/keiko-ui/src/**/*-i18n.en.ts,scripts/__tests__/windows-rfc3161-fixtures.ps1,scripts/__tests__/windows-native-policy-fixtures.ps1",
    "native/portable-launcher/**",
    "scripts/windows-portable-rfc3161.cs",
  ];
  const failures = required
    .filter((entry) => !properties.includes(entry))
    .map((entry) => `sonar-project.properties is missing ${entry}`);
  for (const key of ["sonar.exclusions", "sonar.test.exclusions"]) {
    const patterns = new Set(propertyPatterns(properties, key));
    for (const pattern of nativeSonarExclusions) {
      if (!patterns.has(pattern)) failures.push(`${key} is missing native exclusion ${pattern}`);
    }
  }
  return failures;
}

function sourceTestDisjointnessFailures(properties) {
  const testPatterns = propertyPatterns(properties, "sonar.test.inclusions");
  const sourceExclusions = new Set(propertyPatterns(properties, "sonar.exclusions"));
  return testPatterns
    .filter((pattern) => !sourceExclusions.has(pattern))
    .map((pattern) => `Sonar test inclusion overlaps source scope: ${pattern}`);
}

function testInclusionContractFailures(properties) {
  const actual = new Set(propertyPatterns(properties, "sonar.test.inclusions"));
  const expected = new Set(SONAR_TEST_INCLUSION_PATTERNS);
  return [
    ...[...expected]
      .filter((pattern) => !actual.has(pattern))
      .map((pattern) => `sonar.test.inclusions is missing classifier pattern ${pattern}`),
    ...[...actual]
      .filter((pattern) => !expected.has(pattern))
      .map((pattern) => `sonar.test.inclusions has unknown classifier pattern ${pattern}`),
  ];
}

export function analysisScopeFailures({ files, nativeEntries, properties }) {
  const nativeSources = new Set(nativeEntries.map(nativeEntryPath));
  const tracked = new Set(files.map(normalizePath));
  const failures = [
    ...requiredPropertyFailures(properties),
    ...propertySyntaxFailures(properties),
    ...scopePropertyContractFailures(properties),
  ];
  failures.push(
    ...testInclusionContractFailures(properties),
    ...sourceTestDisjointnessFailures(properties),
    ...nativeEntries.flatMap(nativeEntryFailures),
    ...nativeExclusionFailures(nativeEntries, properties),
  );
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

export function sourceEncodingFailures({ files, nativeEntries, readText }) {
  const nativeSources = new Set(nativeEntries.map(nativeEntryPath));
  return files.flatMap((path) => {
    if (!codeExtensions.has(fileExtension(path)) || isGeneratedOrBinaryPath(path)) return [];
    const scope = classifyAnalysisPath(path, nativeSources);
    if (scope !== "source" && scope !== "test") return [];
    const text = readText(path);
    return [
      ...(text.includes("\uFFFD")
        ? [`analyzable text contains a Unicode replacement character: ${normalizePath(path)}`]
        : []),
      ...(text.includes("\0")
        ? [`analyzable text contains a NUL byte: ${normalizePath(path)}`]
        : []),
    ];
  });
}

function trackedFiles(root, execute = execFileSync, fileExists = existsSync) {
  return execute(
    systemGitExecutable(),
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean)
    .filter((path) => fileExists(resolve(root, path)));
}

function resolveScopeInputs(input) {
  const root = input.root ?? process.cwd();
  const read = input.read ?? readFileSync;
  return {
    files: input.files ?? trackedFiles(root, input.execute, input.fileExists),
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
  const { files, nativeEntries, properties, root } = resolveScopeInputs(input);
  const failures = analysisScopeFailures({ files, nativeEntries, properties });
  if (input.files === undefined || input.readText !== undefined) {
    const readText = input.readText ?? ((path) => readFileSync(resolve(root, path), "utf8"));
    failures.push(...sourceEncodingFailures({ files, nativeEntries, readText }));
  }
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "--partition-inclusions") {
    process.exitCode = executeSonarInclusionPartitionCli();
  } else if (process.argv[2] === "--needs-full-scan") {
    process.exitCode = executeSonarInclusionSafetyCli();
  } else {
    executeAnalysisScopeCli();
  }
}
