// Generates a representative, GENUINELY-ENCRYPTED `.keiko` runtime-state fixture for the local-state
// audit (Issue #1325, Epic #1319). Unlike the auditor, this module imports the BUILT workspace
// packages so the encryption, sealing, and hardening it produces are the real product code paths —
// the fixture cannot drift from the implementation. It is used by `check-local-state.mjs --self-test`
// and by the regression test under `scripts/__tests__/`. It writes only into a caller-provided temp
// directory and never touches a real `.keiko`.
//
// A script takes no package-graph edge, so importing these specifiers here does not widen any
// package's dependency surface (verified against scripts/check-package-graph.mjs, which inspects
// packages/*/package.json only).

import { Buffer } from "node:buffer";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createMemoryVault } from "@oscharko-dev/keiko-memory-vault";
import { openKnowledgeStore, resolveKnowledgeStorePath } from "@oscharko-dev/keiko-local-knowledge";
import {
  createNodeEvidenceStore,
  recordQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import { openProviderCredentialVault } from "@oscharko-dev/keiko-server/credential-vault";
import { sealString } from "@oscharko-dev/keiko-security";

// A fixed 32-byte key keeps the fixture reproducible without touching an OS keychain or writing a
// keyfile. It is the strongest (operator-injected) key tier; every store below is sealed with it.
const FIXTURE_KEY = Buffer.alloc(32, 7);
const FIXTURE_KEY_B64 = FIXTURE_KEY.toString("base64");
const FIXTURE_TS = 1_700_000_000_000;

function seedMemoryVault(stateDir) {
  const vault = createMemoryVault({
    memoryDir: join(stateDir, "memory"),
    env: { KEIKO_MEMORY_DIR: join(stateDir, "memory") },
    vaultKey: FIXTURE_KEY,
    now: () => FIXTURE_TS,
  });
  try {
    vault.insertMemory({
      id: "m-fixture-1",
      schemaVersion: "1",
      scope: { kind: "user", userId: "u-fixture" },
      type: "preference",
      body: "STRENG-VERTRAULICH regulated customer memory body",
      payload: { kind: "string-list", items: ["confidential-item"] },
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: FIXTURE_TS,
        confidence: 0.9,
        sensitivity: "confidential",
        captureRationale: "fixture",
      },
      validity: { validFrom: FIXTURE_TS },
      status: "accepted",
      pinned: false,
      tags: ["fixture"],
      createdAt: FIXTURE_TS,
      updatedAt: FIXTURE_TS,
    });
    vault.upsertEmbedding("m-fixture-1", {
      provider: "openai",
      modelId: "text-embedding-3-small",
      metric: "cosine",
      vector: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    });
  } finally {
    vault.close();
  }
}

function seedKnowledgeStore(stateDir) {
  const dbPath = resolveKnowledgeStorePath({
    runtimeStateDir: stateDir,
    namespace: "default",
  });
  // Opening with an encrypted key provider writes the `content_encryption=aes-256-gcm/v1` marker and
  // a sealed key-verification probe at rest; from this point every content column is sealed on write
  // and reads fail closed without the key (ADR-0047). The healthy fixture deliberately seeds NO
  // content rows here: the public Local Knowledge ingest path requires the model-gateway embeddings
  // adapter, and the row-layer seal helpers are package-internal. The fixture therefore demonstrates
  // encryption-at-open (marker + sealed probe). The auditor's content-row sealing branch is exercised
  // directly by crafted-DB negative tests in scripts/__tests__/check-local-state.test.mjs, and the
  // real content seal/round-trip is covered by the keiko-local-knowledge suite (#1322/#1364).
  const store = openKnowledgeStore({
    dbPath,
    protection: {
      mode: "encrypted-key-provider",
      keyProvider: {
        providerId: "fixture-local-knowledge",
        resolveKey: () => new Uint8Array(FIXTURE_KEY),
      },
    },
  });
  store.close();
}

