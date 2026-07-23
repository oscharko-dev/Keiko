// Unit tests for the clean-checkout demo CLI helpers (Issue #2634). The shim at
// `scripts/knowledge-m2-clean-checkout-demo.mjs` is a two-line entry point around
// `runCliFromEntryPoint`; these tests exercise every branch of the underlying helpers directly so
// coverage reflects what the CLI does. A subprocess test would exercise the same paths but v8
// coverage does not follow spawned processes.

import { describe, expect, it, vi } from "vitest";

import {
  CleanCheckoutDemoFailure,
  main,
  requestedDimensions,
  requireProvisionedExtension,
  runCliFromEntryPoint,
  shouldPrettyPrint,
} from "../lib/clean-checkout-demo-cli.mjs";

const CONTENT_FREE_EVIDENCE = Object.freeze({
  demo: "knowledge-m2-clean-checkout",
  issue: "#2634",
  schemaVersion: "1",
  cleanCheckout: {
    workspaceRootExists: true,
    keikoStatePresentAtStart: false,
    buildArtifactsPresentAtStart: false,
    indexedPathsRequested: 3,
    indexedPathsResolved: 3,
    fingerprintCount: 3,
  },
  annActive: {
    provider: "sqlite-vec",
    status: "available",
    forbiddenStatusesAvoided: ["fallback-encrypted-store", "sqlite-vec-runtime-not-configured"],
    active: true,
  },
  multiFileQuery: {
    queryHash: "0".repeat(64),
    referenceCount: 3,
    citationCount: 3,
    distinctFileCount: 2,
    spansMultipleFiles: true,
    citationFiles: ["a", "b"],
    citationLinesResolved: true,
    fileLineHash: "1".repeat(64),
  },
  abstention: { queryHash: "2".repeat(64), references: 0, noEvidence: true, abstained: true },
  reranker: {
    enabled: {
      policyExternalReranking: "allow",
      diagnosticStatus: "applied",
      selectedOrderHash: "3".repeat(64),
      candidateCount: 3,
      documentCount: 3,
      keptCount: 3,
    },
    disabled: {
      policyExternalReranking: "deny",
      diagnosticStatus: "denied",
      diagnosticFailureKind: "policy-denied",
      selectedOrderHash: "4".repeat(64),
      candidateCount: 3,
      documentCount: 0,
      keptCount: 3,
    },
    answerPathDiffers: true,
  },
  toolchain: { node: "24.18.0", platform: "linux", arch: "x64" },
  elapsedMs: 42,
});

function collectStrings() {
  const buffer = [];
  return { buffer, write: (message) => buffer.push(message) };
}

describe("requestedDimensions", () => {
  it("returns the default when the env var is absent or empty", () => {
    expect(requestedDimensions({ env: {} })).toBe(32);
    expect(requestedDimensions({ env: { KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS: "" } })).toBe(32);
  });

  it("honours a supplied `defaultDimensions`", () => {
    expect(requestedDimensions({ env: {}, defaultDimensions: 64 })).toBe(64);
  });

  it("parses a valid integer inside the 8..4096 range", () => {
    expect(requestedDimensions({ env: { KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS: "128" } })).toBe(128);
  });

  it("rejects a non-integer value via the injected `fail`", () => {
    const fail = vi.fn(() => {
      throw new Error("fail");
    });
    expect(() =>
      requestedDimensions({ env: { KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS: "abc" }, fail }),
    ).toThrow("fail");
    expect(fail).toHaveBeenCalledWith(expect.stringContaining("integer in 8..4096, got 'abc'"));
  });

  it("rejects a value below the floor", () => {
    const fail = vi.fn(() => {
      throw new Error("floor");
    });
    expect(() =>
      requestedDimensions({ env: { KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS: "4" }, fail }),
    ).toThrow("floor");
  });

  it("rejects a value above the ceiling", () => {
    const fail = vi.fn(() => {
      throw new Error("ceil");
    });
    expect(() =>
      requestedDimensions({ env: { KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS: "9999" }, fail }),
    ).toThrow("ceil");
  });
});

describe("shouldPrettyPrint", () => {
  it("returns true only when --pretty appears in argv", () => {
    expect(shouldPrettyPrint({ argv: ["node", "script.mjs"] })).toBe(false);
    expect(shouldPrettyPrint({ argv: ["node", "script.mjs", "--pretty"] })).toBe(true);
  });
});

describe("requireProvisionedExtension", () => {
  it("returns the provisioned path when the resolver finds one", () => {
    const path = requireProvisionedExtension({
      resolveExtensionPath: () => "/tmp/vec0.so",
    });
    expect(path).toBe("/tmp/vec0.so");
  });

  it("fails with an actionable message for supported platforms without provisioning", () => {
    const fail = vi.fn(() => {
      throw new Error("stopped");
    });
    expect(() =>
      requireProvisionedExtension({
        resolveExtensionPath: () => undefined,
        platform: "linux",
        arch: "x64",
        repoRoot: "/repo",
        fail,
      }),
    ).toThrow("stopped");
    expect(fail).toHaveBeenCalledWith(
      expect.stringContaining("sqlite-vec loadable extension is not provisioned"),
    );
    expect(fail).toHaveBeenCalledWith(expect.stringContaining("npm run provision:sqlite-vec"));
  });

  it("fails with an unsupported-host message when no upstream asset exists", () => {
    const fail = vi.fn(() => {
      throw new Error("no-asset");
    });
    expect(() =>
      requireProvisionedExtension({
        resolveExtensionPath: () => undefined,
        platform: "sunos",
        arch: "sparc",
        fail,
      }),
    ).toThrow("no-asset");
    expect(fail).toHaveBeenCalledWith(
      expect.stringContaining("no published loadable extension for sunos-sparc"),
    );
  });
});

