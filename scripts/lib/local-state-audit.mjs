// Deterministic, read-only auditor for a local Keiko `.keiko` runtime-state tree (Issue #1325,
// Epic #1319). It proves, against the implemented local-at-rest contract
// (docs/local-runtime-state-contract.md), that:
//   - the gateway config holds secret REFERENCES, not secret values (no plaintext credentials);
//   - Keiko-owned files and directories carry owner-only POSIX modes (0o600 / 0o700);
//   - the Memory Vault and Local Knowledge stores seal reconstructive content at rest;
//   - Evidence / Quality-Intelligence artifacts are owner-only, redacted, and integrity-checked
//     where this dependency-light auditor can recompute the product hash.
//
// The auditor is intentionally DEPENDENCY-LIGHT: it imports only Node built-ins, so a maintainer can
// run it against a real `.keiko` directory WITHOUT building the workspace. It NEVER mutates the tree
// (SQLite stores open read-only) and NEVER decrypts content — every encryption check is satisfied by
// the on-disk sealed markers the product itself writes, so no vault key is required. The filename
// constants below are duplicated from
// `packages/keiko-cli/src/state-paths.ts` ON PURPOSE: a script takes no package-graph edge, and
// each constant cites its source of truth so drift stays auditable.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ── On-disk layout (source of truth: packages/keiko-cli/src/state-paths.ts) ────────────────
const GATEWAY_CONFIG = "keiko.config.json";
const CREDENTIALS_SUBDIR = "credentials";
const PROVIDER_VAULT = "provider-credentials.vault";
const PROVIDER_VAULT_VERSION = 1;
const PROVIDER_SECRET_REF_PREFIX = "cred:";
const MEMORY_SUBDIR = "memory";
const MEMORY_DB = "keiko-memory.db";
const LOCAL_KNOWLEDGE_SUBDIR = "local-knowledge";
const CAPSULES_DB = "capsules.db";
const EVIDENCE_SUBDIR = "evidence";
const QI_SUBDIR = "qi";
const FIGMA_SUBDIR = "figma";
const FIGMA_VAULT = "figma-token.vault";
const PE_SUBDIR = "pe";
const FIGMA_SNAPSHOT_SUBDIR = "figma-snapshots";

// ── Sealed-envelope markers (source of truth: packages/keiko-security/src/secretbox.ts) ─────
const SEALED_STRING_PREFIX = "kv1."; // AES-256-GCM string envelope
const SEALED_BINARY_VERSION = 0x01; // AES-256-GCM binary (BLOB) envelope first byte

// Local Knowledge content-encryption markers (source of truth:
// packages/keiko-local-knowledge/src/store-content-encryption.ts).
const LK_ENC_MARKER_KEY = "content_encryption";
const LK_ENC_MARKER_VALUE = "aes-256-gcm/v1";
const LK_ENC_PROBE_KEY = "content_encryption_probe";

