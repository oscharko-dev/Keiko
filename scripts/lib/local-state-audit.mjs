// Deterministic, read-only auditor for a local Keiko `.keiko` runtime-state tree (Issue #1325,
// Epic #1319). It proves, against the implemented local-at-rest contract
// (docs/local-runtime-state-contract.md), that:
//   - the gateway config holds secret REFERENCES, not secret values (no plaintext credentials);
//   - Keiko-owned files and directories carry owner-only POSIX modes (0o600 / 0o700);
//   - the Memory Vault and Local Knowledge stores seal reconstructive content at rest;
//   - Evidence / Quality-Intelligence artifacts are owner-only, redacted, and tamper-evident.
//
// The auditor is intentionally DEPENDENCY-LIGHT: it imports only `node:fs`, `node:path`, and
// `node:sqlite`, so a maintainer can run it against a real `.keiko` directory WITHOUT building the
// workspace. It NEVER mutates the tree (SQLite stores open read-only) and NEVER decrypts content —
// every encryption check is satisfied by the on-disk sealed markers the product itself writes, so
// no vault key is required. The filename constants below are duplicated from
// `packages/keiko-cli/src/state-paths.ts` ON PURPOSE: a script takes no package-graph edge, and
// each constant cites its source of truth so drift stays auditable.

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ── On-disk layout (source of truth: packages/keiko-cli/src/state-paths.ts) ────────────────
const GATEWAY_CONFIG = "keiko.config.json";
const CREDENTIALS_SUBDIR = "credentials";
const PROVIDER_VAULT = "provider-credentials.vault";
const MEMORY_SUBDIR = "memory";
const MEMORY_DB = "keiko-memory.db";
const LOCAL_KNOWLEDGE_SUBDIR = "local-knowledge";
const CAPSULES_DB = "capsules.db";
const EVIDENCE_SUBDIR = "evidence";
const QI_SUBDIR = "qi";
const FIGMA_SUBDIR = "figma";
const FIGMA_VAULT = "figma-token.vault";

// ── Sealed-envelope markers (source of truth: packages/keiko-security/src/secretbox.ts) ─────
const SEALED_STRING_PREFIX = "kv1."; // AES-256-GCM string envelope
const SEALED_BINARY_VERSION = 0x01; // AES-256-GCM binary (BLOB) envelope first byte

// Local Knowledge content-encryption markers (source of truth:
// packages/keiko-local-knowledge/src/store-content-encryption.ts).
const LK_ENC_MARKER_KEY = "content_encryption";
const LK_ENC_MARKER_VALUE = "aes-256-gcm/v1";
const LK_ENC_PROBE_KEY = "content_encryption_probe";

// Secret SHAPES that must never appear in cleartext in a redacted artifact. These mirror the
// shape-based detectors in packages/keiko-security/src/redaction.ts (the source of truth), so the
// audit's leak backstop matches the product's redaction guarantee. Only shape patterns are used —
// key-name/value patterns (e.g. `"token": "x"`) are deliberately excluded because they would also
// match a correctly-redacted `"token": "[REDACTED]"` placeholder and raise false positives. A
// redacted artifact never contains these shapes; their presence means redaction failed.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI-style API key (sk-, sk-proj-, dashes/underscores)
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub PAT / OAuth / user / server tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack token
  /\bAIza[0-9A-Za-z_-]{20,}/, // Google API key
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe secret/restricted key
  /\bfigd_[A-Za-z0-9_-]{16,}/, // Figma personal access token
  /\bBearer\s+[\w.\-+/=]{8,}/, // bearer token
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, // PEM private key block
];

// A regular file is "sensitive" (must be owner-only) when it is a Keiko-owned runtime artifact.
// Anything else under the tree (e.g. an unrelated customer file a maintainer dropped in) is only
// reported as informational, never a failure — the auditor must not punish files it does not own.
const SENSITIVE_FILE_NAMES = new Set([GATEWAY_CONFIG, "ui.pid", "ui.log", "launcher-state.json"]);
const SENSITIVE_TOP_DIRS = new Set([
  CREDENTIALS_SUBDIR,
  MEMORY_SUBDIR,
  LOCAL_KNOWLEDGE_SUBDIR,
  EVIDENCE_SUBDIR,
]);

function isSensitiveFile(relPath, name) {
  if (SENSITIVE_FILE_NAMES.has(name)) return true;
  if (name.endsWith(".vault") || name.endsWith(".key")) return true;
  if (/\.db($|-wal|-shm|\.corrupt\.)/.test(name)) return true;
  return SENSITIVE_TOP_DIRS.has(relPath.split("/")[0]);
}

function looseMode(absPath) {
  // True when any group/other permission bit is set — i.e. not owner-only.
  return (statSync(absPath).mode & 0o077) !== 0;
}

