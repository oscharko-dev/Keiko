import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import {
  assertNativeEffectFixtureDiagnostics,
  nativeHostQualityTarget,
  qualifyNativeEffectFixtures,
  runNativeHostQualityProcess,
  nativeEffectQualityFixtures,
} from "./support/native-effect-quality-fixtures.mjs";

describe("historical Effect controls and current native qualification contract (#3988)", () => {
  it("preserves historical harness host classes and refuses unsupported platforms", () => {
    expect(nativeHostQualityTarget("linux", "x64")).toBe("linux-x64");
    expect(nativeHostQualityTarget("darwin", "arm64")).toBe("macos-arm64");
    expect(nativeHostQualityTarget("darwin", "x64")).toBe("macos-x64");
    expect(() => nativeHostQualityTarget("win32", "x64")).toThrow("platform-unsupported");
    expect(() => nativeHostQualityTarget("linux", "arm64")).toThrow("platform-unsupported");
    if (process.platform === "win32" || !["x64", "arm64"].includes(process.arch))
      expect(() => nativeHostQualityTarget()).toThrow("platform-unsupported");
    else expect(nativeHostQualityTarget()).toBeDefined();
  });

  it("does not accept a failed, signalled or missing execution as a successful receipt", () => {
    expect(
      runNativeHostQualityProcess(process.execPath, ["-e", 'process.stdout.write("ready")'], {}),
    ).toBe("ready");
    for (const args of [
      ["-e", "process.exit(1)"],
      ["-e", 'process.kill(process.pid, "SIGTERM")'],
    ])
      expect(() => runNativeHostQualityProcess(process.execPath, args, {})).toThrow(
        "process-failed",
      );
    expect(() => runNativeHostQualityProcess("/missing/keiko-3988", [], {})).toThrow(
      "process-failed",
    );
  });

  it("requires every actual fixture's owning rejection and no safe fixture Effect finding", () => {
    const diagnostics = nativeEffectQualityFixtures.map(({ rule }) => ({
      path: `${rule}-bad.mjs`,
      rule: `anti-slop-effect/${rule}`,
    }));
    expect(() => assertNativeEffectFixtureDiagnostics({ diagnostics })).not.toThrow();
    expect(() =>
      assertNativeEffectFixtureDiagnostics({ diagnostics: diagnostics.slice(1) }),
    ).toThrow("rejected-fixture-accepted");
    expect(() =>
      assertNativeEffectFixtureDiagnostics({
        diagnostics: [
          ...diagnostics,
          { path: `${nativeEffectQualityFixtures[0].rule}-safe.mjs`, rule: diagnostics[0].rule },
        ],
      }),
    ).toThrow("safe-fixture-rejected");
  });

  it("executes the real parser controls and cleans fixtures after simulated process-result validation", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-3988-control-test-"));
    const executed = [];
    try {
      const result = qualifyNativeEffectFixtures(root, process.execPath, (node, args, options) => {
        executed.push({ node, args, root: options.cwd });
        const fixture = nativeEffectQualityFixtures.find(({ rule }) => args[2].includes(rule));
        return JSON.stringify(fixture.expected);
      });
      expect(result).toEqual({ rules: 5, visited: 11, malformedRefused: true });
      expect(executed).toHaveLength(10);
      expect(executed.every(({ root: temporary }) => !existsSync(temporary))).toBe(true);
      expect(() => qualifyNativeEffectFixtures(root, process.execPath, () => "null")).toThrow(
        "execution-mismatch",
      );
      expect(() => qualifyNativeEffectFixtures(root)).toThrow("process-failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("makes actual qualification mandatory in the required Core quality job", () => {
    const workflow = parse(
      readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    );
    const core = Object.values(workflow.jobs).find(({ name }) => name === "Core quality");
    const steps = core.steps.filter(({ run }) => run === "npm run check:native:linux");
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBeUndefined();
    expect(steps[0]["continue-on-error"]).toBeUndefined();
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)));
    expect(manifest.scripts["check:native:linux"]).toBe(
      "npm run build:packages && bash scripts/check-linux-native-quality.sh",
    );
    expect(manifest.scripts["check:native-host-code-quality"]).toBeUndefined();
  });
});
