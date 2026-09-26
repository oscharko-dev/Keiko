import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  USEARCH_COMMAND,
  USEARCH_CONTROL,
  USEARCH_ERROR,
  USEARCH_STATE,
  type UsearchWorkerData,
} from "./usearch-worker-protocol.js";

const workerThreadHarness = vi.hoisted<{ data: unknown }>(() => ({ data: undefined }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...original,
    get workerData(): unknown {
      return workerThreadHarness.data;
    },
  };
});

const loadFixtureModule = createRequire(import.meta.url);
const EXPECTED_VERSION = "test-usearch-1";

type RuntimeMode =
  "success" | "size-mismatch" | "build-error" | "search-error" | "mutate-on-load" | "side-effect";

interface RuntimeTelemetry {
  readonly constructorArguments: readonly unknown[];
  readonly addKeys: readonly bigint[];
  readonly addVectors: readonly number[];
  readonly addThreads: number;
  readonly query: readonly number[];
  readonly candidateLimit: number;
  readonly searchThreads: number;
}

interface RuntimeFixtureModule {
  readonly telemetry: RuntimeTelemetry;
  version?: () => string;
}

interface RuntimeFixture {
  readonly directory: string;
  readonly path: string;
  readonly sha256: string;
}

interface WorkerHarness {
  readonly data: UsearchWorkerData;
  readonly control: Int32Array;
  readonly query: Float32Array;
  readonly resultKeys: BigUint64Array;
  readonly resultDistances: Float32Array;
}

function runtimeSource(mode: RuntimeMode): string {
  const mutate =
    mode === "mutate-on-load"
      ? 'require("node:fs").appendFileSync(__filename, "\\n// changed during load");'
      : mode === "side-effect"
        ? 'require("node:fs").writeFileSync(`${__filename}.executed`, "executed");'
        : "";
  const size =
    mode === "size-mismatch" ? "return this.keys.length - 1;" : "return this.keys.length;";
  const add =
    mode === "build-error" || mode === "side-effect"
      ? 'throw new Error("synthetic native build failure");'
      : [
          "telemetry.addKeys = Array.from(keys);",
          "telemetry.addVectors = Array.from(vectors);",
          "telemetry.addThreads = threads;",
          "this.keys = keys;",
        ].join("\n");
  const search =
    mode === "search-error"
      ? 'throw new Error("synthetic native search failure");'
      : [
          "telemetry.query = Array.from(vectors);",
          "telemetry.candidateLimit = candidateLimit;",
          "telemetry.searchThreads = threads;",
          "return [",
          "  BigUint64Array.from([2n, 0n]),",
          "  Float32Array.from([0.125, 0.25]),",
          "  BigUint64Array.from([2n]),",
          "];",
        ].join("\n");
  return `
${mutate}
const telemetry = {
  constructorArguments: [],
  addKeys: [],
  addVectors: [],
  addThreads: 0,
  query: [],
  candidateLimit: 0,
  searchThreads: 0,
};
class CompiledIndex {
  constructor(...arguments_) {
    telemetry.constructorArguments = arguments_;
    this.keys = new BigUint64Array();
  }
  add(keys, vectors, threads) {
    ${add}
  }
  search(vectors, candidateLimit, threads) {
    ${search}
  }
  size() {
    ${size}
  }
}
module.exports = {
  CompiledIndex,
  telemetry,
  version: () => ${JSON.stringify(EXPECTED_VERSION)},
};
`;
}

