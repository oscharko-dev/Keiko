// What a scenario's `seed` section does to an instance's vault before the server starts (#4207): the
// part that touches a file. Like `capacity-window.mjs`, it opens the subject's BUILT vault package
// with the instance's own memory directory and vault key, inserts the planned records with their
// backdated timestamps, and closes it again, so the server that starts next opens an ordinary
// store. It is setup: everything the lab measures afterwards still goes through the public routes.
//
// A seeded record was not learned by the product. Its embedding, when the run has an embedding
// model, is requested through the product's own built embedder (the path that embeds a record at
// capture), so retrieval finds it the way it finds a learned one.
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../coding-workbench-lab/lab-common.mjs";
import { mapSequential } from "./corpus/sequence.mjs";
import { describePlan, planSeed } from "./seed-plan.mjs";

const SILENT_LOG = Object.freeze({ write: () => undefined });

async function builtModules(subjectRoot) {
  const built = (pkg, name) =>
    import(pathToFileURL(join(subjectRoot ?? REPO_ROOT, "packages", pkg, "dist", name)).href);
  const [vault, gateway, embedding, adapter] = await Promise.all([
    built("keiko-memory-vault", "index.js"),
    built("keiko-model-gateway", "config.js"),
    built("keiko-server", "memory-embedding.js"),
    built("keiko-model-gateway", "openai-embedding-adapter.js"),
  ]);
  return {
    createMemoryVault: vault.createMemoryVault,
    loadConfigFromFile: gateway.loadConfigFromFile,
    createMemoryEmbedder: embedding.createMemoryEmbedder,
    requestOpenAIEmbedding: adapter.requestOpenAIEmbedding,
  };
}

function insertAll(vault, plan) {
  for (const record of plan.records) vault.insertMemory(record);
  for (const edge of plan.edges) vault.insertEdge(edge);
  for (const { id, count, lastAccessedAt } of plan.access)
    for (let touch = 0; touch < count; touch += 1) vault.recordAccess([id], lastAccessedAt);
}

// Only an accepted record can be recalled, so only an accepted record is embedded.
async function embedAccepted(vault, plan, embed) {
  const accepted = plan.records.filter((record) => record.status === "accepted");
  const results = await mapSequential(accepted, async (record) => {
    const input = await embed(record.body, "document");
    if (input === null) return false;
    vault.upsertEmbedding(record.id, input);
    return true;
  });
  const embedded = results.filter(Boolean).length;
  if (embedded !== accepted.length)
    throw new Error(
      `seeding could not embed ${String(accepted.length - embedded)} of ${String(accepted.length)} accepted records`,
    );
  return embedded;
}

/**
 * Places a planned seed in the vault at `memoryDir`, encrypted with `vaultKey` exactly as the server
 * will open it. With `embedding` (`{configPath, env}`: the instance's gateway configuration and the
 * environment its server reads) the accepted records are embedded through the configured embedding
 * model, and a record that cannot be embedded fails the seeding. Returns what was done, as counts.
 */
export async function seedVault({ subjectRoot, memoryDir, vaultKey, plan, embedding }) {
  const product = await builtModules(subjectRoot);
  const embed =
    embedding === undefined
      ? null
      : product.createMemoryEmbedder(
          product.loadConfigFromFile(embedding.configPath, embedding.env),
          product.requestOpenAIEmbedding,
          SILENT_LOG,
        );
  if (embedding !== undefined && embed === null)
    throw new Error(
      "the seeding asked for embeddings but the configuration has no embedding model",
    );
  const vault = product.createMemoryVault({
    memoryDir,
    env: { KEIKO_MEMORY_DIR: memoryDir },
    vaultKey,
  });
  try {
    insertAll(vault, plan);
    const embedded = embed === null ? 0 : await embedAccepted(vault, plan, embed);
    return { inserted: plan.records.length, embedded };
  } finally {
    vault.close();
  }
}

// Seeded memory id -> the truth or replaced value the seed says it states, for the scorer.
function linksOf(entries) {
  return new Map(
    entries
      .filter((entry) => entry.truth !== undefined || entry.earlier !== undefined)
      .map((entry) => [entry.id, { truth: entry.truth, earlier: entry.earlier }]),
  );
}

/**
 * Plans a scenario's seed for an instance and places it in the instance's vault. `project` is the
 * instance's registered project path (the scope id its Chats read), `memoryKey` the base64 vault key
 * its server will be given. Returns what the driver needs: the ids of the lab's own records, their
 * links to the truth, and a body-free report.
 */
export async function placeSeed({ seed, subjectRoot, memoryDir, memoryKey, project, embedding }) {
  const plan = planSeed(seed, { nowMs: Date.now(), projectId: project });
  const placed = await seedVault({
    subjectRoot,
    memoryDir,
    vaultKey: Buffer.from(memoryKey, "base64"),
    plan,
    embedding,
  });
  return {
    ids: plan.entries.map((entry) => entry.id),
    entries: plan.entries,
    links: linksOf(plan.entries),
    report: { ...describePlan(plan), embedded: placed.embedded },
  };
}