// Secret SHAPES and key/value assignments that must never appear in cleartext in a redacted
// artifact. These mirror packages/keiko-security/src/redaction.ts. Value-assignment checks explicitly
// allow the product placeholder so correctly redacted `"token": "[REDACTED]"` artifacts pass.
const REDACTED_PLACEHOLDER = "[REDACTED]";
const SECRET_SHAPE_PATTERNS = [
  { label: "OpenAI-style API key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{20,}/g },
  { label: "Stripe key", re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { label: "Figma token", re: /\bfigd_[A-Za-z0-9_-]{16,}/g },
  { label: "Bearer token", re: /\bBearer\s+[\w.\-+/=]+/gi },
  { label: "Basic auth token", re: /\bBasic\s+[\w.\-+/=]+/gi },
  { label: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { label: "URL credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/gi },
];

const SECRET_VALUE_PATTERNS = [
  { label: "x-api-key header", re: /\b(x-api-key\s*:\s*)["']?([^\s"'`,;}]+)/gi },
  { label: "api key assignment", re: /\b(api[_-]?key\s*[=:]\s*)["']?([^\s"'`,;&}]+)/gi },
  {
    label: "secret key assignment",
    re: /\b(passwd|password|api_?token|token|secret_key|secret|client_secret|refresh_token|access_token|id_token|private_key|aws_secret_access_key|secret_access_key|sas_token|jwt_secret|db_password|connection_?string|credential)(["']?\s*[:=]\s*["']?)([^\s"'`,;&}]+)/gi,
    valueGroup: 3,
  },
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

function firstSymlinkInPath(stateDir, relPath) {
  let current = stateDir;
  for (const part of relPath.split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) return undefined;
    if (stat.isSymbolicLink()) return current;
  }
  return undefined;
}

function symlinkFinding(stateDir, absPath) {
  return `${relative(stateDir, absPath)} is a symbolic link (refusing to read Keiko-owned artifact)`;
}

function octal(absPath) {
  return `0o${(statSync(absPath).mode & 0o777).toString(8)}`;
}

function looseModeFromStat(stat) {
  return (stat.mode & 0o077) !== 0;
}

function octalFromStat(stat) {
  return `0o${(stat.mode & 0o777).toString(8)}`;
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

function quoteIdent(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsupported SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function columnExists(db, table, column) {
  if (!tableExists(db, table)) return false;
  return db
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all()
    .some((row) => row.name === column);
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
  const { refs, findings: refFindings } = collectProviderCredentialRefs(config);
  findings.push(...refFindings);
  const vaultPath = join(stateDir, CREDENTIALS_SUBDIR, PROVIDER_VAULT);
  const credentialsSymlink = firstSymlinkInPath(stateDir, CREDENTIALS_SUBDIR);
  if (credentialsSymlink !== undefined) {
    findings.push(symlinkFinding(stateDir, credentialsSymlink));
  } else {
    auditProviderVaultPath(stateDir, vaultPath, refs, findings);
  }
  if (findings.length > 0) return fail(id, title, findings);
  return pass(id, title, [
    refs.length > 0
      ? `config exposes ${refs.length} secret reference(s); credentials are sealed in ${CREDENTIALS_SUBDIR}/${PROVIDER_VAULT}`
      : "config carries no credential material",
  ]);
}

function collectProviderCredentialRefs(config) {
  const refs = [];
  const findings = [];
  const providers = Array.isArray(config.providers) ? config.providers : [];
  providers.forEach((provider, index) => {
    if (typeof provider !== "object" || provider === null) return;
    if (!Object.hasOwn(provider, "apiKeySecretRef")) return;
    collectOneProviderCredentialRef(provider, index, refs, findings);
  });
  return { refs, findings };
}

function collectOneProviderCredentialRef(provider, index, refs, findings) {
  const label = `credential reference #${index + 1}`;
  const ref = provider.apiKeySecretRef;
  if (typeof ref !== "string" || ref.length === 0) {
    findings.push(`${label} is not a non-empty provider credential reference`);
    return;
  }
  const modelId = provider.modelId;
  if (typeof modelId !== "string" || modelId.length === 0) {
    findings.push(`${label} cannot be validated because provider modelId is missing`);
    return;
  }
  if (ref !== `${PROVIDER_SECRET_REF_PREFIX}${modelId}`) {
    findings.push(`${label} does not match the provider credential reference scheme`);
    return;
  }
  refs.push(ref);
}

function auditProviderVaultPath(stateDir, vaultPath, refs, findings) {
  if (!existsSync(vaultPath)) {
    if (refs.length > 0) {
      findings.push(
        `config references ${refs.length} sealed credential(s) but ${CREDENTIALS_SUBDIR}/${PROVIDER_VAULT} is missing`,
      );
    }
    return;
  }
  const vaultSymlink = firstSymlinkInPath(stateDir, `${CREDENTIALS_SUBDIR}/${PROVIDER_VAULT}`);
  if (vaultSymlink !== undefined) {
    findings.push(symlinkFinding(stateDir, vaultSymlink));
    return;
  }
  findings.push(...validateProviderVault(vaultPath, refs));
}

function validateProviderVault(vaultPath, refs) {
  const vault = readJsonFile(vaultPath);
  if (vault === undefined) {
    return [`${CREDENTIALS_SUBDIR}/${PROVIDER_VAULT} is not valid JSON`];
  }
  if (typeof vault !== "object" || vault === null || Array.isArray(vault)) {
    return [`${CREDENTIALS_SUBDIR}/${PROVIDER_VAULT} is not an object`];
  }
  if (vault.version !== PROVIDER_VAULT_VERSION) {
    return [`${CREDENTIALS_SUBDIR}/${PROVIDER_VAULT} has an unsupported schema version`];
  }
  const entries = vault.entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    return [`${CREDENTIALS_SUBDIR}/${PROVIDER_VAULT} is missing an entries object`];
  }
  return validateProviderVaultEntries(entries, refs);
}

function sealedEntryFinding(label, value) {
  return typeof value === "string" && value.startsWith(SEALED_STRING_PREFIX)
    ? undefined
    : `${label} is not sealed as a kv1. envelope`;
}

function validateProviderVaultEntries(entries, refs) {
  const findings = [];
  for (const [index, ref] of refs.entries()) {
    const label = `credential reference #${index + 1}`;
    if (!Object.hasOwn(entries, ref)) {
      findings.push(`${label} is missing from the provider vault`);
      continue;
    }
    const finding = sealedEntryFinding(label, entries[ref]);
    if (finding !== undefined) findings.push(finding);
  }
  for (const [index, [, value]] of Object.entries(entries).entries()) {
    const finding = sealedEntryFinding(`provider vault entry #${index + 1}`, value);
    if (finding !== undefined) findings.push(finding);
  }
  return findings;
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
const MEMORY_TEXT_TARGETS = [
  { table: "memories", column: "body" },
  { table: "memories", column: "payload_json" },
  { table: "memories", column: "tags_json" },
  { table: "memories", column: "capture_rationale" },
  { table: "memories", column: "stale_reason" },
  { table: "memory_edges", column: "provenance_summary" },
  { table: "memory_tombstones", column: "reason" },
];

function sampleColumnSealed(db, table, column) {
  // Returns { rows, sealed } for a TEXT content column: sealed is true only when EVERY non-null
  // sampled value is a kv1. envelope. An empty table yields rows: 0 (nothing to contradict).
  if (!columnExists(db, table, column)) return { rows: 0, sealed: true };
  const values = db
    .prepare(
      `SELECT ${quoteIdent(column)} AS v FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IS NOT NULL`,
    )
    .all();
  const sealed = values.every(
    (r) => typeof r.v === "string" && r.v.startsWith(SEALED_STRING_PREFIX),
  );
  return { rows: values.length, sealed };
}

function blobColumnSealed(db, table, column) {
  if (!columnExists(db, table, column)) return { rows: 0, sealed: true };
  const values = db
    .prepare(
      `SELECT ${quoteIdent(column)} AS v FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IS NOT NULL`,
    )
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
    for (const { table, column } of MEMORY_TEXT_TARGETS) {
      const { rows, sealed } = sampleColumnSealed(db, table, column);
      contentRows += rows;
      if (!sealed)
        findings.push(`${table}.${column} contains cleartext content (expected kv1. envelopes)`);
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
      `${contentRows} memory text value(s) across ${MEMORY_TEXT_TARGETS.length} audited column(s) and ${vec.rows} embedding(s) are sealed at rest`,
    ]);
  } finally {
    db.close();
  }
}

// ── Class 4: encrypted Local Knowledge content ───────────────────────────────────────────────
const LOCAL_KNOWLEDGE_TEXT_TARGETS = [
  { table: "document_texts", column: "normalized_text" },
  { table: "document_text_windows", column: "normalized_text" },
  { table: "sections", column: "section_path_json" },
  { table: "parsed_units", column: "section_path_json" },
  { table: "parsed_units", column: "heading_path_json" },
];

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
    for (const { table, column } of LOCAL_KNOWLEDGE_TEXT_TARGETS) {
      const text = sampleColumnSealed(db, table, column);
      if (!text.sealed) findings.push(`${namespace}: ${table}.${column} contains cleartext`);
    }
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
    `${stores.length} Local Knowledge store(s) seal reconstructive content at rest (marker + sealed key probe verified; populated audited columns checked)`,
  ]);
}

// ── Class 5: protected Evidence / Quality-Intelligence artifacts ──────────────────────────────
function isPlaceholderSafe(value) {
  const trimmed = value.trim().replace(/[.,;)}]+$/g, "");
  return trimmed === REDACTED_PLACEHOLDER || /^(?:true|false|null|[0-9]+)$/iu.test(trimmed);
}

function scanForSecretFindings(text) {
  const findings = [];
  for (const { label, re } of SECRET_SHAPE_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) findings.push(label);
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of text.matchAll(pattern.re)) {
      const value = match[pattern.valueGroup ?? 2];
      if (typeof value === "string" && !isPlaceholderSafe(value)) findings.push(pattern.label);
    }
  }
  return [...new Set(findings)];
}

function isTextArtifact(path) {
  return /\.(?:json|vault)$/u.test(path);
}

function scanForSecrets(path) {
  const text = readFileSync(path, "utf8");
  return scanForSecretFindings(text);
}

function collectArtifacts(stateDir) {
  const evidenceDir = join(stateDir, EVIDENCE_SUBDIR);
  const artifacts = {
    evidence: [],
    qi: [],
    candidates: [],
    qiCompanions: [],
    pe: [],
    figmaSnapshots: [],
    figmaManagement: [],
    figmaSideFiles: [],
    figmaVault: undefined,
    symlinks: [],
  };
  if (!existsSync(evidenceDir)) return artifacts;
  const evidenceSymlink = firstSymlinkInPath(stateDir, EVIDENCE_SUBDIR);
  if (evidenceSymlink !== undefined) {
    artifacts.symlinks.push(evidenceSymlink);
    return artifacts;
  }
  collectEvidenceTree(evidenceDir, EVIDENCE_SUBDIR, artifacts);
  collectKnownSubtree(
    join(evidenceDir, PE_SUBDIR),
    `${EVIDENCE_SUBDIR}/${PE_SUBDIR}`,
    artifacts,
    collectPeTree,
  );
  collectKnownSubtree(
    join(evidenceDir, QI_SUBDIR),
    `${EVIDENCE_SUBDIR}/${QI_SUBDIR}`,
    artifacts,
    collectQiTree,
  );
  collectFigmaVault(stateDir, artifacts);
  return artifacts;
}

function collectFigmaVault(stateDir, artifacts) {
  const figmaVaultRel = `${EVIDENCE_SUBDIR}/${FIGMA_SUBDIR}/${FIGMA_VAULT}`;
  const figmaVault = join(stateDir, figmaVaultRel);
  const symlink = firstSymlinkInPath(stateDir, figmaVaultRel);
  if (symlink !== undefined) {
    artifacts.symlinks.push(symlink);
  } else if (existsSync(figmaVault)) {
    artifacts.figmaVault = figmaVault;
  }
}

function collectKnownSubtree(abs, rel, artifacts, collector) {
  if (!existsSync(abs)) return;
  const stat = lstatSync(abs);
  if (stat.isSymbolicLink()) {
    artifacts.symlinks.push(abs);
    return;
  }
  if (stat.isDirectory()) collector(abs, rel, artifacts);
}

function collectEvidenceTree(dir, relDir, artifacts) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      artifacts.symlinks.push(abs);
      continue;
    }
    if (stat.isDirectory()) continue;
    if (
      stat.isFile() &&
      relDir === EVIDENCE_SUBDIR &&
      name.endsWith(".json") &&
      !name.endsWith(".lock")
    ) {
      artifacts.evidence.push(abs);
    }
  }
}