describe("main", () => {
  const mockOrigin = "http://127.0.0.1:31337";
  const closedMock = { origin: mockOrigin, close: vi.fn(() => Promise.resolve()) };

  function scaffold({ runDemo, argv } = {}) {
    const stderr = collectStrings();
    const stdout = collectStrings();
    const bootMock = vi.fn(() => Promise.resolve(closedMock));
    return {
      stderr,
      stdout,
      bootMock,
      run: () =>
        main({
          env: {},
          argv: argv ?? ["node", "cli.mjs"],
          stderr: stderr.write,
          stdout: stdout.write,
          repoRoot: "/repo",
          runDemo: runDemo ?? vi.fn(() => Promise.resolve({ ...CONTENT_FREE_EVIDENCE })),
          bootMock,
          requireExtension: () => "/tmp/vec0.so",
        }),
    };
  }

  it("boots the mock, runs the demo, and prints compact JSON on success", async () => {
    const scaffolded = scaffold();
    await scaffolded.run();
    expect(scaffolded.bootMock).toHaveBeenCalledWith({ embeddingDimensions: 32 });
    expect(closedMock.close).toHaveBeenCalled();
    const json = scaffolded.stdout.buffer.join("");
    expect(JSON.parse(json).demo).toBe("knowledge-m2-clean-checkout");
    expect(scaffolded.stderr.buffer.some((line) => line.includes("PASS"))).toBe(true);
  });

  it("prints pretty-printed JSON when --pretty is set", async () => {
    const scaffolded = scaffold({ argv: ["node", "cli.mjs", "--pretty"] });
    await scaffolded.run();
    const json = scaffolded.stdout.buffer.join("");
    expect(json.includes("\n  ")).toBe(true);
  });

  it("closes the mock even when the runner throws", async () => {
    const runDemo = vi.fn(() => Promise.reject(new Error("runner failed")));
    const scaffolded = scaffold({ runDemo });
    await expect(scaffolded.run()).rejects.toThrow("runner failed");
    expect(closedMock.close).toHaveBeenCalled();
  });

  it("throws CleanCheckoutDemoFailure when the evidence carries a redaction violation", async () => {
    const runDemo = vi.fn(() =>
      Promise.resolve({
        ...CONTENT_FREE_EVIDENCE,
        cleanCheckout: {
          ...CONTENT_FREE_EVIDENCE.cleanCheckout,
          leakedEndpoint: "https://provider.example.com/v1",
        },
      }),
    );
    const scaffolded = scaffold({ runDemo });
    await expect(scaffolded.run()).rejects.toBeInstanceOf(CleanCheckoutDemoFailure);
  });

  it("throws CleanCheckoutDemoFailure when the acceptance contract fails", async () => {
    const runDemo = vi.fn(() =>
      Promise.resolve({
        ...CONTENT_FREE_EVIDENCE,
        abstention: { ...CONTENT_FREE_EVIDENCE.abstention, abstained: false, references: 5 },
      }),
    );
    const scaffolded = scaffold({ runDemo });
    await expect(scaffolded.run()).rejects.toBeInstanceOf(CleanCheckoutDemoFailure);
  });
});

describe("runCliFromEntryPoint", () => {
  it("returns { ok: true } and leaves exitCode untouched on success", async () => {
    const priorExit = process.exitCode;
    process.exitCode = 0;
    try {
      const result = await runCliFromEntryPoint({
        mainImpl: () => Promise.resolve(CONTENT_FREE_EVIDENCE),
        stderr: (_message) => undefined,
      });
      expect(result.ok).toBe(true);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = priorExit;
    }
  });

  it("writes the FAIL line and sets exitCode=1 when main throws", async () => {
    const stderr = collectStrings();
    const priorExit = process.exitCode;
    process.exitCode = 0;
    try {
      const result = await runCliFromEntryPoint({
        mainImpl: () => Promise.reject(new Error("boom")),
        stderr: stderr.write,
      });
      expect(result.ok).toBe(false);
      expect(result.message).toBe("boom");
      expect(stderr.buffer.join("")).toContain("FAIL — boom");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExit;
    }
  });

  it("degrades gracefully when a non-Error value is thrown", async () => {
    const stderr = collectStrings();
    const priorExit = process.exitCode;
    process.exitCode = 0;
    try {
      const result = await runCliFromEntryPoint({
        mainImpl: () => Promise.reject("nope"),
        stderr: stderr.write,
      });
      expect(result.ok).toBe(false);
      expect(result.message).toBe("unknown failure");
    } finally {
      process.exitCode = priorExit;
    }
  });
});
