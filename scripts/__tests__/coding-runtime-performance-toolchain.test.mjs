import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODING_PERFORMANCE_COMMAND,
  CODING_PERFORMANCE_TOOLCHAIN_PATHS,
  codingPerformanceRulerChanged,
  codingPerformanceSubjectPath,
  codingPerformanceToolchainDigest,
} from "../coding-runtime-performance-toolchain.mjs";
import {
  evaluateCodingPerformanceFreshness,
  parseCodingPerformanceGateArgs,
} from "../coding-runtime-performance-gate.mjs";
import {
  collectCodingPerformanceSamples,
  codingPerformanceFailureSummary,
} from "../coding-runtime-performance-producer.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
function inputs(command = "node scripts/coding-runtime-performance-producer.mjs") {
  return new Map([
    ...CODING_PERFORMANCE_TOOLCHAIN_PATHS.map((path) => [path, `fixture:${path}`]),
    ["package.json", JSON.stringify({ scripts: { [CODING_PERFORMANCE_COMMAND]: command } })],
  ]);
}
function digest(files) {
  return codingPerformanceToolchainDigest((path) => {
    const content = files.get(path);
    if (content === undefined) throw new Error("missing input");
    return content;
  });
}

function measuredSample(index) {
  return {
    coldStartMs: index,
    readinessMs: 1,
    sseFirstByteMs: 1,
    boundedThroughputMs: 1,
    observedChunks: 64,
    observedChars: 2048,
    gatewayCalls: 1,
    observedOutputChars: 2048,
  };
}