function collectPeTree(dir, relDir, artifacts) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      artifacts.symlinks.push(abs);
      continue;
    }
    if (stat.isFile() && name.endsWith(".pe.json")) artifacts.pe.push(abs);
    else if (stat.isDirectory()) collectPeTree(abs, `${relDir}/${name}`, artifacts);
  }
}

function collectQiTree(dir, relDir, artifacts) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      artifacts.symlinks.push(abs);
      continue;
    }
    if (stat.isDirectory()) collectQiDirectory(name, abs, relDir, artifacts);
    else if (stat.isFile()) collectQiFile(name, abs, artifacts);
  }
}

function collectQiDirectory(name, abs, relDir, artifacts) {
  if (name === FIGMA_SNAPSHOT_SUBDIR || relDir.includes(`/${FIGMA_SNAPSHOT_SUBDIR}`)) {
    collectFigmaSideFiles(abs, `${relDir}/${name}`, artifacts);
  }
}

function collectQiFile(name, abs, artifacts) {
  if (name.endsWith(".figma-snapshot.management.json")) artifacts.figmaManagement.push(abs);
  else if (name.endsWith(".figma-snapshot.json")) artifacts.figmaSnapshots.push(abs);
  else if (name.endsWith(".qi.json")) artifacts.qi.push(abs);
  else if (name.endsWith(".candidates.json")) artifacts.candidates.push(abs);
  else if (name.endsWith(".json")) artifacts.qiCompanions.push(abs);
}

