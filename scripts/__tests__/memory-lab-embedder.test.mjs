// With or without an embedding model (#4207): the run option, the configuration the instances get,
// the scripted offline embedder, and the refusal to compare runs that differ in it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { provenanceDifferences } from "../testing/memory-lab/compare.mjs";
import {
  embeddingModelIds,
  loadSubjectGateway,
  resolveEmbedder,
  scriptedEmbedderProvider,
  withoutEmbedders,
} from "../testing/memory-lab/embedder.mjs";
import { startLabInstance } from "../testing/memory-lab/instance.mjs";
import { normalizeOptions } from "../testing/memory-lab/run.mjs";
import {
  EMBEDDER_MODEL_ID,
  hashedEmbedding,
  startScriptedModelServer,
} from "../testing/memory-lab/scripted-model.mjs";

function capability(kind) {
  return {
    kind,
    contextWindow: 8192,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "fixture",
    preferredUseCases: [],
    knownLimitations: [],
  };
}

const LIVE_CONFIG = {
  providers: [
    { modelId: "chat-a", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" },
    {
      modelId: "embed-a",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "k",
      capability: capability("embedding"),
    },
    { modelId: "embed-b", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" },
  ],
  capabilities: [{ id: "embed-b", ...capability("embedding") }],
};

let gateway;
beforeAll(async () => {
  gateway = await loadSubjectGateway(undefined);
});

const BASE = "http://127.0.0.1:9/v1";
// A provider entry with only `modelId` and `baseUrl`: the product still knows an embedder by the shape
// of its id, which a reader of the raw file does not.
const BARE_CONFIG = {
  providers: [
    { modelId: "gemma-chat", baseUrl: BASE, apiKey: "k" },
    { modelId: "qwen3-embedding-8b", baseUrl: BASE, apiKey: "k" },
  ],
};

describe("the configuration with and without an embedding model", () => {
  it("finds the embedding providers declared inline or in the capability list, sorted", () => {
    expect(embeddingModelIds(LIVE_CONFIG, gateway)).toEqual(["embed-a", "embed-b"]);
    expect(
      embeddingModelIds({ providers: [{ modelId: "chat-a", baseUrl: BASE }] }, gateway),
    ).toEqual([]);
  });

  it("removes every embedding provider and capability record and nothing else", () => {
    const stripped = withoutEmbedders(LIVE_CONFIG, gateway);
    expect(stripped.providers.map((provider) => provider.modelId)).toEqual(["chat-a"]);
    expect(stripped.capabilities).toEqual([]);
    expect(embeddingModelIds(stripped, gateway)).toEqual([]);
  });

  it("finds an embedder the product knows by its model id, and removes it", () => {
    // The failure this pins: the lab saw only a declared capability, so `--no-embedder` left this
    // provider in while the manifest said `none`.
    expect(embeddingModelIds(BARE_CONFIG, gateway)).toEqual(["qwen3-embedding-8b"]);
    const stripped = withoutEmbedders(BARE_CONFIG, gateway);
    expect(stripped.providers.map((provider) => provider.modelId)).toEqual(["gemma-chat"]);
    expect(embeddingModelIds(stripped, gateway)).toEqual([]);
  });

  // A configuration saved before KEIKO-0520 carries a chat capability with `contextWindow: 0`. The
  // product loads it after its file-load migration; the lab classifies what the product loads.
  it("classifies a legacy configuration the product loads after migration", () => {
    const legacy = {
      providers: [
        {
          modelId: "chat-a",
          baseUrl: BASE,
          apiKey: "k",
          capability: { ...capability("chat"), contextWindow: 0 },
        },
        { modelId: "qwen3-embedding-8b", baseUrl: BASE, apiKey: "k" },
      ],
    };
    expect(embeddingModelIds(legacy, gateway)).toEqual(["qwen3-embedding-8b"]);
    expect(embeddingModelIds(withoutEmbedders(legacy, gateway), gateway)).toEqual([]);
    expect(() => embeddingModelIds({ ...legacy, schemaVersion: 2 }, gateway)).toThrow(
      /contextWindow/u,
    );
  });

  it("fails closed when the product still resolves an embedder after the removal", () => {
    // A gateway whose resolver finds an embedder in whatever it is given: the removal cannot be
    // verified, so it throws instead of returning a configuration labelled without one.
    const stubborn = {
      parseGatewayConfig: (config) => config,
      listConfiguredCapabilities: () => [{ id: "sticky", kind: "embedding" }],
    };
    expect(() => withoutEmbedders(BARE_CONFIG, stubborn)).toThrow(/still resolves 1 embedding/u);
  });

  it("refuses a configuration the product would not accept, instead of classifying it", () => {
    expect(() => embeddingModelIds({ providers: [] }, gateway)).toThrow();
  });

  it("resolves the kind of embedding a run measures", () => {
    expect(resolveEmbedder({ mode: "offline", embedder: "default" })).toBe("none");
    expect(resolveEmbedder({ mode: "offline", embedder: "on" })).toBe("scripted");
    expect(resolveEmbedder({ mode: "offline", embedder: "off" })).toBe("none");
    const configuredIds = ["embed-a"];
    expect(resolveEmbedder({ mode: "live", embedder: "default", configuredIds })).toBe(
      "configured",
    );
    expect(resolveEmbedder({ mode: "live", embedder: "off", configuredIds })).toBe("none");
    expect(resolveEmbedder({ mode: "live", embedder: "default" })).toBe("none");
    expect(() => resolveEmbedder({ mode: "live", embedder: "on" })).toThrow(
      /needs an embedding provider/u,
    );
  });

  it("parses --embedder and --no-embedder into the run's request", () => {
    const base = { mode: "offline", out: join(tmpdir(), "memory-lab-embedder-out") };
    expect(normalizeOptions(base).embedderMode).toBe("default");
    expect(normalizeOptions({ ...base, embedder: true }).embedderMode).toBe("on");
    expect(normalizeOptions({ ...base, embedder: false }).embedderMode).toBe("off");
  });
});

// Starts a scripted server, runs the body, and always closes the server, whatever the body does.
async function withScriptedServer(options, body) {
  const server = await startScriptedModelServer(options);
  try {
    return await body(server);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("the scripted embedding model fixture", () => {
  it("closes its server when the body throws, so a failed assertion leaks no listener", async () => {
    let started;
    await expect(
      withScriptedServer({}, async (server) => {
        started = server;
        expect((await globalThis.fetch(`${server.baseUrl}/models`)).status).toBe(200);
        throw new Error("assertion failed inside the body");
      }),
    ).rejects.toThrow("assertion failed");
    await expect(globalThis.fetch(`${started.baseUrl}/models`)).rejects.toThrow();
  });
});

describe("the scripted embedding model", () => {
  const cosine = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

  it("embeds a text as a unit-length hashed bag of its words, the same every time", () => {
    const vector = hashedEmbedding("The planning meeting is on Tuesday");
    expect(vector).toHaveLength(256);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
    expect(hashedEmbedding("The planning meeting is on Tuesday")).toEqual(vector);
    expect(Math.hypot(...hashedEmbedding(""))).toBeCloseTo(1, 10);
  });

  it("puts texts that share words closer than texts that share none", () => {
    const query = hashedEmbedding("Where is the planning meeting");
    expect(cosine(query, hashedEmbedding("The planning meeting is in room Birch"))).toBeGreaterThan(
      0.5,
    );
    expect(cosine(query, hashedEmbedding("Ablage 0001 zorlek gehoert zu vimtra"))).toBeLessThan(
      0.2,
    );
  });

  it("serves /v1/embeddings in the OpenAI shape only when asked to, and counts the calls", async () => {
    await withScriptedServer({}, async (without) => {
      const response = await globalThis.fetch(`${without.baseUrl}/embeddings`, {
        method: "POST",
        body: JSON.stringify({ model: EMBEDDER_MODEL_ID, input: "x" }),
      });
      expect(response.status).toBe(404);
    });
    const server = await startScriptedModelServer({ embedder: true });
    try {
      const served = await globalThis.fetch(`${server.baseUrl}/embeddings`, {
        method: "POST",
        body: JSON.stringify({ model: EMBEDDER_MODEL_ID, input: ["a b", "c d"] }),
      });
      const body = await served.json();
      expect(body.data.map((entry) => entry.index)).toEqual([0, 1]);
      expect(body.data[0].embedding).toEqual(hashedEmbedding("a b"));
      expect(server.embeddingCalls()).toBe(1);
      const models = await (await globalThis.fetch(`${server.baseUrl}/models`)).json();
      expect(models.data.map((entry) => entry.id)).toContain(EMBEDDER_MODEL_ID);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("is a provider entry the gateway configuration schema accepts", () => {
    const provider = scriptedEmbedderProvider("http://127.0.0.1:1/v1");
    expect(provider.capability.kind).toBe("embedding");
    expect(provider.modelId).toBe(EMBEDDER_MODEL_ID);
  });
});

describe("the private configuration a live instance gets", () => {
  let dir;
  let configPath;
  const bytes = JSON.stringify(LIVE_CONFIG);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-lab-embedder-instance-"));
    mkdirSync(join(dir, "project"), { recursive: true });
    configPath = join(dir, "operator.json");
    writeFileSync(configPath, bytes);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The instance cannot start (there is no product at the subject root); what is asserted is the
  // private copy it wrote before it failed.
  async function privateCopy(embedder) {
    const instanceDir = join(dir, embedder);
    mkdirSync(join(instanceDir, "project"), { recursive: true });
    await startLabInstance({
      dir: instanceDir,
      ceiling: "autonomous-delivery",
      subjectRoot: dir,
      configPath,
      answerModelId: "chat-a",
      learnModelId: "chat-a",
      embedder,
      gateway,
    }).catch(() => undefined);
    return readFileSync(join(instanceDir, "gateway.json"), "utf8");
  }

  it("drops an embedder that only the product's resolver recognises, and labels nothing it did not remove", async () => {
    writeFileSync(configPath, JSON.stringify(BARE_CONFIG));
    const without = JSON.parse(await privateCopy("none"));
    expect(without.providers.map((provider) => provider.modelId)).toEqual(["gemma-chat"]);
  });

  it("keeps the operator's bytes with the embedding model and drops it without", async () => {
    expect(await privateCopy("configured")).toBe(bytes);
    const without = JSON.parse(await privateCopy("none"));
    expect(embeddingModelIds(without, gateway)).toEqual([]);
    expect(without.providers.map((provider) => provider.modelId)).toEqual(["chat-a"]);
    expect(readFileSync(configPath, "utf8")).toBe(bytes);
  });
});

describe("comparing runs that differ in the embedding model", () => {
  const run = (metadata) => ({ manifest: { metadata } });

  it("refuses the pair: the embedder and its model ids are provenance", () => {
    const none = run({ embedder: "none", embeddingModelIds: [] });
    const scripted = run({ embedder: "scripted", embeddingModelIds: [EMBEDDER_MODEL_ID] });
    expect(provenanceDifferences(none, none)).toEqual([]);
    expect(provenanceDifferences(none, scripted)).toEqual(["embedder", "embeddingModelIds"]);
    expect(
      provenanceDifferences(
        run({ embedder: "configured", embeddingModelIds: ["a"] }),
        run({ embedder: "configured", embeddingModelIds: ["b"] }),
      ),
    ).toEqual(["embeddingModelIds"]);
  });

  it("treats a run that never recorded its embedder as unrecorded, equal only to another such run", () => {
    const old = run({});
    expect(provenanceDifferences(old, run({}))).toEqual([]);
    expect(provenanceDifferences(old, run({ embedder: "none", embeddingModelIds: [] }))).toEqual([
      "embedder",
      "embeddingModelIds",
    ]);
  });
});
