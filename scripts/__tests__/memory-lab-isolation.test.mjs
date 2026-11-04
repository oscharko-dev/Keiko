// What a run may touch and what it must keep to itself: paths outside every work tree, no real text
// in a kept database or an evidence file, models on this machine only. Every rule is refused before
// an instance starts, so nothing here forks the product.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LabConfigurationError,
  assertGatewayConfigUnchanged,
  assertKeepAllowed,
  assertLoopbackGatewayConfig,
  assertOnlyMeasuredChatModels,
  isAnchorScenario,
  retainBodiesFor,
} from "../testing/memory-lab/isolation.mjs";
import { normalizeOptions, runLab } from "../testing/memory-lab/run.mjs";
import {
  ANSWERER_MODEL_ID,
  LEARNER_MODEL_ID,
  startScriptedModelServer,
} from "../testing/memory-lab/scripted-model.mjs";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";

function config(...hosts) {
  return {
    providers: hosts.map((host, index) => ({
      modelId: `model-${String(index)}`,
      baseUrl: `${host}/v1`,
      timeoutMs: 1000,
    })),
  };
}

function scenario(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "isolation-fixture",
    language: "en",
    class: "preference",
    difficulty: "plain",
    description: "Isolation fixture.",
    truth: [],
    turns: [{ user: "Hello." }],
    probes: [{ id: "p", question: "Kafka?", expect: { kind: "no-memory" } }],
    ...overrides,
  };
}