function collectFigmaSideFiles(dir, relDir, artifacts) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      artifacts.symlinks.push(abs);
      continue;
    }
    if (stat.isDirectory()) collectFigmaSideFiles(abs, `${relDir}/${name}`, artifacts);
    else if (stat.isFile()) artifacts.figmaSideFiles.push(abs);
  }
}

function checkArtifactProtection(stateDir, path, findings) {
  const rel = relative(stateDir, path);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    findings.push(`${rel} is a symbolic link (refusing to read Keiko-owned artifact)`);
    return false;
  }
  if (!stat.isFile()) {
    findings.push(`${rel} is not a regular file`);
    return false;
  }
  if (process.platform !== "win32" && looseModeFromStat(stat)) {
    findings.push(`${rel} is ${octalFromStat(stat)} (expected 0o600)`);
  }
  if (isTextArtifact(path)) {
    const leaks = scanForSecrets(path);
    if (leaks.length > 0)
      findings.push(`${rel} contains unredacted secret material (${leaks.join(", ")})`);
  }
  return true;
}

function sha256OfJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256OfBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
  return `{${entries.join(",")}}`;
}

function sha256OfCanonicalJson(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function checkQiTamperEvidence(stateDir, qiPaths, findings) {
  for (const path of qiPaths) {
    findings.push(...qiIntegrityFindings(stateDir, path));
  }
}

function qiIntegrityFindings(stateDir, path) {
  const manifest = readJsonFile(path);
  const rel = relative(stateDir, path);
  if (manifest === undefined) return [`${rel} is not valid JSON`];
  if (typeof manifest.integrityHashes !== "object" || manifest.integrityHashes === null) {
    return [`${rel} is missing integrity hashes`];
  }
  return [...requiredQiHashFindings(rel, manifest), ...optionalQiHashFindings(rel, manifest)];
}

function requiredQiHashFindings(rel, manifest) {
  return ["findings", "exports", "evidenceRefs"].flatMap((field) => {
    const expected = sha256OfJson(Array.isArray(manifest[field]) ? manifest[field] : []);
    return manifest.integrityHashes[field] === expected
      ? []
      : [`${rel} integrity hash mismatch for ${field}`];
  });
}

function optionalQiHashFindings(rel, manifest) {
  return ["atomFingerprints", "coverageMatrix", "sourceFingerprints"].flatMap((field) => {
    if (manifest[field] === undefined) return [];
    const expected = sha256OfJson(manifest[field]);
    return manifest.integrityHashes[field] === expected
      ? []
      : [`${rel} integrity hash mismatch for ${field}`];
  });
}

function checkPromptEnhancementIntegrity(stateDir, pePaths, findings) {
  for (const path of pePaths) {
    const manifest = readJsonFile(path);
    const rel = relative(stateDir, path);
    if (manifest === undefined) {
      findings.push(`${rel} is not valid JSON`);
      continue;
    }
    if (typeof manifest.integrityHashes !== "object" || manifest.integrityHashes === null) {
      findings.push(`${rel} is missing integrity hashes`);
      continue;
    }
    const record = { ...manifest };
    delete record.integrityHashes;
    const expected = {
      enhancedOutput: sha256OfJson({
        enhancedPromptId: manifest.enhancedPromptId,
        enhancedPromptTextRedacted: manifest.enhancedPromptTextRedacted,
      }),
      appliedRules: sha256OfJson({
        appliedSafetyRules: manifest.appliedSafetyRules,
        appliedGroundingDirectives: manifest.appliedGroundingDirectives,
        assumptions: manifest.assumptions,
      }),
      candidateScores: sha256OfJson(manifest.candidateScores),
      record: sha256OfJson(record),
    };
    for (const [field, hash] of Object.entries(expected)) {
      if (manifest.integrityHashes[field] !== hash) {
        findings.push(`${rel} integrity hash mismatch for ${field}`);
      }
    }
  }
}

function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.split(/[\\/]/u).includes("..")
  );
}