function seedCredentialVault(stateDir) {
  const configPath = join(stateDir, "keiko.config.json");
  const config = {
    providers: [
      {
        modelId: "fixture-model",
        baseUrl: "https://provider.example/v1",
        apiKeySecretRef: "cred:fixture-model",
      },
    ],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const vault = openProviderCredentialVault({
    configPath,
    env: { KEIKO_PROVIDER_CREDENTIALS_KEY: FIXTURE_KEY_B64 },
  });
  // A non-provider-shaped placeholder: the vault seals whatever value it is given, so the fixture
  // does not need (and must not commit) a real provider-key shape.
  vault.set("cred:fixture-model", "fixture-credential-value-not-a-real-secret");
  return configPath;
}

function seedEvidence(stateDir) {
  const evidenceDir = join(stateDir, "evidence");
  const store = createNodeEvidenceStore(evidenceDir);
  const manifest = {
    evidenceSchemaVersion: "1",
    run: {
      runId: "fixture-evidence-001",
      taskType: "unit-test-generation",
      outcome: "succeeded",
      startedAt: FIXTURE_TS,
      finishedAt: FIXTURE_TS + 1000,
    },
    model: { modelId: "fixture-model", costClass: "standard" },
    summary: "redacted workflow summary for the local-state verification fixture",
  };
  store.put(manifest.run.runId, `${JSON.stringify(manifest, null, 2)}\n`);
}

function seedQualityIntelligence(stateDir) {
  recordQualityIntelligenceRun(
    {
      runId: "fixture-qi-001",
      planAt: "2026-06-21T10:00:00.000Z",
      completedAt: "2026-06-21T10:05:00.000Z",
      status: "succeeded",
      policyProfileIds: ["qi:short-30d"],
      retentionPolicyId: "qi:short-30d",
      modelGatewayCallCount: 1,
      totals: { candidates: 0, findings: 0, exports: 0 },
      findings: [],
      exports: [],
      evidenceRefs: [],
      provenanceRefs: { envelopeIds: [], auditSummaryId: "audit-fixture-1" },
    },
    { evidenceDir: join(stateDir, "evidence") },
  );
}

function seedFigmaTokenVault(stateDir) {
  // The Figma PAT vault is a single sealed-string file (figmaTokenStore.ts writes `sealString(key,
  // token)` at mode 0o600); reproduced here with the shared secretbox primitive.
  const dir = join(stateDir, "evidence", "figma");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "figma-token.vault"),
    sealString(FIXTURE_KEY, "fixture-figma-token-placeholder"),
    { mode: 0o600 },
  );
}

// Normalizes every directory to 0o700 and every file to 0o600 — the owner-only end state the
// contract guarantees via write-time chmod and `keiko repair`. Applying it deterministically makes
// the healthy fixture independent of any per-store chmod timing or the host umask.
function applyOwnerOnlyModes(dir) {
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) applyOwnerOnlyModes(abs);
    else if (stat.isFile()) chmodSync(abs, 0o600);
  }
}

// Builds a healthy, contract-compliant `.keiko` tree at `stateDir` (which must already exist).
export function createHealthyFixture(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  seedMemoryVault(stateDir);
  seedKnowledgeStore(stateDir);
  seedCredentialVault(stateDir);
  seedEvidence(stateDir);
  seedQualityIntelligence(stateDir);
  seedFigmaTokenVault(stateDir);
  if (process.platform !== "win32") applyOwnerOnlyModes(stateDir);
  return stateDir;
}

// Builds a deliberately drifted `.keiko` tree: a sensitive store file is left group/world-readable
// and the gateway config carries a leaked plaintext credential. Both are exactly what the auditor
// and `keiko repair` must flag.
export function createDriftedFixture(stateDir) {
  createHealthyFixture(stateDir);
  const configPath = join(stateDir, "keiko.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.providers.push({
    modelId: "leaked-model",
    apiKey: "PLAINTEXT-CREDENTIAL-PLACEHOLDER-not-sealed",
  });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(
      resolveKnowledgeStorePath({ runtimeStateDir: stateDir, namespace: "default" }),
      0o644,
    );
  }
  return stateDir;
}
