// Unit tests for the clean-checkout demo CLI helpers (Issue #2634). The shim at
// `scripts/knowledge-m2-clean-checkout-demo.mjs` is a two-line entry point around
// `runCliFromEntryPoint`; these tests exercise every branch of the underlying helpers directly so
// coverage reflects what the CLI does. A subprocess test would exercise the same paths but v8
// coverage does not follow spawned processes.

import { describe, expect, it, vi } from "vitest";

import {
  CleanCheckoutDemoFailure,
  loadAcceptanceRuntime,
  main,
  requestedDimensions,
  requireProvisionedUsearchRuntime,
  runCliFromEntryPoint,
  shouldPrettyPrint,
} from "../lib/clean-checkout-demo-cli.mjs";

const CONTENT_FREE_EVIDENCE = Object.freeze({
  demo: "knowledge-m2-clean-checkout",
  issue: "#2634",
  schemaVersion: "3",
  executionMode: "acceptance",
  acceptanceEligible: true,
  cleanCheckout: {
    workspaceRootExists: true,
    keikoStatePresentAtStart: false,
    buildArtifactsPresentAtStart: false,
    indexedPathsRequested: 3,
    indexedPathsResolved: 3,
    fingerprintCount: 3,
  },
  vectorIndex: {
    provider: "usearch",
    status: "available",
    searchMode: "exact",
    forbiddenStatusesAvoided: [
      "disabled",
      "fallback-unavailable",
      "fallback-encrypted-store",
      "fallback-unsupported-metric",
      "fallback-incompatible-identity",
      "fallback-index-too-large",
      "fallback-query-error",
    ],
    providerAvailable: true,
    hnswQualifiedBy: "npm run check:knowledge-m2-closeout",
  },
  multiFileQuery: {
    queryHash: "0".repeat(64),
    referenceCount: 3,
    attachedCitationCount: 3,
    citationCount: 3,
    generatedCharacters: 42,
    generationHash: "5".repeat(64),
    noEvidence: false,
    distinctFileCount: 2,
    spansMultipleFiles: true,
    citationFiles: ["a", "b"],
    citationLinesResolved: true,
    fileLineHash: "1".repeat(64),
  },
  abstention: {
    queryHash: "2".repeat(64),
    references: 0,
    citations: 0,
    generatedCharacters: 0,
    generationCalls: 0,
    noEvidence: true,
    abstained: true,
  },
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

  it("fails when acceptance mode requires an explicit dimension", () => {
    const fail = vi.fn(() => {
      throw new Error("required");
    });
    expect(() => requestedDimensions({ env: {}, required: true, fail })).toThrow("required");
    expect(fail).toHaveBeenCalledWith(expect.stringContaining("is required in acceptance mode"));
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

describe("requireProvisionedUsearchRuntime", () => {
  it("returns the provisioned path when the resolver finds one", () => {
    const path = requireProvisionedUsearchRuntime({
      resolveRuntimePath: () => "/tmp/usearch.node",
      verifyRuntime: () => true,
    });
    expect(path).toBe("/tmp/usearch.node");
  });

  it("fails closed when the provisioned binary does not match the pinned digest", () => {
    const fail = vi.fn(() => {
      throw new Error("integrity");
    });
    expect(() =>
      requireProvisionedUsearchRuntime({
        resolveRuntimePath: () => "/tmp/tampered-usearch.node",
        verifyRuntime: () => false,
        fail,
      }),
    ).toThrow("integrity");
    expect(fail).toHaveBeenCalledWith(expect.stringContaining("SHA-256 verification"));
  });

  it("fails with an actionable message for supported platforms without provisioning", () => {
    const fail = vi.fn(() => {
      throw new Error("stopped");
    });
    expect(() =>
      requireProvisionedUsearchRuntime({
        resolveRuntimePath: () => undefined,
        platform: "linux",
        arch: "x64",
        repoRoot: "/repo",
        fail,
      }),
    ).toThrow("stopped");
    expect(fail).toHaveBeenCalledWith(
      expect.stringContaining("USearch native runtime is not provisioned"),
    );
    expect(fail).toHaveBeenCalledWith(expect.stringContaining("npm run provision:usearch"));
  });

  it("fails with an unsupported-host message when no upstream asset exists", () => {
    const fail = vi.fn(() => {
      throw new Error("no-asset");
    });
    expect(() =>
      requireProvisionedUsearchRuntime({
        resolveRuntimePath: () => undefined,
        platform: "sunos",
        arch: "sparc",
        fail,
      }),
    ).toThrow("no-asset");
    expect(fail).toHaveBeenCalledWith(
      expect.stringContaining("no approved Keiko runtime for sunos-sparc"),
    );
  });
});

describe("loadAcceptanceRuntime", () => {
  const env = {
    KEIKO_CONFIG_FILE: "/outside/keiko.config.json",
    KEIKO_CLEAN_CHECKOUT_DEMO_EMBEDDING_MODEL_ID: "embed-real",
    KEIKO_CLEAN_CHECKOUT_DEMO_ANSWER_MODEL_ID: "chat-real",
  };

  it("loads a real configured runtime without exposing configuration values", () => {
    const gatewayConfig = { providers: [], circuitBreaker: {} };
    const loadConfig = vi.fn(() => gatewayConfig);
    expect(loadAcceptanceRuntime({ env, loadConfig })).toEqual({
      gatewayConfig,
      embeddingModelId: "embed-real",
      answerModelId: "chat-real",
    });
    expect(loadConfig).toHaveBeenCalledWith("/outside/keiko.config.json", env);
  });

  it("fails closed when any acceptance provider selector is absent", () => {
    const fail = vi.fn(() => {
      throw new Error("missing");
    });
    expect(() => loadAcceptanceRuntime({ env: {}, fail })).toThrow("missing");
    expect(fail).toHaveBeenCalledWith("KEIKO_CONFIG_FILE is required in acceptance mode");
  });

  it("redacts configuration-loader details", () => {
    const fail = vi.fn(() => {
      throw new Error("stopped");
    });
    expect(() =>
      loadAcceptanceRuntime({
        env,
        loadConfig: () => {
          throw new Error("invalid gateway config");
        },
        fail,
      }),
    ).toThrow("stopped");
    expect(fail).toHaveBeenCalledWith("could not load or validate the configured model provider");
  });
});

describe("main", () => {
  const runtime = {
    gatewayConfig: { providers: [], circuitBreaker: {} },
    embeddingModelId: "embed-real",
    answerModelId: "chat-real",
  };

  function scaffold({ runDemo, argv } = {}) {
    const stderr = collectStrings();
    const stdout = collectStrings();
    const loadRuntime = vi.fn(() => runtime);
    return {
      stderr,
      stdout,
      loadRuntime,
      run: () =>
        main({
          env: { KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS: "32" },
          argv: argv ?? ["node", "cli.mjs"],
          stderr: stderr.write,
          stdout: stdout.write,
          repoRoot: "/repo",
          runDemo: runDemo ?? vi.fn(() => Promise.resolve({ ...CONTENT_FREE_EVIDENCE })),
          loadRuntime,
          requireRuntime: () => "/tmp/usearch.node",
        }),
    };
  }

  it("loads configured providers, runs acceptance mode, and prints compact JSON", async () => {
    const scaffolded = scaffold();
    await scaffolded.run();
    expect(scaffolded.loadRuntime).toHaveBeenCalled();
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

  it("propagates a production runner failure", async () => {
    const runDemo = vi.fn(() => Promise.reject(new Error("runner failed")));
    const scaffolded = scaffold({ runDemo });
    await expect(scaffolded.run()).rejects.toThrow("runner failed");
  });

  it("refuses hermetic evidence at the acceptance CLI boundary", async () => {
    const runDemo = vi.fn(() =>
      Promise.resolve({
        ...CONTENT_FREE_EVIDENCE,
        executionMode: "hermetic-test",
        acceptanceEligible: false,
      }),
    );
    const scaffolded = scaffold({ runDemo });
    await expect(scaffolded.run()).rejects.toBeInstanceOf(CleanCheckoutDemoFailure);
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