function checkFigmaSnapshotIntegrity(stateDir, snapshotPaths, findings) {
  for (const path of snapshotPaths) {
    findings.push(...figmaSnapshotFindings(stateDir, path));
  }
}

function figmaSnapshotFindings(stateDir, path) {
  const rel = relative(stateDir, path);
  const manifest = readJsonFile(path);
  if (manifest === undefined) return [`${rel} is not valid JSON`];
  const runId = typeof manifest.runId === "string" ? manifest.runId : undefined;
  if (runId === undefined) return [`${rel} is missing runId`];
  return [
    ...figmaSnapshotMetadataFindings(rel, manifest),
    ...figmaScreenFindings(stateDir, rel, runId, manifest.screens),
    ...figmaArtifactHashFindings(rel, manifest),
  ];
}

function figmaSnapshotMetadataFindings(rel, manifest) {
  return typeof manifest.integrityHash === "string" && manifest.integrityHash.length > 0
    ? []
    : [`${rel} is missing snapshot integrity metadata`];
}

function figmaScreenFindings(stateDir, rel, runId, screens) {
  if (!Array.isArray(screens)) return [];
  return screens.flatMap((screen) =>
    typeof screen === "object" && screen !== null
      ? oneFigmaScreenFindings(stateDir, rel, runId, screen)
      : [],
  );
}