describe("a gateway configuration that keeps everything on this machine", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-isolation-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function write(value, name = "gateway.json") {
    const file = join(root, name);
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  }

  it.each([
    ["127.0.0.1", "http://127.0.0.1:4000"],
    ["localhost", "http://localhost:4000"],
    ["::1", "http://[::1]:4000"],
  ])("accepts a provider on %s and returns the digest of the file", (_name, host) => {
    const file = write(config(host, "http://127.0.0.1:1"));
    const expected = createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(assertLoopbackGatewayConfig(file)).toEqual({ digest: expected });
  });

  it.each([
    ["a remote host", "https://api.example.invalid"],
    ["a host that starts like loopback", "http://127.0.0.1.example.invalid"],
    ["a private address", "http://192.168.1.20:4000"],
    ["another loopback address", "http://127.0.0.2:4000"],
    ["a host hidden behind a user name", "http://localhost@example.invalid"],
    ["a value that is no URL", "not a url"],
  ])("refuses a provider on %s, even beside a local one", (_name, host) => {
    const file = write(config("http://127.0.0.1:1", host));
    const error = (() => {
      try {
        assertLoopbackGatewayConfig(file);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(LabConfigurationError);
    expect(error.message).toContain("1 provider(s) outside this machine");
    expect(error.message).toContain("model-1");
    expect(error.message).not.toContain("example.invalid");
  });

  it.each([
    ["no provider", { providers: [] }, /names no provider/u],
    ["no providers field", {}, /names no provider/u],
    ["text that is not JSON", "{not json", /not valid JSON/u],
    [
      "an embedding endpoint elsewhere beside loopback providers",
      { ...config("http://127.0.0.1:4000"), embedding: { baseUrl: "https://api.example.com/v1" } },
      /1 URL\(s\) outside this machine beyond the providers/u,
    ],
    [
      "a URL elsewhere nested in a list",
      { ...config("http://localhost:4000"), tools: [{ endpoints: ["http://10.0.0.5/hook"] }] },
      /URL\(s\) outside this machine/u,
    ],
  ])("refuses a configuration with %s", (_name, value, pattern) => {
    expect(() => assertLoopbackGatewayConfig(write(value))).toThrow(pattern);
  });

  it("accepts other loopback URLs anywhere in the configuration", () => {
    const value = {
      ...config("http://127.0.0.1:4000"),
      embedding: { baseUrl: "http://[::1]:4000/v1" },
      notes: "see http://localhost:1983/docs",
    };
    expect(assertLoopbackGatewayConfig(write(value)).digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses a configuration it cannot read, naming the error code only", () => {
    const error = (() => {
      try {
        assertLoopbackGatewayConfig(join(root, "missing.json"));
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(LabConfigurationError);
    expect(error.message).toBe("the gateway configuration cannot be read (ENOENT)");
  });

  it("is checked again before every instance, so it cannot change half way through a run", () => {
    const file = write(config("http://127.0.0.1:1"));
    const { digest } = assertLoopbackGatewayConfig(file);
    expect(() => assertGatewayConfigUnchanged(file, digest)).not.toThrow();
    // A provider added after the run began would receive the conversations of every later unit.
    write(config("http://127.0.0.1:1", "https://api.example.invalid"));
    expect(() => assertGatewayConfigUnchanged(file, digest)).toThrow(/outside this machine/u);
    // Another local setting is a different measurement, though no less local.
    write({ ...config("http://127.0.0.1:1"), circuitBreaker: { failureThreshold: 9 } });
    expect(() => assertGatewayConfigUnchanged(file, digest)).toThrow(
      /changed while the run was in progress/u,
    );
  });

  it("stops a live run before any instance, any directory and any unit exist", async () => {
    const scenarios = join(root, "scenarios");
    mkdirSync(scenarios);
    writeFileSync(join(scenarios, "isolation-fixture.json"), JSON.stringify(scenario()));
    const options = normalizeOptions({
      mode: "live",
      out: join(root, "out"),
      scenarios,
      config: write(config("http://127.0.0.1:1", "https://api.example.invalid")),
      "answer-model": "model-0",
      "learn-model": "model-0",
    });
    const error = await runLab(options, () => undefined).catch((caught) => caught);
    expect(error).toBeInstanceOf(LabConfigurationError);
    expect(error.message).toContain("outside this machine");
    expect(existsSync(join(root, "out"))).toBe(false);
  });
});

describe("the chat models a gateway configuration names", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-measured-models-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(providers) {
    const file = join(root, "gateway.json");
    writeFileSync(file, JSON.stringify({ providers }));
    return file;
  }

  it("accepts the measured models, one or two, and a provider of another kind", () => {
    const file = write([
      { modelId: "answers", capability: { kind: "chat" } },
      { modelId: "learns", capability: { kind: "chat" } },
      { modelId: "embeds", capability: { kind: "embedding" } },
    ]);
    expect(() => {
      assertOnlyMeasuredChatModels(file, ["answers", "learns"]);
    }).not.toThrow();
    const single = write([{ modelId: "both", capability: { kind: "chat" } }]);
    expect(() => {
      assertOnlyMeasuredChatModels(single, ["both", "both"]);
    }).not.toThrow();
  });

  it.each([
    ["a second chat model", { modelId: "other", capability: { kind: "chat" } }, /other/u],
    ["a provider that states no kind", { modelId: "plain" }, /plain/u],
    ["a provider without a model id", { capability: { kind: "chat" } }, /unnamed/u],
  ])("refuses %s, which the product would check at every start", (_name, extra, pattern) => {
    const file = write([{ modelId: "measured", capability: { kind: "chat" } }, extra]);
    expect(() => {
      assertOnlyMeasuredChatModels(file, ["measured", "measured"]);
    }).toThrow(LabConfigurationError);
    expect(() => {
      assertOnlyMeasuredChatModels(file, ["measured", "measured"]);
    }).toThrow(pattern);
  });
});

describe("real conversation text", () => {
  it("is recognized by the class prefix, and keeps no body whatever the run asked for", () => {
    expect(isAnchorScenario({ class: "anchor-real" })).toBe(true);
    expect(isAnchorScenario({ class: "anchor-benchmark" })).toBe(true);
    expect(isAnchorScenario({ class: "preference" })).toBe(false);
    expect(retainBodiesFor({ class: "anchor-real" }, true)).toBe(false);
    expect(retainBodiesFor({ class: "anchor-benchmark" }, true)).toBe(false);
    expect(retainBodiesFor({ class: "preference" }, true)).toBe(true);
    expect(retainBodiesFor({ class: "preference" }, false)).toBe(false);
    expect(retainBodiesFor({ class: "preference" }, undefined)).toBe(false);
  });

  it("keeps bodies in the labelling pass alone, which a person asks for by name", () => {
    expect(retainBodiesFor({ class: "anchor-real" }, true, true)).toBe(true);
    expect(retainBodiesFor({ class: "anchor-real" }, false, true)).toBe(false);
    expect(retainBodiesFor({ class: "anchor-real" }, true, false)).toBe(false);
    const base = { mode: "offline", out: join(tmpdir(), "memory-lab-isolation-label") };
    expect(normalizeOptions(base).labelPass).toBe(false);
    expect(normalizeOptions({ ...base, "label-pass": true }).labelPass).toBe(true);
    expect(() => normalizeOptions({ ...base, "label-pass": true, "retain-bodies": false })).toThrow(
      /--label-pass keeps bodies/u,
    );
    expect(() =>
      normalizeOptions({
        ...base,
        "label-pass": true,
        holdout: join(tmpdir(), "memory-lab-isolation-h.json"),
        "key-file": join(tmpdir(), "memory-lab-isolation-h.key"),
      }),
    ).toThrow(/--label-pass cannot be combined with --holdout/u);
  });

  it("is never kept in an instance's database: --keep is refused for a real conversation only", () => {
    const real = { class: "anchor-real" };
    expect(() => assertKeepAllowed([{ class: "preference" }, real], true)).toThrow(
      /--keep cannot be combined with real-conversation scenarios/u,
    );
    expect(() => assertKeepAllowed([{ class: "preference" }, real], false)).not.toThrow();
    expect(() => assertKeepAllowed([{ class: "anchor-benchmark" }], true)).not.toThrow();
    expect(() => assertKeepAllowed([{ class: "preference" }], true)).not.toThrow();
  });

  describe("in a run", () => {
    let root;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "memory-lab-isolation-run-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("refuses --keep before any instance starts", async () => {
      const scenarios = join(root, "scenarios");
      mkdirSync(scenarios);
      writeFileSync(
        join(scenarios, "isolation-real.json"),
        JSON.stringify(scenario({ id: "isolation-real", class: "anchor-real" })),
      );
      const options = normalizeOptions({
        mode: "offline",
        out: join(root, "out"),
        scenarios,
        keep: true,
      });
      await expect(runLab(options, () => undefined)).rejects.toThrow(/--keep cannot be combined/u);
      expect(existsSync(join(root, "out"))).toBe(false);
    });
  });
});

describe("paths of a run", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-isolation-paths-"));
    mkdirSync(join(root, "other-checkout", ".git"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const base = { mode: "offline", scenarios: "/nonexistent-scenarios" };

  it("refuses --out inside any git work tree, not only this checkout", () => {
    expect(() =>
      normalizeOptions({ ...base, out: join(root, "other-checkout", "runs", "one") }),
    ).toThrow(/--out must lie outside every git work tree/u);
  });

  it("refuses a holdout and a key file inside a work tree", () => {
    const holdout = join(root, "elsewhere", "holdout.json");
    const key = join(root, "elsewhere", "holdout.key");
    const inside = join(root, "other-checkout", "holdout");
    const out = join(root, "out");
    expect(() =>
      normalizeOptions({ mode: "offline", out, holdout: inside, "key-file": key }),
    ).toThrow(/--holdout must lie outside every git work tree/u);
    expect(() => normalizeOptions({ mode: "offline", out, holdout, "key-file": inside })).toThrow(
      /--key-file must lie outside every git work tree/u,
    );
  });

  it("accepts a path outside every work tree", () => {
    const options = normalizeOptions({ ...base, out: join(root, "runs", "one") });
    expect(options.out.endsWith(join("runs", "one"))).toBe(true);
  });
});

describe("the measured configuration", () => {
  const out = join(tmpdir(), "memory-lab-isolation-defaults");

  it("defaults the memory mode and the ceiling to Full access", () => {
    // The Ask for approval configuration parks every learned fact as proposed, so a run measuring
    // recall on it measures nothing; it is chosen explicitly (#4209).
    const options = normalizeOptions({ mode: "offline", out });
    expect(options.memoryMode).toBe("autonomous-delivery");
    expect(options.ceiling).toBe("autonomous-delivery");
    expect(
      normalizeOptions({
        mode: "offline",
        out,
        "memory-mode": "governed-assist",
        ceiling: "governed-assist",
      }),
    ).toMatchObject({ memoryMode: "governed-assist", ceiling: "governed-assist" });
  });

  it("does not allow a folded environment unless asked", () => {
    expect(normalizeOptions({ mode: "offline", out }).allowFoldedEnv).toBe(false);
    expect(
      normalizeOptions({ mode: "offline", out, "allow-folded-env": true }).allowFoldedEnv,
    ).toBe(true);
  });
});

// A live run against a loopback server: the real product, the scripted model standing in for a local
// gateway, and a gateway configuration file the run has to treat as the one it checked.
describe("a live run", () => {
  const RUN_TIMEOUT_MS = 120_000;
  let root;
  let server;
  beforeEach(async () => {
    if (!existsSync(join(REPO_ROOT, "packages", "keiko-server", "dist", "index.js")))
      throw new Error("a live run needs built packages; run npm run build:packages");
    root = mkdtempSync(join(tmpdir(), "memory-lab-isolation-live-"));
    server = await startScriptedModelServer();
  });
  afterEach(async () => {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  });

  function gatewayFile(extra = {}) {
    const capability = {
      kind: "chat",
      contextWindow: 32768,
      maxOutputTokens: 2048,
      toolCalling: false,
      structuredOutput: false,
      streaming: true,
      supportsImageInput: false,
      supportsDocumentInput: false,
      workflowEligible: false,
      costClass: "low",
      latencyClass: "standard",
      throughputHint: "local",
      preferredUseCases: ["Chat"],
      knownLimitations: [],
    };
    const file = join(root, "gateway.json");
    writeFileSync(
      file,
      JSON.stringify({
        providers: [ANSWERER_MODEL_ID, LEARNER_MODEL_ID].map((modelId) => ({
          modelId,
          baseUrl: server.baseUrl,
          timeoutMs: 60000,
          maxRetries: 0,
          retryBaseDelayMs: 100,
          capability,
        })),
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 1 },
        ...extra,
      }),
    );
    return file;
  }

  function liveOptions(config) {
    const scenarios = join(root, "scenarios");
    mkdirSync(scenarios, { recursive: true });
    for (const id of ["isolation-live-one", "isolation-live-two"])
      writeFileSync(
        join(scenarios, `${id}.json`),
        JSON.stringify(scenario({ id, turns: [{ user: "Guten Tag." }] })),
      );
    return normalizeOptions({
      mode: "live",
      out: join(root, "out"),
      scenarios,
      config,
      "answer-model": ANSWERER_MODEL_ID,
      "learn-model": LEARNER_MODEL_ID,
      arms: "off",
      "quiet-ms": "50",
      "max-wait-ms": "20000",
    });
  }

  it(
    "records the digest of the configuration it checked",
    async () => {
      const config = gatewayFile();
      const summary = await runLab(liveOptions(config), () => undefined);
      expect(summary.failedUnits).toBe(0);
      const manifest = JSON.parse(readFileSync(join(root, "out", "manifest.json"), "utf8"));
      const expected = createHash("sha256").update(readFileSync(config)).digest("hex");
      expect(manifest.metadata).toMatchObject({
        mode: "live",
        configDigest: expected,
        sealed: false,
        allowFoldedEnv: false,
      });
    },
    RUN_TIMEOUT_MS,
  );

  it("refuses a chat model it does not measure before an instance starts", async () => {
    const extra = { modelId: "not-measured", baseUrl: server.baseUrl, timeoutMs: 1000 };
    const config = gatewayFile();
    const parsed = JSON.parse(readFileSync(config, "utf8"));
    writeFileSync(config, JSON.stringify({ ...parsed, providers: [...parsed.providers, extra] }));
    const lines = [];
    const error = await runLab(liveOptions(config), (line) => lines.push(line)).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(LabConfigurationError);
    expect(error.message).toContain("not-measured");
    expect(lines).toEqual([]);
    expect(existsSync(join(root, "out", "manifest.json"))).toBe(false);
  });

  it(
    "ends when the configuration changes between two instances",
    async () => {
      const config = gatewayFile();
      const lines = [];
      const error = await runLab(liveOptions(config), (line) => {
        lines.push(line);
        // After the first unit: the run's configuration gains a setting nobody checked.
        if (lines.length === 1) gatewayFile({ egress: { allowedHosts: ["example.invalid"] } });
      }).catch((caught) => caught);
      expect(error).toBeInstanceOf(LabConfigurationError);
      expect(error.message).toContain("changed while the run was in progress");
      expect(lines).toHaveLength(1);
    },
    RUN_TIMEOUT_MS,
  );
});