function octal(absPath) {
  return `0o${(statSync(absPath).mode & 0o777).toString(8)}`;
}

function pass(id, title, findings = []) {
  return { id, title, status: "pass", findings };
}
function fail(id, title, findings) {
  return { id, title, status: "fail", findings };
}
function skip(id, title, reason) {
  return { id, title, status: "skip", findings: [reason] };
}

// Opens a SQLite database strictly read-only so the audit never mutates a store or creates a WAL
// sidecar. Returns undefined if the file cannot be opened as a database.
function openReadOnly(dbPath) {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return undefined;
  }
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

// ── Class 1: no plaintext credentials ──────────────────────────────────────────────────────
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// Mirrors keiko-server's hasPlaintextGatewayCredentials: any provider carrying a plaintext apiKey,
// or a figma block carrying a plaintext accessToken, is an unmigrated/leaked credential.
function hasPlaintextCredentials(config) {
  if (typeof config !== "object" || config === null) return false;
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const providerLeak = providers.some(
    (p) =>
      typeof p === "object" && p !== null && typeof p.apiKey === "string" && p.apiKey.length > 0,
  );
  const figma = config.figma;
  const figmaLeak =
    typeof figma === "object" &&
    figma !== null &&
    typeof figma.accessToken === "string" &&
    figma.accessToken.trim().length > 0;
  return providerLeak || figmaLeak;
}

function auditCredentials(stateDir) {
  const id = "credentials";
  const title = "No plaintext credentials";
  const configPath = join(stateDir, GATEWAY_CONFIG);
  if (!existsSync(configPath)) return skip(id, title, "no keiko.config.json present");
  const config = readJsonFile(configPath);
  if (config === undefined) return skip(id, title, "keiko.config.json is not valid JSON");
  const findings = [];
  if (hasPlaintextCredentials(config)) {
    findings.push(
      "keiko.config.json contains a plaintext apiKey/accessToken (must be a secret reference)",
    );
  }
  const refs = (Array.isArray(config.providers) ? config.providers : [])
    .map((p) => (typeof p === "object" && p !== null ? p.apiKeySecretRef : undefined))
    .filter((r) => typeof r === "string" && r.length > 0);
  const vaultPath = join(stateDir, CREDENTIALS_SUBDIR, PROVIDER_VAULT);
  if (refs.length > 0) {
    if (!existsSync(vaultPath)) {
      findings.push(
        `config references ${refs.length} sealed credential(s) but ${CREDENTIALS_SUBDIR}/${PROVIDER_VAULT} is missing`,
      );
    } else if (containsPlaintextVaultEntry(vaultPath)) {
      findings.push(
        "provider credential vault holds an unsealed entry (expected kv1. envelopes only)",
      );
    }
  }
  if (findings.length > 0) return fail(id, title, findings);
  return pass(id, title, [
    refs.length > 0
      ? `config exposes ${refs.length} secret reference(s); credentials are sealed in ${CREDENTIALS_SUBDIR}/${PROVIDER_VAULT}`
      : "config carries no credential material",
  ]);
}

function containsPlaintextVaultEntry(vaultPath) {
  const vault = readJsonFile(vaultPath);
  if (typeof vault !== "object" || vault === null) return false;
  const entries = vault.entries;
  if (typeof entries !== "object" || entries === null) return false;
  return Object.values(entries).some(
    (v) => typeof v === "string" && !v.startsWith(SEALED_STRING_PREFIX),
  );
}

// ── Class 2: private file modes ──────────────────────────────────────────────────────────────
function walk(absDir, relDir, onFile, onDir) {
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name);
    const rel = relDir === "" ? name : `${relDir}/${name}`;
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) continue; // never follow a symlink
    if (stat.isDirectory()) {
      onDir(abs, rel);
      walk(abs, rel, onFile, onDir);
    } else if (stat.isFile()) {
      onFile(abs, rel, name);
    }
  }
}

function auditFileModes(stateDir) {
  const id = "file-modes";
  const title = "Private file and directory modes";
  if (process.platform === "win32") {
    return skip(id, title, "POSIX mode check not applicable on Windows (NTFS ACLs govern access)");
  }
  const failures = [];
  const notes = [];
  if (looseMode(stateDir)) failures.push(`state directory is ${octal(stateDir)} (expected 0o700)`);
  walk(
    stateDir,
    "",
    (abs, rel, name) => {
      if (!looseMode(abs)) return;
      if (isSensitiveFile(rel, name)) failures.push(`${rel} is ${octal(abs)} (expected 0o600)`);
      else notes.push(`${rel} is ${octal(abs)} (non-Keiko file; informational)`);
    },
    (abs, rel) => {
      if (looseMode(abs)) failures.push(`${rel}/ is ${octal(abs)} (expected 0o700)`);
    },
  );
  if (failures.length > 0) return fail(id, title, [...failures, ...notes]);
  return pass(id, title, [
    "all Keiko-owned files and directories are owner-only (0o600 / 0o700)",
    ...notes,
  ]);
}