function oneFigmaScreenFindings(stateDir, rel, runId, screen) {
  const findings = [];
  if (typeof screen.integrityHash !== "string" || screen.integrityHash.length === 0) {
    findings.push(`${rel} screen ${String(screen.screenId ?? "?")} is missing integrity metadata`);
  }
  if (typeof screen.image === "object" && screen.image !== null) {
    findings.push(...figmaImageFindings(stateDir, rel, runId, screen));
  }
  return findings;
}

function figmaImageFindings(stateDir, rel, runId, screen) {
  const image = screen.image;
  const imageRelativePath = image.relativePath ?? image.path;
  if (!isSafeRelativePath(imageRelativePath)) {
    return [`${rel} screen ${String(screen.screenId ?? "?")} has an unsafe image side-file path`];
  }
  const imageRelPath = `${EVIDENCE_SUBDIR}/${QI_SUBDIR}/${FIGMA_SNAPSHOT_SUBDIR}/${runId}/${imageRelativePath}`;
  const symlink = firstSymlinkInPath(stateDir, imageRelPath);
  if (symlink !== undefined) return [symlinkFinding(stateDir, symlink)];
  const imagePath = join(stateDir, imageRelPath);
  return imageFileFindings(stateDir, imagePath, image);
}

function imageFileFindings(stateDir, imagePath, image) {
  const rel = relative(stateDir, imagePath);
  const stat = lstatSync(imagePath, { throwIfNoEntry: false });
  if (stat === undefined) return [`${rel} is missing`];
  if (stat.isSymbolicLink()) {
    return [symlinkFinding(stateDir, imagePath)];
  }
  if (!stat.isFile()) return [`${rel} is not a regular file`];
  const bytes = readFileSync(imagePath);
  return [
    ...(typeof image.byteLength === "number" && bytes.byteLength !== image.byteLength
      ? [`${rel} byteLength does not match snapshot metadata`]
      : []),
    ...(typeof image.sha256 === "string" && sha256OfBytes(bytes) !== image.sha256
      ? [`${rel} sha256 does not match snapshot metadata`]
      : []),
  ];
}

