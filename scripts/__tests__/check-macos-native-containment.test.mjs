import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkMacNativeContainment,
  validateMacNativeContainmentReport,
} from "../check-macos-native-containment.mjs";

const roots = [];
const repoRoot = resolve(import.meta.dirname, "../..");

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-native-containment-test-"));
  roots.push(root);
  return root;
}

function executable(root, name, body) {
  const path = join(root, name);
  writeFileSync(path, body);
  chmodSync(path, 0o700);
}

function qualityShellFixture(containmentStatus) {
  const root = fixtureRoot();
  const marker = join(root, "containment-invoked");
  executable(
    root,
    "clang",
    `#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then shift; output="$1"; fi
  shift
done
if [ -n "$output" ] && [ "$output" != '/dev/null' ]; then
  case "$output" in
    */keychain-helper|*/keiko-runtime-supervisor|*/keiko-system-extension-manager) status=1 ;;
    *) status=0 ;;
  esac
  printf '#!/bin/sh\\nexit %s\\n' "$status" > "$output"
  chmod 700 "$output"
fi
`,
  );
  executable(
    root,
    "node",
    `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2].endsWith('/check-macos-native-containment.mjs')) {
  fs.writeFileSync(${JSON.stringify(marker)}, 'invoked');
  process.exit(${String(containmentStatus)});
}
`,
  );
  const result = spawnSync("/bin/bash", [join(repoRoot, "scripts/check-macos-native-quality.sh")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${root}:/usr/bin:/bin` },
    timeout: 10_000,
  });
  return { result, invoked: existsSync(marker) };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { force: true, recursive: true });
});

describe("required macOS native quality containment wiring", () => {
  it("actually invokes the containment runner after the existing compiler controls", () => {
    const { result, invoked } = qualityShellFixture(0);
    expect(result.status).toBe(0);
    expect(invoked).toBe(true);
  });

  it("does not report quality success when the containment runner refuses", () => {
    const { result, invoked } = qualityShellFixture(7);
    expect(invoked).toBe(true);
    expect(result.status).toBe(7);
    expect(result.stdout).not.toContain("macos-native-quality: PASS");
  });
});

const owner = join(repoRoot, "packages/keiko-tools/src/exec.test.ts");
const titles = [
  "does not admit an assured run with only Seatbelt and network:none",
  "does not admit an assured run with only Seatbelt and network:inherit",
  "confines files, symlinks and descendants while keeping an owned temporary directory",
  "refuses outbound connections to a host-loopback listener",
  "retains the explicit inherited network choice without removing filesystem confinement",
];

function passingReport() {
  return {
    success: true,
    numPassedTests: 5,
    numFailedTests: 0,
    numPendingTests: 80,
    testResults: [
      {
        name: owner,
        assertionResults: titles.map((title) => ({
          title,
          ancestorTitles: ["native profile containment only"],
          fullName: `native profile containment only ${title}`,
          status: "passed",
        })),
      },
    ],
  };
}

function controlledRun(onCall) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    return onCall(calls, args);
  };
  return { calls, run };
}

function writeRunReport(args, contents) {
  const output = args.find((arg) => arg.startsWith("--outputFile="));
  if (output === undefined) throw new TypeError("Report output is absent");
  writeFileSync(output.slice("--outputFile=".length), contents);
}

describe("required macOS containment execution evidence", () => {
  it.each(["pending", "skipped"])(
    "accepts required tests while keeping filtered %s tests distinct",
    (status) => {
      const report = passingReport();
      report.testResults[0].assertionResults.push({
        title: "unselected control",
        ancestorTitles: ["other suite"],
        fullName: "other suite unselected control",
        status,
      });
      expect(validateMacNativeContainmentReport(report, owner)).toEqual({ required: 5, passed: 5 });
    },
  );

  it.each([
    "missing",
    "skipped",
    "duplicate",
    "failing",
    "foreign-suite",
    "foreign-file",
    "foreign-full-name",
  ])("rejects %s evidence despite a successful aggregate", (fault) => {
    const report = passingReport();
    const result = report.testResults[0];
    const assertion = result.assertionResults[0];
    if (fault === "missing") result.assertionResults.shift();
    if (fault === "skipped") assertion.status = "pending";
    if (fault === "duplicate") result.assertionResults[1] = { ...assertion };
    if (fault === "failing") assertion.status = "failed";
    if (fault === "foreign-suite") assertion.ancestorTitles = ["foreign suite"];
    if (fault === "foreign-full-name") assertion.fullName = `foreign suite ${assertion.title}`;
    if (fault === "foreign-file") result.name = join(repoRoot, "foreign.test.ts");
    expect(() => validateMacNativeContainmentReport(report, owner)).toThrow("invalid-test-report");
  });

  it("refuses a Vitest success consisting entirely of skipped tests", () => {
    const report = passingReport();
    report.numPassedTests = 0;
    for (const assertion of report.testResults[0].assertionResults) assertion.status = "pending";
    expect(() => validateMacNativeContainmentReport(report, owner)).toThrow("invalid-test-report");
  });

  it("requires a real Darwin host before compiling or invoking Vitest", () => {
    const { run, calls } = controlledRun(() => ({ status: 0 }));
    expect(() => checkMacNativeContainment({ platform: "linux", run })).toThrow("non-darwin-host");
    expect(calls).toHaveLength(0);
  });

  it("builds the owning tools dependency graph before the exact real test consumer", () => {
    const { run, calls } = controlledRun((calls, args) => {
      if (calls.length === 2) writeRunReport(args, JSON.stringify(passingReport()));
      return { status: 0, signal: null };
    });
    expect(checkMacNativeContainment({ root: repoRoot, platform: "darwin", run })).toEqual({
      required: 5,
      passed: 5,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args).toEqual([
      join(repoRoot, "node_modules/@typescript/native/bin/tsc"),
      "-b",
      "packages/keiko-tools/tsconfig.json",
    ]);
    expect(calls[1].args[0]).toBe(join(repoRoot, "node_modules/vitest/vitest.mjs"));
    expect(calls[1].args).toContain("packages/keiko-tools/src/exec.test.ts");
    const pattern = calls[1].args[calls[1].args.indexOf("--testNamePattern") + 1];
    for (const title of titles) {
      expect(new RegExp(pattern).test(`native profile containment only ${title}`)).toBe(true);
    }
    expect(new RegExp(pattern).test("foreign suite refuses outbound connections")).toBe(false);
    expect(calls.every((call) => call.options.cwd === repoRoot)).toBe(true);
  });

  it("does not run tests after a failed dependency build", () => {
    const { run, calls } = controlledRun(() => ({ status: 1 }));
    expect(() => checkMacNativeContainment({ root: repoRoot, platform: "darwin", run })).toThrow(
      "tools-build-failed",
    );
    expect(calls).toHaveLength(1);
  });

  it("refuses nonzero or interrupted Vitest even with a valid report", () => {
    for (const result of [{ status: 1 }, { status: 0, signal: "SIGTERM" }]) {
      const { run } = controlledRun((calls, args) => {
        if (calls.length === 1) return { status: 0 };
        writeRunReport(args, JSON.stringify(passingReport()));
        return result;
      });
      expect(() => checkMacNativeContainment({ root: repoRoot, platform: "darwin", run })).toThrow(
        "tests-failed",
      );
    }
  });

  it("refuses absent, malformed and oversized report files", () => {
    for (const contents of [undefined, "not-json", " ".repeat(8 * 1024 * 1024 + 1)]) {
      const { run } = controlledRun((calls, args) => {
        if (calls.length === 2 && contents !== undefined) writeRunReport(args, contents);
        return { status: 0 };
      });
      expect(() => checkMacNativeContainment({ root: repoRoot, platform: "darwin", run })).toThrow(
        "invalid-test-report",
      );
    }
  });
});

describe("required containment runner entry point", () => {
  it("executes through a real symlink spelling instead of silently returning success", () => {
    const alias = join(fixtureRoot(), "containment-alias.mjs");
    symlinkSync(join(repoRoot, "scripts/check-macos-native-containment.mjs"), alias);
    const result = spawnSync(process.execPath, [alias], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (process.platform === "darwin") {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("5/5 required controls executed");
    } else {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("non-darwin-host");
    }
  }, 25_000);
});
