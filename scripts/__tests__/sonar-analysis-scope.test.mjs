import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  SONAR_TEST_INCLUSION_PATTERNS,
  analysisScopeFailures,
  classifyAnalysisPath,
  coverageDisposition,
  executeAnalysisScopeCli,
  executeSonarInclusionPartitionCli,
  executeSonarInclusionSafetyCli,
  isCoverableProductSource,
  isGeneratedOrBinaryPath,
  isTestPath,
  optionValue,
  partitionSonarInclusions,
  readNativeScope,
  runAnalysisScopeCheck,
  serializeSonarInclusionPartition,
  sonarInclusionPathsNeedFullScan,
  sourceEncodingFailures,
  systemGitExecutable,
} from "../sonar-analysis-scope.mjs";

const scriptPath = resolve(import.meta.dirname, "..", "sonar-analysis-scope.mjs");
let realRepositoryScopeCliResult;

// The real CLI inventories the entire tracked repository. Keep that cold-start cost in fixture
// setup, while bounding the synchronous child below the hook budget so a hung process fails closed.
beforeAll(() => {
  realRepositoryScopeCliResult = spawnSync(process.execPath, [scriptPath], {
    cwd: resolve(import.meta.dirname, "..", ".."),
    encoding: "utf8",
    timeout: 55_000,
  });
}, 60_000);

const localSonarGate = readFileSync(
  resolve(import.meta.dirname, "..", "..", "docker", "gates", "run-sonar.sh"),
  "utf8",
);
const repositorySonarProperties = readFileSync(
  resolve(import.meta.dirname, "..", "..", "sonar-project.properties"),
  "utf8",
);

const nativeEntries = [
  {
    gates: ["compiler-warnings-as-errors", "native-static-analysis", "launcher-behavior"],
    language: "c",
    path: "native/launcher.c",
    platforms: ["macos", "windows"],
  },
  {
    gates: ["dotnet-analyzers", "compiler-warnings-as-errors", "rfc3161-fixtures"],
    language: "csharp",
    path: "scripts/helper.cs",
    platforms: ["windows"],
  },
];
const nativeSources = new Set(nativeEntries.map((entry) => entry.path));
const validProperties = repositorySonarProperties;

function removePropertyPattern(properties, key, pattern) {
  return properties
    .split("\n")
    .map((line) => {
      if (!line.startsWith(`${key}=`)) return line;
      const values = line.slice(key.length + 1).split(",");
      return `${key}=${values.filter((value) => value !== pattern).join(",")}`;
    })
    .join("\n");
}

function propertyPatterns(properties, key) {
  const line = properties.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
  return new Set(line?.slice(key.length + 1).split(",") ?? []);
}

