import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateToolCatalogPerformanceEvidence,
  measureToolCatalogPerformanceInFreshProcess,
  sealToolCatalogPerformanceDocument as seal,
  writeToolCatalogPerformanceMeasurement,
  TOOL_CATALOG_PERFORMANCE_FILES as FILES,
} from "../check-tool-catalog-performance.mjs";
import {
  measurePortableToolCatalogPair,
  portableHostEnvironment,
  PortableCatalogBudgetError,
  portableRegenerationOptions,
  regeneratePortableToolCatalogEvidence,
} from "../regenerate-tool-catalog-portable-evidence.mjs";

const root = process.cwd();
const previous = Object.fromEntries(
  Object.entries(FILES).map(([key, path]) => [
    key,
    JSON.parse(readFileSync(join(root, path), "utf8")),
  ]),
);
const context = {
  root: "/candidate",
  baselineRoot: "/baseline",
  baselineCommit: "a".repeat(40),
  candidateCommit: "b".repeat(40),
};
const environment = {
  kind: "paired-host-v1",
  platform: "win32",
  architecture: "x64",
  nodeVersion: "v24.18.0",
  logicalCores: 24,
  totalMemoryBytes: 64_000_000_000,
  osRelease: "10.0.26200",
  cpuModelsSha256: "c".repeat(64),
  nodeBinarySha256: "d".repeat(64),
};

// Real sample identities/shape, deliberately scaled deterministic timings for verdict tests.
function rawFixture(scale = 0.01) {
  const raw = structuredClone(previous.measurement);
  delete raw.subject.measurementHarnessSha256;
  raw.environment = {
    platform: environment.platform,
    architecture: environment.architecture,
    nodeVersion: environment.nodeVersion,
  };
  for (const testCase of Object.values(raw.cases)) {
    for (const metric of ["coldCompileMs", "lookupBatchMs"]) {
      for (const sample of testCase.samples) sample[metric] *= scale;
      for (const key of Object.keys(testCase.aggregates[metric]))
        testCase.aggregates[metric][key] *= scale;
    }
  }
  return raw;
}