// ── Class 3: encrypted Memory Vault content ──────────────────────────────────────────────────
function sampleColumnSealed(db, table, column) {
  // Returns { rows, sealed } for a TEXT content column: sealed is true only when EVERY non-null
  // sampled value is a kv1. envelope. An empty table yields rows: 0 (nothing to contradict).
  if (!tableExists(db, table)) return { rows: 0, sealed: true };
  const values = db
    .prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`)
    .all();
  const sealed = values.every(
    (r) => typeof r.v === "string" && r.v.startsWith(SEALED_STRING_PREFIX),
  );
  return { rows: values.length, sealed };
}

function blobColumnSealed(db, table, column) {
  if (!tableExists(db, table)) return { rows: 0, sealed: true };
  const values = db
    .prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`)
    .all();
  const sealed = values.every(
    (r) => r.v != null && r.v.length > 0 && r.v[0] === SEALED_BINARY_VERSION,
  );
  return { rows: values.length, sealed };
}

function auditMemoryEncryption(stateDir) {
  const id = "memory-encryption";
  const title = "Encrypted Memory Vault content";
  const dbPath = join(stateDir, MEMORY_SUBDIR, MEMORY_DB);
  if (!existsSync(dbPath)) return skip(id, title, "no memory vault present");
  const db = openReadOnly(dbPath);
  if (db === undefined) return fail(id, title, ["memory vault is present but could not be opened"]);
  try {
    const findings = [];
    let contentRows = 0;
    for (const column of ["body", "payload_json", "tags_json"]) {
      const { rows, sealed } = sampleColumnSealed(db, "memories", column);
      contentRows += rows;
      if (!sealed)
        findings.push(`memories.${column} contains cleartext content (expected kv1. envelopes)`);
    }
    const vec = blobColumnSealed(db, "memory_embeddings", "vector");
    if (!vec.sealed)
      findings.push(
        "memory_embeddings.vector contains a cleartext embedding (expected a sealed binary envelope)",
      );
    if (findings.length > 0) return fail(id, title, findings);
    if (contentRows === 0 && vec.rows === 0) {
      return skip(id, title, "memory vault present but holds no content rows to verify");
    }
    return pass(id, title, [
      `${contentRows} memory content value(s) and ${vec.rows} embedding(s) are sealed at rest`,
    ]);
  } finally {
    db.close();
  }
}

// ── Class 4: encrypted Local Knowledge content ───────────────────────────────────────────────
function listKnowledgeDbs(stateDir) {
  const root = join(stateDir, LOCAL_KNOWLEDGE_SUBDIR);
  if (!existsSync(root)) return [];
  const dbs = [];
  for (const ns of readdirSync(root)) {
    const candidate = join(root, ns, CAPSULES_DB);
    if (existsSync(candidate) && lstatSync(candidate).isFile()) {
      dbs.push({ namespace: ns, dbPath: candidate });
    }
  }
  return dbs;
}

function readSchemaMeta(db, key) {
  if (!tableExists(db, "schema_meta")) return undefined;
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key);
  return row === undefined ? undefined : row.value;
}

function auditOneKnowledgeStore(namespace, dbPath) {
  const db = openReadOnly(dbPath);
  if (db === undefined) return [`${namespace}: store could not be opened`];
  try {
    const findings = [];
    if (readSchemaMeta(db, LK_ENC_MARKER_KEY) !== LK_ENC_MARKER_VALUE) {
      findings.push(
        `${namespace}: store is not marked encrypted (missing ${LK_ENC_MARKER_KEY}=${LK_ENC_MARKER_VALUE})`,
      );
    }
    const probe = readSchemaMeta(db, LK_ENC_PROBE_KEY);
    if (typeof probe !== "string" || !probe.startsWith(SEALED_STRING_PREFIX)) {
      findings.push(`${namespace}: key-verification probe is missing or not sealed`);
    }
    const text = sampleColumnSealed(db, "document_texts", "normalized_text");
    if (!text.sealed)
      findings.push(`${namespace}: document_texts.normalized_text contains cleartext`);
    const vec = blobColumnSealed(db, "vectors", "embedding");
    if (!vec.sealed) findings.push(`${namespace}: vectors.embedding contains a cleartext vector`);
    return findings;
  } finally {
    db.close();
  }
}

function auditKnowledgeEncryption(stateDir) {
  const id = "local-knowledge-encryption";
  const title = "Encrypted Local Knowledge content";
  const stores = listKnowledgeDbs(stateDir);
  if (stores.length === 0) return skip(id, title, "no Local Knowledge store present");
  const findings = stores.flatMap((s) => auditOneKnowledgeStore(s.namespace, s.dbPath));
  if (findings.length > 0) return fail(id, title, findings);
  return pass(id, title, [
    `${stores.length} Local Knowledge store(s) seal content at rest (marker + sealed key probe verified)`,
  ]);
}

