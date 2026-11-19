// A separate preregistered retrieval qualification. The subject supplies every product module,
// including the Chat path, Vault and gateway adapter. Only synthetic IDs are represented in results.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, URL } from "node:url";

import { productDistDigest } from "./instrument.mjs";

const MANIFEST = new URL("./controls/capacity-window/manifest.json", import.meta.url);
const MANIFEST_DIGEST = "a9c026166d321bf86303f298d35c541bfc626afd8bbf14f379077c84e48620f7";
const QWEN = "qwen3-embedding-8b";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CONTEXT = {
  userId: "capacity-owner",
  workspaceId: "capacity-workspace",
  projectId: "capacity-project",
  conversationId: "capacity-chat",
};

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function localEmbeddingConfig(config) {
  const providers = config.providers.filter((provider) => provider.modelId === QWEN);
  assert.equal(providers.length, 1, "Expected one configured Qwen3-Embedding 8B provider");
  assert.ok(
    LOCAL_HOSTS.has(new URL(providers[0].baseUrl).hostname),
    "Expected a loopback endpoint",
  );
  return { ...config, providers };
}

function qualificationRecord(id, body, status, updatedAt, validFrom) {
  return {
    id,
    schemaVersion: "1",
    scope: { kind: "project", projectId: CONTEXT.projectId },
    body,
    status,
    type: "semantic-fact",
    pinned: false,
    tags: [],
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: updatedAt,
      confidence: 1,
      sensitivity: "public",
    },
    validity: { validFrom },
    createdAt: updatedAt,
    updatedAt,
  };
}

async function populate(vault, manifest, condition, embed, now) {
  const at = now - 120_000;
  const target = manifest.target;
  vault.insertMemory(qualificationRecord(target.id, target.body, target.status, at, at));
  const document = await embed(target.body, "document");
  assert.ok(document, "Document embedding unavailable");
  vault.upsertEmbedding(target.id, document);
  for (let i = 0; i < condition.distractors; i++) {
    const stamp = at + i + 1;
    const id = "capacity-background-" + String(i).padStart(4, "0");
    const validFrom = condition.futureDays ? now + condition.futureDays * 86_400_000 : stamp;
    vault.insertMemory(
      qualificationRecord(id, manifest.distractor.body, condition.status, stamp, validFrom),
    );
  }
}

function measuredAdapter(adapter) {
  let requests = 0;
  const invoke = async (request) => {
    requests += 1;
    const result = await adapter(request);
    assert.ok(result.ok, "Local embedding request failed");
    assert.equal(result.value.modelId, QWEN);
    assert.equal(result.value.vector.length, 4096);
    return result;
  };
  return { invoke, count: () => requests };
}

function scoreProbe(ids, probe) {
  assert.equal(new Set(ids).size, ids.length);
  const wanted = new Set(probe.expectedIds);
  const matchedIdDigests = ids
    .filter((id) => wanted.has(id))
    .map(digest)
    .toSorted();
  const unexpectedIdDigests = ids
    .filter((id) => !wanted.has(id))
    .map(digest)
    .toSorted();
  return {
    matched: matchedIdDigests.length,
    expected: wanted.size,
    unexpected: unexpectedIdDigests.length,
    unexpectedIdDigests,
    matchedIdDigests,
    idSetSha256: digest(JSON.stringify(ids.toSorted())),
  };
}

async function runRepetition(product, manifest, condition, repetition) {
  const dir = mkdtempSync(join(tmpdir(), "keiko-capacity-"));
  let vault;
  try {
    vault = product.createMemoryVault({
      memoryDir: dir,
      env: { KEIKO_MEMORY_DIR: dir },
      vaultKey: randomBytes(32),
    });
    await populate(vault, manifest, condition, product.embedDocument, Date.now());
    const deps = {
      env: { KEIKO_MEMORY_AUTO_MAINTAIN: "0" },
      config: product.config,
      configPresent: true,
      memoryVault: vault,
      localKnowledgeEmbeddingRequest: product.adapter.invoke,
    };
    return await Array.fromAsync(manifest.probes, async (probe) => {
      const start = product.adapter.count();
      const request = {
        content: probe.query,
        memory: { enabled: true, budgetTokens: manifest.budgetTokens, context: {} },
      };
      const result = await product.buildMemoryResult(request, deps, CONTEXT);
      assert.equal(result.context.enabled, true);
      assert.equal(result.context.profile?.entries.length ?? 0, 0);
      const ids = result.context.memories.map((entry) => entry.memoryId);
      return {
        condition: condition.id,
        repetition,
        probe: probe.id,
        queryCalls: product.adapter.count() - start,
        ...scoreProbe(ids, probe),
      };
    });
  } finally {
    vault?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function loadProduct(subject, gatewayPath, testAdapter) {
  const built = (pkg, name) =>
    import(pathToFileURL(join(subject, "packages", pkg, "dist", name)).href);
  const [
    { buildMemoryResult },
    { createMemoryEmbedder },
    { requestOpenAIEmbedding },
    { parseGatewayConfig },
    { createMemoryVault },
  ] = await Promise.all([
    built("keiko-server", "chat-handlers.js"),
    built("keiko-server", "memory-embedding.js"),
    built("keiko-model-gateway", "openai-embedding-adapter.js"),
    built("keiko-model-gateway", "config.js"),
    built("keiko-memory-vault", "index.js"),
  ]);
  const config = localEmbeddingConfig(
    parseGatewayConfig(JSON.parse(readFileSync(gatewayPath, "utf8"))),
  );
  const adapter = measuredAdapter(testAdapter ?? requestOpenAIEmbedding);
  const embedDocument = createMemoryEmbedder(config, adapter.invoke, { write: () => undefined });
  assert.ok(embedDocument);
  return { config, adapter, embedDocument, buildMemoryResult, createMemoryVault };
}

export async function qualifyCapacity({ subject, head, gatewayPath, testAdapter }) {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const manifestSha256 = digest(JSON.stringify(manifest, null, 2) + "\n");
  assert.equal(manifestSha256, MANIFEST_DIGEST);
  const git = (...args) => execFileSync("git", args, { cwd: subject, encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(
    git("status", "--porcelain", "--untracked-files=no"),
    "",
    "Expected a clean product subject",
  );
  const productSha256 = productDistDigest(subject);
  assert.match(productSha256, /^[a-f0-9]{64}$/u);
  const product = await loadProduct(subject, gatewayPath, testAdapter);
  const schedule = manifest.conditions.flatMap((condition) =>
    Array.from({ length: manifest.repetitions }, (_, repetition) => ({ condition, repetition })),
  );
  const results = await Array.fromAsync(schedule, ({ condition, repetition }) =>
    runRepetition(product, manifest, condition, repetition),
  );
  assert.equal(productDistDigest(subject), productSha256);
  return {
    manifestSha256,
    productSha256,
    pinnedHead: head,
    measurement: testAdapter ? "injected-smoke" : "local-model",
    model: QWEN,
    dimensions: [4096],
    requests: product.adapter.count(),
    rows: results.flat(),
  };
}

if (import.meta.main) {
  const [subject, head, gatewayPath, output] = process.argv.slice(2);
  if (!output) throw new TypeError("Expected SUBJECT CHECKOUT_SHA GATEWAY_CONFIG OUTPUT_JSON");
  const result = await qualifyCapacity({ subject, head, gatewayPath });
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(
    `Capacity qualification complete: ${result.rows.length} probes, ${result.requests} local model requests.`,
  );
}