function pairDependencies(overrides = {}) {
  const raw = rawFixture();
  return {
    environment: () => structuredClone(environment),
    read: (_root, path) =>
      structuredClone(previous[Object.keys(FILES).find((key) => FILES[key] === path)]),
    ruler: () => "e".repeat(64),
    subject: () => structuredClone(raw.subject),
    measure: vi.fn(() => Promise.resolve(structuredClone(raw))),
    now: () => "2026-10-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("portable tool-catalog reference", () => {
  it("keeps the ruler workspace while loading a separate producer root in a real child", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "keiko-portable-child-test-"));
    const harness = join(scratch, "harness");
    const producer = join(scratch, "producer");
    mkdirSync(join(harness, "scripts"), { recursive: true });
    mkdirSync(producer);
    try {
      writeFileSync(
        join(harness, "scripts/check-tool-catalog-performance.mjs"),
        "export function measureToolCatalogPerformance(root) { return { producer: root, ruler: process.cwd() }; }\n",
      );
      expect(await measureToolCatalogPerformanceInFreshProcess(producer, harness)).toEqual({
        producer,
        ruler: harness,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("measures both source trees with one ruler and preserves every reviewed ceiling", async () => {
    const deps = pairDependencies();
    const pair = await measurePortableToolCatalogPair(context, deps);
    expect(deps.measure.mock.calls).toEqual([
      [context.baselineRoot, context.root],
      [context.root, context.root],
    ]);
    expect(pair.budget.maximumP95Ms).toEqual(previous.budget.maximumP95Ms);
    expect(pair.budget.ceilingP95Ms).toEqual(previous.budget.ceilingP95Ms);
    expect(pair.calibration.portablePair).toEqual(pair.measurement.portablePair);
    expect(pair.calibration.portablePair.previousCalibrationSha256).toBe(
      previous.calibration.documentSha256,
    );
    expect(pair.measurement.portablePair.candidateCommit).toBe(context.candidateCommit);
    expect(
      evaluateToolCatalogPerformanceEvidence(pair.measurement, pair.calibration, pair.budget),
    ).toEqual({ defects: [], verdicts: [] });
    await expect(
      writeToolCatalogPerformanceMeasurement(root, { read: () => pair.calibration }),
    ).rejects.toThrow("requires a fresh baseline/candidate pair");
  });

  it.each(["baseline", "candidate"])(
    "rejects a slow %s without widening the budget",
    async (which) => {
      const measure = vi
        .fn()
        .mockResolvedValueOnce(rawFixture(which === "baseline" ? 1000 : 0.01))
        .mockResolvedValueOnce(rawFixture(which === "candidate" ? 1000 : 0.01));
      await expect(
        measurePortableToolCatalogPair(context, pairDependencies({ measure })),
      ).rejects.toThrow("exceeds the calibrated p95 budget");
    },
  );

  it.each(["baseline", "candidate"])(
    "rejects %s process or subject substitution",
    async (which) => {
      for (const field of ["environment", "subject"]) {
        const substituted = rawFixture();
        if (field === "environment") substituted.environment.architecture = "arm64";
        else substituted.subject.lockfileSha256 = "f".repeat(64);
        const measure = vi
          .fn()
          .mockResolvedValueOnce(which === "baseline" ? substituted : rawFixture())
          .mockResolvedValueOnce(which === "candidate" ? substituted : rawFixture());
        await expect(
          measurePortableToolCatalogPair(context, pairDependencies({ measure })),
        ).rejects.toThrow(which);
      }
    },
  );

  it.each(["environment", "ruler", "baseline", "candidate"])(
    "rejects %s drift during the pair",
    async (kind) => {
      const deps = pairDependencies();
      if (kind === "environment")
        deps.environment = vi
          .fn()
          .mockReturnValueOnce(environment)
          .mockReturnValue({ ...environment, logicalCores: 32 });
      else if (kind === "ruler")
        deps.ruler = vi.fn().mockReturnValueOnce("e".repeat(64)).mockReturnValue("f".repeat(64));
      else {
        const counts = new Map();
        deps.subject = (path) => {
          counts.set(path, (counts.get(path) ?? 0) + 1);
          const subject = rawFixture().subject;
          if (
            path === context[kind === "baseline" ? "baselineRoot" : "root"] &&
            counts.get(path) > 1
          )
            subject.sourceTreeSha256 = "f".repeat(64);
          return subject;
        };
      }
      await expect(measurePortableToolCatalogPair(context, deps)).rejects.toThrow("changed");
    },
  );

  it("refuses corrupt predecessor evidence before starting either process", async () => {
    const deps = pairDependencies({ read: () => ({}) });
    await expect(measurePortableToolCatalogPair(context, deps)).rejects.toThrow();
    expect(deps.measure).not.toHaveBeenCalled();
  });

  it("records body-free native host fingerprints", () => {
    const host = portableHostEnvironment();
    expect(host.platform).toBe(process.platform);
    expect(host.architecture).toBe(process.arch);
    expect(host.logicalCores).toBeGreaterThan(0);
    expect(host.cpuModelsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(host.nodeBinarySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects malformed, mixed and incomplete portable documents even after resealing", async () => {
    const pair = await measurePortableToolCatalogPair(context, pairDependencies());
    const mutations = [
      (doc) => {
        delete doc.portablePair;
      },
      (doc) => {
        doc.portablePair.baselineCommit = "bad";
      },
      (doc) => {
        doc.portablePair.candidateCommit = "bad";
      },
      (doc) => {
        doc.portablePair.previousCalibrationSha256 = "bad";
      },
      (doc) => {
        doc.portablePair.previousBudgetSha256 = "bad";
      },
      (doc) => {
        doc.portablePair.candidateCommit = "f".repeat(40);
      },
      (doc) => {
        doc.environment.platform = "unknown";
      },
      (doc) => {
        doc.environment.architecture = "unknown";
      },
      (doc) => {
        doc.environment.nodeVersion = "v22.0.0";
      },
      (doc) => {
        doc.environment.logicalCores = 4;
      },
      (doc) => {
        doc.environment.logicalCores = 14.5;
      },
      (doc) => {
        doc.environment.totalMemoryBytes = 0;
      },
      (doc) => {
        doc.environment.osRelease = "";
      },
      (doc) => {
        doc.environment.osRelease = "x".repeat(129);
      },
      (doc) => {
        doc.environment.cpuModelsSha256 = "bad";
      },
      (doc) => {
        doc.environment.nodeBinarySha256 = "bad";
      },
      (doc) => {
        doc.environment.kind = "unknown";
      },
      (doc) => {
        doc.environment.osRelease = "another host";
      },
      (doc) => {
        doc.evidenceClass = "functional-performance-reference-container";
      },
      (doc) => {
        delete doc.cases["managed-opencode-v2"];
      },
    ];
    for (const mutate of mutations) {
      const doc = structuredClone(pair.measurement);
      mutate(doc);
      expect(
        evaluateToolCatalogPerformanceEvidence(seal(doc), pair.calibration, pair.budget).defects
          .length,
      ).toBeGreaterThan(0);
    }
    expect(
      evaluateToolCatalogPerformanceEvidence(previous.measurement, pair.calibration, pair.budget)
        .defects.length,
    ).toBeGreaterThan(0);
  });
});

function orchestration(overrides = {}) {
  const documents = {
    calibration: { role: "calibration" },
    measurement: { role: "measurement" },
    budget: { policy: "test" },
  };
  return {
    resolve: (name) => name,
    mkdir: vi.fn(),
    mkdtemp: () => "/scratch",
    write: vi.fn(),
    log: vi.fn(),
    measure: vi.fn(() => Promise.resolve(documents)),
    nodeVersion: "v24.18.0",
    npmCli: "/npm/bin/npm-cli.js",
    run: vi.fn((command, args) => {
      if (command === "git" && args[0] === "rev-parse")
        return args.includes("HEAD") ? context.candidateCommit : context.baselineCommit;
      if (args.includes("--version")) return "11.16.0";
      return "";
    }),
    ...overrides,
  };
}

describe("portable regeneration orchestration", () => {
  it("retains rejected samples outside governed evidence without publishing them", async () => {
    const deps = orchestration();
    const documents = { calibration: { cases: {} }, measurement: { cases: {} } };
    deps.measure.mockRejectedValue(
      new PortableCatalogBudgetError(["baseline exceeds budget"], documents),
    );
    await expect(
      regeneratePortableToolCatalogEvidence({ baseline: "origin/dev" }, context.root, deps),
    ).rejects.toThrow("baseline exceeds budget");
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write.mock.calls[0][0]).toBe(join("/scratch", "failed-pair.json"));
    expect(JSON.parse(deps.write.mock.calls[0][1])).toEqual(documents);
  });

  it("parses an explicit baseline and rejects incomplete or option-like refs", () => {
    expect(portableRegenerationOptions(["--baseline", "origin/dev"])).toEqual({
      baseline: "origin/dev",
    });
    for (const args of [
      [],
      ["--baseline"],
      ["--baseline", ""],
      ["--baseline", "--help"],
      ["--other", "dev"],
      ["--baseline", "dev", "extra"],
    ])
      expect(() => portableRegenerationOptions(args)).toThrow("usage:");
  });

  it("builds both clean installs before measuring and writes only a completed pair", async () => {
    const deps = orchestration();
    await regeneratePortableToolCatalogEvidence({ baseline: "origin/dev" }, context.root, deps);
    expect(
      deps.run.mock.calls
        .filter(([command, args]) => command === process.execPath && !args.includes("--version"))
        .map(([, args, options]) => [args.slice(1), options.cwd]),
    ).toEqual([
      [["ci", "--ignore-scripts", "--no-audit", "--no-fund"], join("/scratch", "baseline")],
      [["run", "build:packages"], join("/scratch", "baseline")],
      [["ci", "--ignore-scripts", "--no-audit", "--no-fund"], context.root],
      [["run", "build:packages"], context.root],
    ]);
    expect(deps.run.mock.calls).toContainEqual([
      "git",
      ["merge-base", "--is-ancestor", context.baselineCommit, context.candidateCommit],
      expect.any(Object),
    ]);
    expect(deps.measure).toHaveBeenCalledWith({
      ...context,
      baselineRoot: join("/scratch", "baseline"),
    });
    expect(deps.write.mock.calls.map(([path]) => path)).toEqual(
      Object.values(FILES).map((path) => join(context.root, path)),
    );
  });

  it.each([
    "dirty",
    "unrelated",
    "missing-npm",
    "wrong-npm",
    "wrong-node",
    "install",
    "measure",
    "head-changed",
    "dirty-after",
  ])("does not publish a partial pair after %s", async (failure) => {
    const deps = orchestration();
    if (failure === "missing-npm") deps.npmCli = undefined;
    if (failure === "wrong-node") deps.nodeVersion = "v22.0.0";
    if (failure === "measure") deps.measure.mockRejectedValue(new Error("measurement failed"));
    const run = deps.run;
    let heads = 0;
    let statuses = 0;
    deps.run = (command, args, options) => {
      if (
        args[0] === "status" &&
        (++statuses > 1 ? failure === "dirty-after" : failure === "dirty")
      )
        return " M changed";
      if (args[0] === "merge-base" && failure === "unrelated")
        throw new Error("unrelated baseline");
      if (args.includes("HEAD") && ++heads > 1 && failure === "head-changed") return "f".repeat(40);
      return failNpmOrRun(failure, run, command, args, options);
    };
    await expect(
      regeneratePortableToolCatalogEvidence({ baseline: "origin/dev" }, context.root, deps),
    ).rejects.toThrow();
    expect(deps.write).not.toHaveBeenCalled();
  });
});

function failNpmOrRun(failure, run, command, args, options) {
  if (args.includes("--version") && failure === "wrong-npm") return "10.0.0";
  if (args.includes("ci") && failure === "install") throw new Error("install failed");
  return run(command, args, options);
}