function figmaArtifactHashFindings(rel, manifest) {
  const artifactHashes =
    typeof manifest.artifactHashes === "object" && manifest.artifactHashes !== null
      ? manifest.artifactHashes
      : {};
  return ["links", "tokens", "metrics"].flatMap((field) =>
    figmaOneArtifactHashFindings(rel, manifest, artifactHashes, field),
  );
}

function figmaOneArtifactHashFindings(rel, manifest, artifactHashes, field) {
  if (manifest[field] === undefined) return [];
  if (artifactHashes[field] === undefined) {
    return [`${rel} ${field} artifact is present without its artifact hash`];
  }
  return artifactHashes[field] === sha256OfCanonicalJson(manifest[field])
    ? []
    : [`${rel} ${field} artifact hash mismatch`];
}

function checkFigmaVault(stateDir, figmaVault, findings) {
  const rel = relative(stateDir, figmaVault);
  const stat = lstatSync(figmaVault);
  if (stat.isSymbolicLink()) {
    findings.push(`${rel} is a symbolic link (refusing to read Keiko-owned artifact)`);
    return;
  }
  if (process.platform !== "win32" && looseModeFromStat(stat)) {
    findings.push(`${rel} is ${octalFromStat(stat)} (expected 0o600)`);
  }
  if (!readFileSync(figmaVault, "utf8").trim().startsWith(SEALED_STRING_PREFIX)) {
    findings.push(`${rel} is not a sealed Figma token envelope`);
  }
}

function auditEvidence(stateDir) {
  const id = "evidence-qi";
  const title = "Protected Evidence / Quality-Intelligence artifacts";
  const a = collectArtifacts(stateDir);
  const total =
    a.evidence.length +
    a.qi.length +
    a.candidates.length +
    a.qiCompanions.length +
    a.pe.length +
    a.figmaSnapshots.length +
    a.figmaManagement.length +
    a.figmaSideFiles.length +
    a.symlinks.length +
    (a.figmaVault ? 1 : 0);
  if (total === 0) return skip(id, title, "no Evidence / QI artifacts present");
  const findings = [];
  for (const path of a.symlinks) {
    findings.push(
      `${relative(stateDir, path)} is a symbolic link (refusing to read Keiko-owned artifact)`,
    );
  }
  for (const path of [
    ...a.evidence,
    ...a.qi,
    ...a.candidates,
    ...a.qiCompanions,
    ...a.pe,
    ...a.figmaSnapshots,
    ...a.figmaManagement,
    ...a.figmaSideFiles,
  ]) {
    checkArtifactProtection(stateDir, path, findings);
  }
  checkQiTamperEvidence(stateDir, a.qi, findings);
  checkPromptEnhancementIntegrity(stateDir, a.pe, findings);
  checkFigmaSnapshotIntegrity(stateDir, a.figmaSnapshots, findings);
  if (a.figmaVault) checkFigmaVault(stateDir, a.figmaVault, findings);
  if (findings.length > 0) return fail(id, title, findings);
  return pass(id, title, [
    `${a.evidence.length} evidence manifest(s), ${a.qi.length} QI manifest(s), ${a.candidates.length} candidate artifact(s), ${a.pe.length} PE manifest(s), ${a.figmaSnapshots.length} Figma snapshot record(s), ${a.figmaSideFiles.length} Figma side-file(s)` +
      `${a.figmaVault ? ", 1 sealed Figma token vault" : ""} are owner-only and redacted where text-bearing; QI/PE hashes and Figma image side-file hashes were verified`,
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