describe("coding runtime measurement ownership", () => {
  it("binds every ruler input and its command without unrelated package metadata", () => {
    const original = inputs();
    const expected = digest(original);
    for (const path of CODING_PERFORMANCE_TOOLCHAIN_PATHS) {
      const changed = new Map(original);
      changed.set(path, "changed");
      expect(digest(changed)).not.toBe(expected);
    }
    expect(digest(inputs("node other.mjs"))).not.toBe(expected);
    const metadata = new Map(original);
    metadata.set(
      "package.json",
      JSON.stringify({
        name: "unrelated",
        scripts: {
          [CODING_PERFORMANCE_COMMAND]: "node scripts/coding-runtime-performance-producer.mjs",
        },
      }),
    );
    expect(digest(metadata)).toBe(expected);
  });

  it("fails closed with a missing ruler input or producer command", () => {
    const absent = inputs();
    absent.delete(CODING_PERFORMANCE_TOOLCHAIN_PATHS[0]);
    expect(() => digest(absent)).toThrow();
    const command = inputs();
    command.set("package.json", "{}");
    expect(() => digest(command)).toThrow();
  });

  it("includes the imported scripts closure, excluding only native measurement's production subject", () => {
    const members = new Set(CODING_PERFORMANCE_TOOLCHAIN_PATHS);
    for (const file of CODING_PERFORMANCE_TOOLCHAIN_PATHS.filter(
      (path) => path.startsWith("scripts/") && path.endsWith(".mjs"),
    )) {
      const content = readFileSync(join(ROOT, file), "utf8");
      for (const match of content.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/gu)) {
        const dependency = join(dirname(file), match[1]);
        expect(members.has(dependency), `${file} imports unbound ${dependency}`).toBe(true);
      }
    }
    expect(
      members.has(
        "packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.ts",
      ),
    ).toBe(true);
    expect(members.has("scripts/coding-runtime-performance-gate.mjs")).toBe(false);
    expect(members.has("scripts/coding-runtime-performance-budget.json")).toBe(false);
  });

  it.each([
    "packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.ts",
    "packages/keiko-tools/src/git-mutation.ts",
    "native/secure-workspace-read/main.c",
    "package-lock.json",
  ])("binds measured production path %s", (path) =>
    expect(codingPerformanceSubjectPath(path)).toBe(true),
  );

  it.each([
    "packages/keiko-ui/src/app/page.tsx",
    "packages/keiko-server/src/foo.test.ts",
    "packages/keiko-server/src/coding-app-session/_support.ts",
    "docs/qa/perf-evidence.md",
    "scripts/unrelated.mjs",
  ])("does not include unrelated/ruler path %s in the subject", (path) =>
    expect(codingPerformanceSubjectPath(path)).toBe(false),
  );

  it("makes only the diff that moved the ruler owe its freshness", () => {
    expect(codingPerformanceRulerChanged(["docs/qa/perf-evidence.md"])).toBe(false);
    expect(codingPerformanceRulerChanged([CODING_PERFORMANCE_TOOLCHAIN_PATHS[0]])).toBe(true);
    expect(
      codingPerformanceRulerChanged(["package.json"], {
        beforeCommand: "same",
        afterCommand: "same",
      }),
    ).toBe(false);
    expect(
      codingPerformanceRulerChanged(["package.json"], {
        beforeCommand: "old",
        afterCommand: "new",
      }),
    ).toBe(true);
    expect(codingPerformanceRulerChanged(["package.json"])).toBe(true);
  });

  it("separates native release enforcement from nightly source and lockfile drift", () => {
    const oldDigest = "a".repeat(64);
    const newDigest = "b".repeat(64);
    const evidence = {
      measurementHarnessSha256: oldDigest,
      subject: { sourceTreeSha256: oldDigest, lockfileSha256: oldDigest },
    };
    const options = {
      checkRuler: false,
      enforceSourceFreshness: false,
      measurementHarnessSha256: newDigest,
      source: { sourceTreeSha256: newDigest, lockfileSha256: newDigest },
      dirtyInputs: [],
    };
    expect(evaluateCodingPerformanceFreshness(evidence, options)).toEqual({
      defects: [],
      subjectDrift: [],
    });
    const drift = evaluateCodingPerformanceFreshness(evidence, {
      ...options,
      enforceSourceFreshness: true,
    });
    expect(drift.defects).toEqual([]);
    expect(drift.subjectDrift).toHaveLength(2);
    const broken = evaluateCodingPerformanceFreshness(evidence, {
      ...options,
      checkRuler: true,
      enforceSourceFreshness: true,
      dirtyInputs: ["changed"],
    });
    expect(broken.defects).toHaveLength(2);
    expect(broken.subjectDrift).toHaveLength(2);
  });

  it("never reports an invalid current digest as ordinary subject age", () => {
    const digest = "a".repeat(64);
    const result = evaluateCodingPerformanceFreshness(
      {
        measurementHarnessSha256: digest,
        subject: { sourceTreeSha256: digest, lockfileSha256: digest },
      },
      {
        checkRuler: true,
        enforceSourceFreshness: true,
        measurementHarnessSha256: "invalid",
        source: {},
        dirtyInputs: [],
      },
    );
    expect(result.defects).toHaveLength(3);
    expect(result.subjectDrift).toEqual([]);
  });

  it("refuses advisory subject mode unless full source evaluation is enabled", () => {
    expect(() => parseCodingPerformanceGateArgs(["--report-subject-drift"])).toThrow();
    expect(() => parseCodingPerformanceGateArgs(["--unknown"])).toThrow();
    expect(
      parseCodingPerformanceGateArgs(["--enforce-source-freshness", "--report-subject-drift"]),
    ).toEqual({ enforceSourceFreshness: true, reportSubjectDrift: true });
  });

  it("excludes only the two declared warmups and preserves all thirty measured samples", async () => {
    let calls = 0;
    const samples = await collectCodingPerformanceSamples(async () => measuredSample(++calls));
    expect(calls).toBe(32);
    expect(samples.map((sample) => sample.coldStartMs)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 3),
    );
  });

  it("does not retry or drop a failed sample until the budget looks green", async () => {
    let calls = 0;
    await expect(
      collectCodingPerformanceSamples(async () => {
        calls += 1;
        if (calls === 5) throw new Error("invalid measured output");
        return measuredSample(calls);
      }),
    ).rejects.toThrow("invalid measured output");
    expect(calls).toBe(5);
  });
  it("keeps producer failure diagnostics free of paths, credentials and content", () => {
    const message = codingPerformanceFailureSummary(
      "samples",
      new Error("private prompt https://private.example/path token=secret /Users/private"),
    );
    expect(message).toMatch(/^measurement-samples-failed diagnosticSha256=[a-f\d]{64}$/u);
    expect(message).not.toContain("secret");
    expect(message).not.toContain("private");
    expect(codingPerformanceFailureSummary("private stage", "private value")).toMatch(
      /^measurement-unknown-failed/,
    );
  });

  it("rejects a malformed warmup instead of silently discarding its failure", async () => {
    await expect(
      collectCodingPerformanceSamples(async () => ({
        ...measuredSample(1),
        observedOutputChars: 0,
      })),
    ).rejects.toThrow();
  });
});