describe("Sonar analysis scope", () => {
  it("classifies tests, generated artifacts, native sources, and product sources disjointly", () => {
    expect(isTestPath("tests/support/tool.ts")).toBe(true);
    expect(isTestPath("packages/a/src/a.test.ts")).toBe(true);
    expect(isTestPath("packages/a/src/testing/fake.ts")).toBe(true);
    expect(isTestPath("packages/a/src/test-support.ts")).toBe(true);
    expect(isTestPath("native/runtime-supervisor/macos/test-protocol.mjs")).toBe(true);
    expect(isGeneratedOrBinaryPath("docs/design-system/evidence/run/capture.mjs")).toBe(true);
    expect(isGeneratedOrBinaryPath("packages/ui/public/icon.png")).toBe(true);
    expect(isGeneratedOrBinaryPath("packages/ui/public/icon.svg")).toBe(true);
    expect(isGeneratedOrBinaryPath("scripts/native-quality/Keiko.NativeQuality.csproj")).toBe(true);
    // KEIKO-2909 CI: TypeScript declaration files (.d.ts / .d.mts / .d.cts) are not
    // executable sources — the LCOV mapping check must skip them.
    expect(isGeneratedOrBinaryPath("scripts/lib/foo.d.mts")).toBe(true);
    expect(isGeneratedOrBinaryPath("scripts/lib/foo.d.cts")).toBe(true);
    expect(isGeneratedOrBinaryPath("packages/keiko-server/src/index.d.ts")).toBe(true);
    expect(isGeneratedOrBinaryPath(".keiko/dev/ui/task-workspaces/repo/ws/tsconfig.json")).toBe(
      true,
    );
    expect(classifyAnalysisPath("native/launcher.c", nativeSources)).toBe("native-compensated");
    expect(classifyAnalysisPath("native/new.c", nativeSources)).toBe("unclassified-native");
    expect(classifyAnalysisPath("native/new.m", nativeSources)).toBe("unclassified-native");
    expect(classifyAnalysisPath("scripts/__tests__/fixture.cs", nativeSources)).toBe("test");
    expect(
      classifyAnalysisPath("native/runtime-supervisor/macos/test-protocol.mjs", nativeSources),
    ).toBe("test");
    expect(classifyAnalysisPath("native/runtime-supervisor/test-protocol.mjs", nativeSources)).toBe(
      "test",
    );
    expect(
      classifyAnalysisPath("native/secure-workspace-read/test-protocol.mjs", nativeSources),
    ).toBe("test");
    expect(classifyAnalysisPath("scripts/test-protocol.mjs", nativeSources)).toBe("source");
    expect(
      classifyAnalysisPath("scripts/native-quality/Keiko.NativeQuality.csproj", nativeSources),
    ).toBe("excluded");
    expect(classifyAnalysisPath("coverage/report.json", nativeSources)).toBe("excluded");
    expect(classifyAnalysisPath("packages/a/src/a.ts", nativeSources)).toBe("source");
    expect(classifyAnalysisPath(".dependency-cruiser.cjs", nativeSources)).toBe("source");
    expect(classifyAnalysisPath("scripts/check.ps1", nativeSources)).toBe("source");
    expect(classifyAnalysisPath("infrastructure/worker.toml", nativeSources)).toBe("source");
    expect(classifyAnalysisPath("LICENSE", nativeSources)).toBe("ignored");
  });

  it("partitions exact local inclusions without reclassifying production files as tests", () => {
    expect(
      partitionSonarInclusions([
        "scripts/check-external-quality-config.mjs",
        "scripts/__tests__/check-external-quality-config.test.mjs",
        "tests/e2e/smoke.spec.ts",
        "scripts/check-external-quality-config.mjs",
      ]),
    ).toEqual({
      sources: ["scripts/check-external-quality-config.mjs"],
      tests: [
        "scripts/__tests__/check-external-quality-config.test.mjs",
        "tests/e2e/smoke.spec.ts",
      ],
    });
    expect(partitionSonarInclusions(["scripts/check-external-quality-config.mjs"]).tests).toEqual(
      [],
    );
    expect(
      partitionSonarInclusions(["scripts/__tests__/check-external-quality-config.test.mjs"])
        .sources,
    ).toEqual([]);
    const partition = partitionSonarInclusions([
      "scripts/check-external-quality-config.mjs",
      "scripts/__tests__/check-external-quality-config.test.mjs",
    ]);
    expect(new Set([...partition.sources, ...partition.tests])).toEqual(
      new Set([
        "scripts/check-external-quality-config.mjs",
        "scripts/__tests__/check-external-quality-config.test.mjs",
      ]),
    );
    expect(partition.sources.some((path) => partition.tests.includes(path))).toBe(false);
    expect(serializeSonarInclusionPartition('["tests/a.test.ts","src/main.ts"]')).toBe(
      '{"sources":["src/main.ts"],"tests":["tests/a.test.ts"]}',
    );
    const log = vi.fn();
    const error = vi.fn();
    expect(
      executeSonarInclusionPartitionCli({
        source: '["tests/a.test.ts","src/main.ts"]',
        log,
        error,
      }),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith('{"sources":["src/main.ts"],"tests":["tests/a.test.ts"]}');
    expect(error).not.toHaveBeenCalled();
  });

  it("fails closed when the local inclusion inventory is malformed", () => {
    expect(() => partitionSonarInclusions(["src/main.ts", 42])).toThrow(/array of strings/u);
    expect(() => partitionSonarInclusions([""])).toThrow(/represented exactly/u);
    expect(() => partitionSonarInclusions(["src\\literal.ts"])).toThrow(/represented exactly/u);
    expect(() => partitionSonarInclusions([" src/leading.ts"])).toThrow(/represented exactly/u);
    expect(() => partitionSonarInclusions(["src/trailing.ts\u001f"])).toThrow(
      /represented exactly/u,
    );
    expect(() => serializeSonarInclusionPartition("not-json")).toThrow(/payload is invalid/u);
    const log = vi.fn();
    const error = vi.fn();
    expect(executeSonarInclusionPartitionCli({ source: "not-json", log, error })).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("sonar-inclusion-partition: FAIL - invalid path inventory");
  });

  it("routes every inexact inclusion inventory to the full-scan fallback", () => {
    expect(sonarInclusionPathsNeedFullScan(["src/main.ts"])).toBe(false);
    for (const path of [
      " src/leading.ts",
      "src/trailing.ts ",
      "src/trailing.ts\u001f",
      "src\\literal.ts",
      "src/[dynamic].ts",
      "src/comma,name.ts",
    ]) {
      expect(sonarInclusionPathsNeedFullScan([path])).toBe(true);
    }
    const log = vi.fn();
    expect(
      executeSonarInclusionSafetyCli({ source: '[" src/leading.ts"]', log, error: vi.fn() }),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith("yes");
  });

  it("keeps the macOS runtime protocol harness in the Sonar test lane", () => {
    const protocolHarness = "native/runtime-supervisor/macos/test-protocol.mjs";

    expect(propertyPatterns(repositorySonarProperties, "sonar.test.inclusions")).toContain(
      protocolHarness,
    );
    expect(propertyPatterns(repositorySonarProperties, "sonar.exclusions")).toContain(
      protocolHarness,
    );
  });

  it("keeps local Keiko task workspaces outside the local Sonar TypeScript graph", () => {
    expect(localSonarGate).toContain("**/.keiko/**");
    expect(localSonarGate).toContain("rev-parse --path-format=absolute --git-common-dir");
    expect(localSonarGate).not.toContain("rev-parse --absolute-git-dir");
    expect(validProperties).toContain(
      "sonar.typescript.tsconfigPaths=tsconfig.json,packages/*/tsconfig.json,tests/e2e/servers/tsconfig.json",
    );
  });

  it("maps coverable and compensated productive paths to explicit evidence lanes", () => {
    expect(isCoverableProductSource("src/cli/index.ts")).toBe(true);
    expect(isCoverableProductSource("scripts/gate.mjs")).toBe(true);
    expect(isCoverableProductSource("packages/a/src/a.tsx")).toBe(true);
    expect(isCoverableProductSource("packages/a/src/a.test.ts")).toBe(false);
    expect(coverageDisposition("scripts/gate.mjs", nativeSources)).toBe("lcov");
    expect(coverageDisposition("scripts/check.sh", nativeSources)).toBe("shell-guardrails");
    expect(coverageDisposition("scripts/check.ps1", nativeSources)).toBe("shell-guardrails");
    expect(coverageDisposition(".github/workflows/ci.yml", nativeSources)).toBe(
      "actionlint-zizmor",
    );
    expect(coverageDisposition("native/launcher.c", nativeSources)).toBe("native-quality");
    expect(coverageDisposition("packages/keiko-ui/public/worker.js", nativeSources)).toBe(
      "browser-smoke",
    );
    // arch-check-negative.mjs is a spawnSync-only orchestration script; its testable logic
    // is extracted into scripts/lib/bare-specifier-visibility-probe.mjs and covered by its own
    // pod. The orchestration itself is exercised end-to-end by `npm run arch:check:negative`.
    expect(coverageDisposition("scripts/arch-check-negative.mjs", nativeSources)).toBe(
      "static-analysis",
    );
    expect(coverageDisposition("docs/qa/gate.md", nativeSources)).toBe("static-analysis");
    expect(coverageDisposition("tests/gate.test.ts", nativeSources)).toBeUndefined();
  });

  it("rejects invalid source bytes without reading excluded artifacts", () => {
    const readText = vi.fn((path) => {
      if (path === "src/broken.ts") return 'const value = "\uFFFD";';
      if (path === "src/nul.ts") return 'const value = "\0";';
      return "";
    });
    expect(
      sourceEncodingFailures({
        files: ["src/broken.ts", "src/nul.ts", "coverage/report.json"],
        nativeEntries,
        readText,
      }),
    ).toEqual([
      "analyzable text contains a Unicode replacement character: src/broken.ts",
      "analyzable text contains a NUL byte: src/nul.ts",
    ]);
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it("uses absolute system Git paths on every platform", () => {
    expect(systemGitExecutable("darwin")).toBe("/usr/bin/git");
    expect(systemGitExecutable("linux")).toBe("/usr/bin/git");
    expect(systemGitExecutable("win32")).toMatch(/^[A-Za-z]:[\\/]/u);
    expect(systemGitExecutable("win32").endsWith("/Git/cmd/git.exe")).toBe(true);
  });

  it("rejects missing CLI option values and following flags", () => {
    expect(optionValue(["--base", "origin/dev"], "--base")).toBe("origin/dev");
    expect(optionValue(["--base", "--head", "HEAD"], "--base")).toBeUndefined();
    expect(optionValue([], "--base")).toBeUndefined();
  });

  it("fails on missing properties, missing native files, and unclassified native sources", () => {
    const failures = analysisScopeFailures({
      files: ["native/new.c", "scripts/helper.cs"],
      nativeEntries,
      properties: "sonar.sources=.",
    });
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sonar.tests=."),
        expect.stringContaining("sonar.plsql.file.suffixes="),
        "native quality source is not tracked: native/launcher.c",
        "native source has no compensating quality gate: native/new.c",
      ]),
    );
  });

  it("fails when a native manifest entry omits its owning evidence", () => {
    const failures = analysisScopeFailures({
      files: ["native/launcher.c"],
      nativeEntries: [{ gates: [], language: "c", path: "native/launcher.c", platforms: [] }],
      properties: validProperties,
    });
    expect(failures).toEqual(
      expect.arrayContaining([
        "native quality entry has no owning platform: native/launcher.c",
        "native C entry is missing compiler-warnings-as-errors: native/launcher.c",
        "native C entry is missing native-static-analysis: native/launcher.c",
        "native C entry has no behavior or boundary gate: native/launcher.c",
      ]),
    );
  });

  it("fails when a manifest source is not also excluded from Linux Sonar analysis", () => {
    const failures = analysisScopeFailures({
      files: ["native/other/launcher.c"],
      nativeEntries: [
        {
          gates: ["compiler-warnings-as-errors", "native-static-analysis", "launcher-behavior"],
          language: "c",
          path: "native/other/launcher.c",
          platforms: ["macos"],
        },
      ],
      properties: removePropertyPattern(validProperties, "sonar.exclusions", "**/*.c"),
    });
    expect(failures).toContain(
      "native quality source is not excluded from Sonar analysis: native/other/launcher.c",
    );
  });

  it("fails when a test inclusion is not mirrored by a source exclusion", () => {
    const failures = analysisScopeFailures({
      files: nativeEntries.map((entry) => entry.path),
      nativeEntries,
      properties: removePropertyPattern(validProperties, "sonar.exclusions", "**/__tests__/**"),
    });
    expect(failures).toContain("Sonar test inclusion overlaps source scope: **/__tests__/**");
  });

  it("fails when configured test inclusions drift from the executable classifier", () => {
    const missing = removePropertyPattern(validProperties, "sonar.test.inclusions", "**/*.test.*");
    expect(
      analysisScopeFailures({
        files: nativeEntries.map((entry) => entry.path),
        nativeEntries,
        properties: missing,
      }),
    ).toContain("sonar.test.inclusions is missing classifier pattern **/*.test.*");

    const expectedPatterns = SONAR_TEST_INCLUSION_PATTERNS.join(",");
    const unexpected = validProperties.replace(
      `sonar.test.inclusions=${expectedPatterns}`,
      `sonar.test.inclusions=${expectedPatterns},scripts/test-protocol.mjs`,
    );
    expect(
      analysisScopeFailures({
        files: nativeEntries.map((entry) => entry.path),
        nativeEntries,
        properties: unexpected,
      }),
    ).toContain("sonar.test.inclusions has unknown classifier pattern scripts/test-protocol.mjs");
  });

  it("rejects every scope override plus alternate, escaped, and continued declarations", () => {
    const duplicate = `${validProperties}\nsonar.test.inclusions:tests/**`;
    expect(
      analysisScopeFailures({
        files: nativeEntries.map((entry) => entry.path),
        nativeEntries,
        properties: duplicate,
      }),
    ).toContain("sonar.test.inclusions must have exactly one declaration");
    const bare = `${validProperties}\nsonar.test.inclusions`;
    expect(
      analysisScopeFailures({
        files: nativeEntries.map((entry) => entry.path),
        nativeEntries,
        properties: bare,
      }),
    ).toContain("sonar.test.inclusions must have exactly one declaration");

    const expectedPatterns = SONAR_TEST_INCLUSION_PATTERNS.join(",");
    const alternate = validProperties.replace(
      `sonar.test.inclusions=${expectedPatterns}`,
      `sonar.test.inclusions ${expectedPatterns}`,
    );
    expect(
      analysisScopeFailures({
        files: nativeEntries.map((entry) => entry.path),
        nativeEntries,
        properties: alternate,
      }),
    ).toContain("sonar.test.inclusions must use one canonical key=value declaration");

    for (const declaration of [
      "sonar.inclusions=.keiko/no-files/**",
      "sonar.sources=.keiko/no-files",
      "sonar.exclusions=**/*",
    ]) {
      expect(
        analysisScopeFailures({
          files: nativeEntries.map((entry) => entry.path),
          nativeEntries,
          properties: `${validProperties}\n${declaration}`,
        }),
      ).not.toEqual([]);
    }

    const escaped = `${validProperties}\nsonar.test.inclusion\\u0073=tests/**`;
    const continued = `${validProperties}\nsonar.projectName=Keiko\\`;
    expect(
      analysisScopeFailures({
        files: nativeEntries.map((entry) => entry.path),
        nativeEntries,
        properties: escaped,
      }),
    ).toContain("Sonar property keys must not use escapes");
    expect(
      analysisScopeFailures({
        files: nativeEntries.map((entry) => entry.path),
        nativeEntries,
        properties: continued,
      }),
    ).toContain("Sonar properties must not use continuations");

    const bareCarriageReturn = `${validProperties}\rsonar.test.inclusions=scripts/**`;
    expect(
      analysisScopeFailures({
        files: nativeEntries.map((entry) => entry.path),
        nativeEntries,
        properties: bareCarriageReturn,
      }),
    ).toContain("sonar.test.inclusions must have exactly one declaration");
  });

  it("fails closed when either Sonar lane can analyze a native language", () => {
    const withoutSourceC = removePropertyPattern(validProperties, "sonar.exclusions", "**/*.c");
    expect(
      analysisScopeFailures({
        files: nativeEntries.map((entry) => entry.path),
        nativeEntries,
        properties: withoutSourceC,
      }),
    ).toContain("sonar.exclusions is missing native exclusion **/*.c");

    const withoutTestCSharp = removePropertyPattern(
      validProperties,
      "sonar.test.exclusions",
      "**/*.cs",
    );
    expect(
      analysisScopeFailures({
        files: nativeEntries.map((entry) => entry.path),
        nativeEntries,
        properties: withoutTestCSharp,
      }),
    ).toContain("sonar.test.exclusions is missing native exclusion **/*.cs");

    const withoutSourceObjectiveC = removePropertyPattern(
      validProperties,
      "sonar.exclusions",
      "**/*.m",
    );
    expect(
      analysisScopeFailures({
        files: nativeEntries.map((entry) => entry.path),
        nativeEntries,
        properties: withoutSourceObjectiveC,
      }),
    ).toContain("sonar.exclusions is missing native exclusion **/*.m");
  });

  it("fails on unsupported native manifest languages and malformed entry fields", () => {
    const failures = analysisScopeFailures({
      files: ["native/launcher.cc"],
      nativeEntries: [
        { gates: "invalid", language: "cpp", path: "native/launcher.cc", platforms: ["linux"] },
      ],
      properties: validProperties,
    });
    expect(failures).toContain("native quality entry has unsupported language: native/launcher.cc");

    const missingPath = analysisScopeFailures({
      files: [],
      nativeEntries: [{ gates: [], language: "c", platforms: [] }],
      properties: validProperties,
    });
    expect(missingPath).toContain("native quality entry has invalid path: <missing>");
  });

  it("runs a complete injected repository check and reports bounded counts", () => {
    const logs = [];
    expect(
      runAnalysisScopeCheck({
        files: ["native/launcher.c", "scripts/helper.cs", "src/index.ts", "tests/a.test.ts"],
        log: (message) => logs.push(message),
        nativeEntries,
        properties: validProperties,
        root: "/repo",
      }),
    ).toMatchObject({ failures: [] });
    expect(logs).toEqual([
      "sonar-analysis-scope: PASS - 4 repository files; 1 source, 1 test, 2 native-compensated.",
    ]);
  });

  it("ignores cached paths deleted from the working tree", () => {
    const readText = vi.fn(() => "valid");
    const result = runAnalysisScopeCheck({
      execute: () => "src/live.ts\0src/deleted.ts\0",
      fileExists: (path) => !path.endsWith("/src/deleted.ts"),
      log: () => undefined,
      nativeEntries: [],
      properties: validProperties,
      readText,
      root: "/repo",
    });

    expect(result.files).toEqual(["src/live.ts"]);
    expect(readText).toHaveBeenCalledOnce();
    expect(readText).toHaveBeenCalledWith("src/live.ts");
  });

  it("reads and validates the native manifest shape", () => {
    expect(
      readNativeScope("/repo", () => JSON.stringify({ sources: nativeEntries, version: 1 })),
    ).toEqual(nativeEntries);
    expect(() => readNativeScope("/repo", () => JSON.stringify({ version: 2 }))).toThrow(
      "unsupported shape",
    );
  });

  it("adapts CLI success and failure without leaking hidden state", () => {
    let ran = false;
    executeAnalysisScopeCli({ run: () => (ran = true) });
    expect(ran).toBe(true);
    const errors = [];
    const exitCodes = [];
    executeAnalysisScopeCli({
      error: (message) => errors.push(message),
      run: () => {
        throw new Error("scope drift");
      },
      setExitCode: (value) => exitCodes.push(value),
    });
    expect(errors).toEqual(["sonar-analysis-scope: FAIL - scope drift"]);
    expect(exitCodes).toEqual([1]);

    const nonError = [];
    executeAnalysisScopeCli({
      error: (message) => nonError.push(message),
      run: () => {
        throw "redacted";
      },
      setExitCode: () => undefined,
    });
    expect(nonError).toEqual(["sonar-analysis-scope: FAIL - redacted"]);
  });

  it("executes the real repository scope CLI", () => {
    const result = realRepositoryScopeCliResult;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sonar-analysis-scope: PASS");
  });

  it("uses the real repository and default runtime adapters", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = runAnalysisScopeCheck();
      expect(result.files).toContain("sonar-project.properties");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("sonar-analysis-scope: PASS"));
    } finally {
      log.mockRestore();
    }
  });
});