// ── Class 5: protected Evidence / Quality-Intelligence artifacts ──────────────────────────────
function scanForSecrets(path) {
  const text = readFileSync(path, "utf8");
  return SECRET_PATTERNS.some((re) => re.test(text));
}

function collectArtifacts(stateDir) {
  const evidenceDir = join(stateDir, EVIDENCE_SUBDIR);
  const artifacts = { evidence: [], qi: [], candidates: [], figmaVault: undefined };
  if (!existsSync(evidenceDir)) return artifacts;
  for (const name of readdirSync(evidenceDir)) {
    if (name.endsWith(".json") && !name.endsWith(".lock"))
      artifacts.evidence.push(join(evidenceDir, name));
  }
  const qiDir = join(evidenceDir, QI_SUBDIR);
  if (existsSync(qiDir)) {
    for (const name of readdirSync(qiDir)) {
      if (name.endsWith(".qi.json")) artifacts.qi.push(join(qiDir, name));
      else if (name.endsWith(".candidates.json")) artifacts.candidates.push(join(qiDir, name));
    }
  }
  const figmaVault = join(evidenceDir, FIGMA_SUBDIR, FIGMA_VAULT);
  if (existsSync(figmaVault)) artifacts.figmaVault = figmaVault;
  return artifacts;
}

function checkArtifactProtection(stateDir, path, findings) {
  const rel = relative(stateDir, path);
  if (process.platform !== "win32" && looseMode(path)) {
    findings.push(`${rel} is ${octal(path)} (expected 0o600)`);
  }
  if (scanForSecrets(path)) findings.push(`${rel} contains an unredacted secret`);
}

function checkQiTamperEvidence(stateDir, qiPaths, findings) {
  for (const path of qiPaths) {
    const manifest = readJsonFile(path);
    if (manifest === undefined || manifest.integrityHashes === undefined) {
      findings.push(`${relative(stateDir, path)} is missing integrity hashes (not tamper-evident)`);
    }
  }
}

function checkFigmaVault(stateDir, figmaVault, findings) {
  const rel = relative(stateDir, figmaVault);
  if (process.platform !== "win32" && looseMode(figmaVault)) {
    findings.push(`${rel} is ${octal(figmaVault)} (expected 0o600)`);
  }
  if (!readFileSync(figmaVault, "utf8").trim().startsWith(SEALED_STRING_PREFIX)) {
    findings.push(`${rel} is not a sealed Figma token envelope`);
  }
}

function auditEvidence(stateDir) {
  const id = "evidence-qi";
  const title = "Protected Evidence / Quality-Intelligence artifacts";
  const a = collectArtifacts(stateDir);
  const total = a.evidence.length + a.qi.length + a.candidates.length + (a.figmaVault ? 1 : 0);
  if (total === 0) return skip(id, title, "no Evidence / QI artifacts present");
  const findings = [];
  for (const path of [...a.evidence, ...a.qi, ...a.candidates]) {
    checkArtifactProtection(stateDir, path, findings);
  }
  checkQiTamperEvidence(stateDir, a.qi, findings);
  if (a.figmaVault) checkFigmaVault(stateDir, a.figmaVault, findings);
  if (findings.length > 0) return fail(id, title, findings);
  return pass(id, title, [
    `${a.evidence.length} evidence manifest(s), ${a.qi.length} QI manifest(s), ${a.candidates.length} candidate artifact(s)` +
      `${a.figmaVault ? ", 1 sealed Figma token vault" : ""} are owner-only, redacted, and tamper-evident`,
  ]);
}

// Runs every confidentiality-class check over `stateDir`. The overall result is ok unless a class
// fails; a skipped class (an absent store) never fails the audit.
export function auditLocalState(stateDir) {
  if (!existsSync(stateDir) || !lstatSync(stateDir).isDirectory()) {
    return {
      ok: false,
      stateDir,
      classes: [fail("state-directory", "State directory", [`not a directory: ${stateDir}`])],
    };
  }
  const classes = [
    auditCredentials(stateDir),
    auditFileModes(stateDir),
    auditMemoryEncryption(stateDir),
    auditKnowledgeEncryption(stateDir),
    auditEvidence(stateDir),
  ];
  return { ok: classes.every((c) => c.status !== "fail"), stateDir, classes };
}

export const AUDIT_MARKERS = Object.freeze({
  SEALED_STRING_PREFIX,
  SEALED_BINARY_VERSION,
  LK_ENC_MARKER_KEY,
  LK_ENC_MARKER_VALUE,
});