function createRuntimeFixture(mode: RuntimeMode): RuntimeFixture {
  const directory = mkdtempSync(join(tmpdir(), "keiko-usearch-worker-"));
  const path = join(directory, "usearch-runtime.cjs");
  writeFileSync(path, runtimeSource(mode), "utf8");
  return {
    directory,
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function createWorkerHarness(
  runtime: RuntimeFixture,
  overrides: Partial<Pick<UsearchWorkerData, "binarySha256" | "expectedVersion">> = {},
): WorkerHarness {
  const dimensions = 2;
  const rowCount = 3;
  const controlBuffer = new SharedArrayBuffer(
    USEARCH_CONTROL.length * Int32Array.BYTES_PER_ELEMENT,
  );
  const keysBuffer = new SharedArrayBuffer(rowCount * BigUint64Array.BYTES_PER_ELEMENT);
  const vectorsBuffer = new SharedArrayBuffer(
    rowCount * dimensions * Float32Array.BYTES_PER_ELEMENT,
  );
  const queryBuffer = new SharedArrayBuffer(dimensions * Float32Array.BYTES_PER_ELEMENT);
  const resultKeysBuffer = new SharedArrayBuffer(rowCount * BigUint64Array.BYTES_PER_ELEMENT);
  const resultDistancesBuffer = new SharedArrayBuffer(rowCount * Float32Array.BYTES_PER_ELEMENT);
  new BigUint64Array(keysBuffer).set([0n, 1n, 2n]);
  new Float32Array(vectorsBuffer).set([1, 0, 0, 1, 0.5, 0.5]);
  return {
    data: {
      binaryPath: runtime.path,
      binarySha256: overrides.binarySha256 ?? runtime.sha256,
      expectedVersion: overrides.expectedVersion ?? EXPECTED_VERSION,
      dimensions,
      rowCount,
      connectivity: 32,
      expansionAdd: 256,
      expansionSearch: 768,
      controlBuffer,
      keysBuffer,
      vectorsBuffer,
      queryBuffer,
      resultKeysBuffer,
      resultDistancesBuffer,
    },
    control: new Int32Array(controlBuffer),
    query: new Float32Array(queryBuffer),
    resultKeys: new BigUint64Array(resultKeysBuffer),
    resultDistances: new Float32Array(resultDistancesBuffer),
  };
}

async function executeWorker(data: UsearchWorkerData): Promise<void> {
  workerThreadHarness.data = data;
  vi.resetModules();
  await import("./usearch-index-worker.js");
}

function removeRuntimeFixture(runtime: RuntimeFixture): void {
  rmSync(runtime.directory, { recursive: true, force: true });
}

afterEach(() => {
  workerThreadHarness.data = undefined;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("USearch index worker", () => {
  it("builds, searches, and closes through the shared-buffer protocol", async () => {
    const runtime = createRuntimeFixture("success");
    const harness = createWorkerHarness(runtime);
    harness.query.set([0.75, 0.25]);
    Atomics.store(harness.control, USEARCH_CONTROL.requestSequence, 41);
    Atomics.store(harness.control, USEARCH_CONTROL.candidateLimit, 2);
    let waitCount = 0;
    vi.spyOn(Atomics, "wait").mockImplementation((): "ok" => {
      waitCount += 1;
      Atomics.store(
        harness.control,
        USEARCH_CONTROL.command,
        waitCount === 1 ? USEARCH_COMMAND.search : USEARCH_COMMAND.close,
      );
      return "ok";
    });
    try {
      await executeWorker(harness.data);
      const loaded = loadFixtureModule(runtime.path) as RuntimeFixtureModule;
      expect(loaded.telemetry).toMatchObject({
        constructorArguments: [2, "cos", "f32", 32, 256, 768, false],
        addKeys: [0n, 1n, 2n],
        addVectors: [1, 0, 0, 1, 0.5, 0.5],
        addThreads: 1,
        query: [0.75, 0.25],
        candidateLimit: 2,
        searchThreads: 1,
      });
      expect([...harness.resultKeys.subarray(0, 2)]).toEqual([2n, 0n]);
      expect([...harness.resultDistances.subarray(0, 2)]).toEqual([0.125, 0.25]);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.resultCount)).toBe(2);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.responseSequence)).toBe(41);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.error)).toBe(USEARCH_ERROR.none);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.state)).toBe(USEARCH_STATE.closed);
    } finally {
      removeRuntimeFixture(runtime);
    }
  });

  it("rejects a runtime whose bytes do not match the supplied digest", async () => {
    const runtime = createRuntimeFixture("success");
    const harness = createWorkerHarness(runtime, { binarySha256: "0".repeat(64) });
    try {
      await executeWorker(harness.data);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.state)).toBe(USEARCH_STATE.failed);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.error)).toBe(
        USEARCH_ERROR.runtimeInvalid,
      );
    } finally {
      removeRuntimeFixture(runtime);
    }
  });

  it("rejects an unexpected native runtime version", async () => {
    const runtime = createRuntimeFixture("success");
    const harness = createWorkerHarness(runtime, { expectedVersion: "unexpected-version" });
    try {
      await executeWorker(harness.data);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.state)).toBe(USEARCH_STATE.failed);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.error)).toBe(
        USEARCH_ERROR.runtimeInvalid,
      );
    } finally {
      removeRuntimeFixture(runtime);
    }
  });

  it("accepts a digest-pinned legacy runtime that does not expose a version accessor", async () => {
    const runtime = createRuntimeFixture("success");
    const loaded = loadFixtureModule(runtime.path) as RuntimeFixtureModule;
    delete loaded.version;
    const harness = createWorkerHarness(runtime);
    vi.spyOn(Atomics, "wait").mockImplementation((): "ok" => {
      Atomics.store(harness.control, USEARCH_CONTROL.command, USEARCH_COMMAND.close);
      return "ok";
    });
    try {
      await executeWorker(harness.data);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.state)).toBe(USEARCH_STATE.closed);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.error)).toBe(USEARCH_ERROR.none);
    } finally {
      removeRuntimeFixture(runtime);
    }
  });

  it("rejects a runtime that changes while it is being loaded", async () => {
    const runtime = createRuntimeFixture("mutate-on-load");
    const harness = createWorkerHarness(runtime);
    try {
      await executeWorker(harness.data);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.state)).toBe(USEARCH_STATE.failed);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.error)).toBe(
        USEARCH_ERROR.runtimeInvalid,
      );
    } finally {
      removeRuntimeFixture(runtime);
    }
  });

  it.skipIf(process.getuid === undefined)(
    "rejects a writable runtime before its module body can execute",
    async () => {
      const runtime = createRuntimeFixture("side-effect");
      const harness = createWorkerHarness(runtime);
      chmodSync(runtime.path, 0o666);
      try {
        await executeWorker(harness.data);
        expect(existsSync(`${runtime.path}.executed`)).toBe(false);
        expect(Atomics.load(harness.control, USEARCH_CONTROL.state)).toBe(USEARCH_STATE.failed);
        expect(Atomics.load(harness.control, USEARCH_CONTROL.error)).toBe(
          USEARCH_ERROR.runtimeInvalid,
        );
      } finally {
        removeRuntimeFixture(runtime);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked runtime before its module body can execute",
    async () => {
      const runtime = createRuntimeFixture("side-effect");
      const linkedPath = join(runtime.directory, "linked-runtime.cjs");
      symlinkSync(runtime.path, linkedPath);
      const harness = createWorkerHarness({ ...runtime, path: linkedPath });
      try {
        await executeWorker(harness.data);
        expect(existsSync(`${runtime.path}.executed`)).toBe(false);
        expect(Atomics.load(harness.control, USEARCH_CONTROL.state)).toBe(USEARCH_STATE.failed);
        expect(Atomics.load(harness.control, USEARCH_CONTROL.error)).toBe(
          USEARCH_ERROR.runtimeInvalid,
        );
      } finally {
        removeRuntimeFixture(runtime);
      }
    },
  );

  it.skipIf(process.getuid === undefined || process.getuid() === 0)(
    "rejects a runtime outside the current/root POSIX ownership boundary",
    async () => {
      const runtime = createRuntimeFixture("side-effect");
      const harness = createWorkerHarness(runtime);
      const actualUid = process.getuid?.();
      if (actualUid === undefined) throw new Error("expected POSIX uid");
      const untrustedUid = actualUid === 1 ? 2 : 1;
      vi.spyOn(process, "getuid").mockReturnValue(untrustedUid);
      try {
        await executeWorker(harness.data);
        expect(existsSync(`${runtime.path}.executed`)).toBe(false);
        expect(Atomics.load(harness.control, USEARCH_CONTROL.state)).toBe(USEARCH_STATE.failed);
        expect(Atomics.load(harness.control, USEARCH_CONTROL.error)).toBe(
          USEARCH_ERROR.runtimeInvalid,
        );
      } finally {
        removeRuntimeFixture(runtime);
      }
    },
  );

  it("publishes a build failure when the native index reports the wrong row count", async () => {
    const runtime = createRuntimeFixture("size-mismatch");
    const harness = createWorkerHarness(runtime);
    try {
      await executeWorker(harness.data);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.state)).toBe(USEARCH_STATE.failed);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.error)).toBe(USEARCH_ERROR.buildFailed);
    } finally {
      removeRuntimeFixture(runtime);
    }
  });

  it("converts a native build exception into the bounded build-failure code", async () => {
    const runtime = createRuntimeFixture("build-error");
    const harness = createWorkerHarness(runtime);
    try {
      await executeWorker(harness.data);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.state)).toBe(USEARCH_STATE.failed);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.error)).toBe(USEARCH_ERROR.buildFailed);
    } finally {
      removeRuntimeFixture(runtime);
    }
  });

  it("publishes a correlated search failure and returns the protocol to idle", async () => {
    const runtime = createRuntimeFixture("search-error");
    const harness = createWorkerHarness(runtime);
    Atomics.store(harness.control, USEARCH_CONTROL.requestSequence, 73);
    Atomics.store(harness.control, USEARCH_CONTROL.candidateLimit, 2);
    let observedBeforeClose: readonly number[] | undefined;
    let waitCount = 0;
    vi.spyOn(Atomics, "wait").mockImplementation((): "ok" => {
      waitCount += 1;
      if (waitCount === 1) {
        Atomics.store(harness.control, USEARCH_CONTROL.command, USEARCH_COMMAND.search);
      } else {
        observedBeforeClose = [
          Atomics.load(harness.control, USEARCH_CONTROL.command),
          Atomics.load(harness.control, USEARCH_CONTROL.responseSequence),
          Atomics.load(harness.control, USEARCH_CONTROL.resultCount),
          Atomics.load(harness.control, USEARCH_CONTROL.error),
        ];
        Atomics.store(harness.control, USEARCH_CONTROL.command, USEARCH_COMMAND.close);
      }
      return "ok";
    });
    try {
      await executeWorker(harness.data);
      expect(observedBeforeClose).toEqual([
        USEARCH_COMMAND.idle,
        73,
        0,
        USEARCH_ERROR.searchFailed,
      ]);
      expect(Atomics.load(harness.control, USEARCH_CONTROL.state)).toBe(USEARCH_STATE.closed);
    } finally {
      removeRuntimeFixture(runtime);
    }
  });
});
