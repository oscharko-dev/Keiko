import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import {
  assertNativeEffectFixtureDiagnostics,
  checkNativeHostCodeQuality,
  nativeHostQualityTarget,
  qualifyNativeEffectFixtures,
  runNativeHostQualityProcess,
} from "../check-native-host-code-quality.mjs";
import { nativeEffectQualityFixtures } from "./support/native-effect-quality-fixtures.mjs";
import { OPENCODE_SERVICE_HOST_FIXED_FACTS } from "../../packages/keiko-contracts/dist/opencode-service-host.js";

describe("native host qualification control contract (#3988)", () => {
  it("supports the actual CI/developer host classes and refuses unsupported platforms", () => {
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

  it("binds the lifecycle runner to the staged producer's actual module and Node paths", async () => {
    const calls = [];
    const qualification = {
      target: () => "linux-x64",
      install: () => calls.push("install"),
      stage: async (input) => {
        calls.push(input);
        return {
          root: join(input.outDir, "owned-host"),
          qualification: "private-functional-unapproved",
        };
      },
      fixtures: (moduleRoot, executable) => {
        calls.push({ moduleRoot, executable });
        return { rules: 5, visited: 11, malformedRefused: true };
      },
      execute: (executable, args, options) => {
        calls.push({ executable, args, options });
        return "";
      },
    };
    const result = await checkNativeHostCodeQuality(qualification);
    expect(result).toMatchObject({
      outcome: "passed",
      qualification: "private-functional-unapproved",
    });
    expect(calls[0]).toBe("install");
    expect(calls[2].executable).toBe(
      join(calls[1].outDir, "owned-host", OPENCODE_SERVICE_HOST_FIXED_FACTS.nodeExecutablePath),
    );
    expect(calls[3].options.env.KEIKO_TEST_QUALIFIED_HOST_MODULE_ROOT).toBe(calls[2].moduleRoot);
    expect(calls[3].args).toEqual([
      "--test",
      "native/opencode-service-host/entry.test.mjs",
      "native/opencode-service-host/host.test.mjs",
      "native/opencode-service-host/guard-seams.test.mjs",
    ]);
    expect(existsSync(calls[1].outDir)).toBe(false);
    qualification.stage = async () => {
      throw new TypeError("stage-refused");
    };
    await expect(checkNativeHostCodeQuality(qualification)).rejects.toThrow("stage-refused");
  });

  it("makes actual qualification mandatory in the required Core quality job", () => {
    const workflow = parse(
      readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    );
    const core = Object.values(workflow.jobs).find(({ name }) => name === "Core quality");
    const steps = core.steps.filter(({ run }) => run === "npm run check:native-host-code-quality");
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBeUndefined();
    expect(steps[0]["continue-on-error"]).toBeUndefined();
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)));
    expect(manifest.scripts["check:native-host-code-quality"]).toBe(
      "node scripts/check-native-host-code-quality.mjs",
    );
  });
});
