import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  analysisScopeFailures,
  classifyAnalysisPath,
  coverageDisposition,
  executeAnalysisScopeCli,
  isCoverableProductSource,
  isGeneratedOrBinaryPath,
  isTestPath,
  optionValue,
  readNativeScope,
  runAnalysisScopeCheck,
  sourceEncodingFailures,
  systemGitExecutable,
} from "../sonar-analysis-scope.mjs";

const scriptPath = resolve(import.meta.dirname, "..", "sonar-analysis-scope.mjs");

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
const validProperties = [
  "sonar.sources=.",
  "sonar.tests=.",
  "sonar.sourceEncoding=UTF-8",
  "sonar.plsql.file.suffixes=-",
  "sonar.test.inclusions=tests/**",
  "sonar.test.exclusions=native/portable-launcher/**,scripts/native-quality/**,packages/keiko-quality-intelligence/src/export/__tests__/textSafety.test.ts,**/*.c,**/*.cc,**/*.cxx,**/*.h,**/*.hh,**/*.cs",
  "sonar.exclusions=tests/**,native/portable-launcher/**,scripts/native-quality/**,scripts/windows-portable-rfc3161.cs,native/launcher.c,scripts/helper.cs,**/*.c,**/*.cc,**/*.cxx,**/*.h,**/*.hh,**/*.cs",
  "sonar.cpd.exclusions=packages/keiko-ui/src/lib/i18n-messages.*.ts,scripts/__tests__/windows-rfc3161-fixtures.ps1,scripts/__tests__/windows-native-policy-fixtures.ps1",
].join("\n");

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

describe("Sonar analysis scope", () => {
  it("classifies tests, generated artifacts, native sources, and product sources disjointly", () => {
    expect(isTestPath("tests/support/tool.ts")).toBe(true);
    expect(isTestPath("packages/a/src/a.test.ts")).toBe(true);
    expect(isTestPath("packages/a/src/testing/fake.ts")).toBe(true);
    expect(isTestPath("packages/a/src/test-support.ts")).toBe(true);
    expect(isGeneratedOrBinaryPath("docs/design-system/evidence/run/capture.mjs")).toBe(true);
    expect(isGeneratedOrBinaryPath("packages/ui/public/icon.png")).toBe(true);
    expect(isGeneratedOrBinaryPath("packages/ui/public/icon.svg")).toBe(true);
    expect(isGeneratedOrBinaryPath("scripts/native-quality/Keiko.NativeQuality.csproj")).toBe(true);
    expect(classifyAnalysisPath("native/launcher.c", nativeSources)).toBe("native-compensated");
    expect(classifyAnalysisPath("native/new.c", nativeSources)).toBe("unclassified-native");
    expect(classifyAnalysisPath("scripts/__tests__/fixture.cs", nativeSources)).toBe("test");
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
    expect(coverageDisposition("docs/qa/gate.md", nativeSources)).toBe("static-analysis");
    expect(coverageDisposition("tests/gate.test.ts", nativeSources)).toBeUndefined();
  });

  it("rejects replacement characters in analyzable text without reading excluded artifacts", () => {
    const readText = vi.fn((path) => (path === "src/broken.ts" ? 'const value = "\uFFFD";' : ""));
    expect(
      sourceEncodingFailures({
        files: ["src/broken.ts", "coverage/report.json"],
        nativeEntries,
        readText,
      }),
    ).toEqual(["analyzable text contains a Unicode replacement character: src/broken.ts"]);
    expect(readText).toHaveBeenCalledTimes(1);
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
      properties: validProperties,
    });
    expect(failures).toContain(
      "native quality source is not excluded from Sonar analysis: native/other/launcher.c",
    );
  });

  it("fails when a test inclusion is not mirrored by a source exclusion", () => {
    const failures = analysisScopeFailures({
      files: nativeEntries.map((entry) => entry.path),
      nativeEntries,
      properties: validProperties.replace(
        "sonar.test.inclusions=tests/**",
        "sonar.test.inclusions=tests/**,**/__tests__/**",
      ),
    });
    expect(failures).toContain("Sonar test inclusion overlaps source scope: **/__tests__/**");
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
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: resolve(import.meta.dirname, "..", ".."),
      encoding: "utf8",
    });
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
