# Local Runtime State Contract

This document enumerates the local paths, environment variables, and durable stores that Keiko
intentionally reads or writes at `0.2.0`. It is a current-state contract, not a historical rollout
or compatibility playbook.

## Principles

- Explicit CLI flags override environment variables; environment variables override defaults.
- Secrets enter through local config, local environment, or explicit local setup flows only.
- Local credentials (model-gateway API keys and the Figma PAT) persist only as AES-256-GCM sealed
  material in per-feature vaults; `keiko.config.json` stores non-secret provider metadata and stable
  secret references (`apiKeySecretRef`), never secret values. Environment-variable credentials stay
  transient and are never written back. See [ADR-0046](adr/ADR-0046-local-credential-vault.md).
- UI database and memory-vault configured paths use fail-closed validation; path escapes and
  symlink-based bypasses are rejected.
- Evidence and memory remain local machine state, not a hosted compliance archive; neither is
  a hosted service. See [Evidence artifact confidentiality](#evidence-artifact-confidentiality)
  and [ADR-0048](adr/ADR-0048-evidence-artifact-confidentiality.md).

## Inventory

| Surface                   | Resolution                                                                                                                                                             | Owner                                                          | Notes                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway config file       | `--config` → `KEIKO_CONFIG_FILE` → sibling `keiko.config.json` next to the resolved UI DB path                                                                         | `@oscharko-dev/keiko-cli`, `@oscharko-dev/keiko-server`        | JSON config; stores only non-secret provider metadata and stable secret references (`apiKeySecretRef`), never secret values.                                |
| Gateway credentials       | `KEIKO_DEFAULT_*` and `KEIKO_MODEL_<ID>_*` environment variables                                                                                                       | `@oscharko-dev/keiko-security`, `@oscharko-dev/keiko-server`   | Read from local environment; not written back by Keiko.                                                                                                     |
| Provider credential vault | `<gateway-config dir>/credentials/provider-credentials.vault`; key via `KEIKO_PROVIDER_CREDENTIALS_KEY` → keychain `keiko-provider-credentials-vault` → `0600` keyfile | `@oscharko-dev/keiko-security`, `@oscharko-dev/keiko-server`   | AES-256-GCM sealed model-gateway API keys, referenced from config by `apiKeySecretRef`. See [ADR-0046](adr/ADR-0046-local-credential-vault.md).             |
| Figma PAT vault           | `<evidence dir>/figma/figma-token.vault`; key via `KEIKO_FIGMA_KEY` → keychain `keiko-figma-vault` → `0600` keyfile                                                    | `@oscharko-dev/keiko-server`                                   | AES-256-GCM sealed Figma personal access token, resolved before the config/env fallback (ADR-0037).                                                         |
| UI database               | `--ui-db` or `KEIKO_UI_DATA_DIR/keiko-ui.db` or `~/.keiko/keiko-ui.db`                                                                                                 | `@oscharko-dev/keiko-server`                                   | Local SQLite store for UI state.                                                                                                                            |
| Evidence directory        | `--evidence-dir` or `KEIKO_EVIDENCE_DIR` or `./.keiko/evidence/`                                                                                                       | `@oscharko-dev/keiko-evidence`                                 | Redacted JSON manifests and related local evidence files.                                                                                                   |
| Consumer package scripts  | `keiko:start`, `keiko:stop` in the consumer `package.json`                                                                                                             | `@oscharko-dev/keiko-cli`                                      | Written by `keiko init`.                                                                                                                                    |
| Lifecycle files           | `KEIKO_STATE_DIR/ui.pid` and `KEIKO_STATE_DIR/ui.log` or default `.keiko/`                                                                                             | `@oscharko-dev/keiko-cli`                                      | Runtime-only process state.                                                                                                                                 |
| Update recovery state     | `KEIKO_STATE_DIR/updates/` or default `.keiko/updates/`                                                                                                                | `@oscharko-dev/keiko-server`                                   | Content-free update runtime state, remediation action status, audit events, and previous-version recovery manifests for failed or partial governed updates. |
| Portable install state    | `KEIKO_STATE_DIR/portable-install-state.json` or default `.keiko/portable-install-state.json`                                                                          | `@oscharko-dev/keiko-cli`                                      | Content-free managed install attestation and failed-setup status with hashed install/launcher identities and bounded failure codes only.                    |
| Local `.env` discovery    | Current working directory `.env` for the closed allowlist `FIGMA_ACCESS_TOKEN` only                                                                                    | `@oscharko-dev/keiko-cli`                                      | Read-only connector convenience surface; `KEIKO_*` runtime configuration must come from explicit flags or the process environment.                          |
| Memory vault              | `memoryDir` → `KEIKO_MEMORY_DIR` → `KEIKO_STATE_DIR/memory/keiko-memory.db` → `~/.keiko/memory/keiko-memory.db`                                                        | `@oscharko-dev/keiko-memory-vault` and related memory packages | Local SQLite STRICT/WAL store; workspace-local paths are rejected.                                                                                          |

## Precedence ladders

| Surface         | Precedence                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| Gateway config  | `--config` → `KEIKO_CONFIG_FILE` → sibling `keiko.config.json`                    |
| UI DB           | explicit option → `KEIKO_UI_DATA_DIR/keiko-ui.db` → `~/.keiko/keiko-ui.db`        |
| Evidence dir    | `--evidence-dir` → `KEIKO_EVIDENCE_DIR` → `./.keiko/evidence/`                    |
| Lifecycle state | `--state-dir` → `KEIKO_STATE_DIR` → `.keiko/`                                     |
| Memory vault    | `memoryDir` → `KEIKO_MEMORY_DIR` → `KEIKO_STATE_DIR/memory/` → `~/.keiko/memory/` |

## Confidentiality classes and controls

Local at-rest confidentiality is enforced by **five distinct controls**. They are independent: one
does not substitute for another, and the contract does not claim a control where it is not applied.

- **File permissions** — owner-only POSIX modes (`0o600` files, `0o700` directories) set at write
  time and re-normalized by `keiko repair`. On Windows (NTFS) and filesystems without POSIX modes
  the `chmod` is a no-op and access is governed by platform ACLs.
- **Redaction** — secret-shaped substrings are scrubbed before a record is persisted. Redaction
  reduces secret leakage at persistence time; it is not encryption and does not protect the
  non-secret remainder of an artifact.
- **Encryption at rest** — AES-256-GCM sealing of reconstructive content columns/files with a key
  resolved outside the data (env → OS keychain → co-located keyfile). Encryption protects content
  on a copied or synced store; it does not protect metadata kept cleartext for indexing, and it does
  not defeat a live process or a host where the key is already unlocked (see
  [Limitations](#limitations-honest-threat-model)).
- **Retention** — deterministic, fail-safe purge of bounded artifacts (QI manifests by stamped
  policy; Figma snapshots by count cap). Retention reduces how long content persists; it is not a
  confidentiality control for content that is still within its retention window.
- **Tamper evidence** — SHA-256 integrity hashes (QI manifests) and AES-256-GCM authentication
  (sealed columns, vaults, key-verification probes) make undetected modification fail closed.
  Tamper evidence detects modification; it does not prevent it and is not encryption.

The following matrix records, per durable surface, which controls apply (`yes`), do not apply
(`n/a`), or are an explicitly documented deferral (`deferred`). It is the consolidated, audited view
of the local-at-rest posture; the deterministic auditor in
[Local-state verification audit](#local-state-verification-audit) checks these expectations against a
real `.keiko` tree.

| Surface (file)                                                                                                     | File permissions | Redaction          | Encryption at rest               | Retention      | Tamper evidence                            | Governing decision                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------ | -------------------------------- | -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Gateway config (`keiko.config.json`)                                                                               | yes              | n/a                | n/a (secret refs only)           | n/a            | n/a                                        | [ADR-0046](adr/ADR-0046-local-credential-vault.md)                                                      |
| Provider credential vault (`*.vault` + `*.key`)                                                                    | yes              | n/a                | yes (AES-256-GCM)                | n/a            | yes (GCM auth)                             | [ADR-0046](adr/ADR-0046-local-credential-vault.md)                                                      |
| Figma PAT vault (`figma-token.vault` + key)                                                                        | yes              | n/a                | yes (AES-256-GCM)                | n/a            | yes (GCM auth)                             | [ADR-0037](adr/ADR-0037-figma-snapshot-boundary.md), [ADR-0046](adr/ADR-0046-local-credential-vault.md) |
| Memory vault (`keiko-memory.db`)                                                                                   | yes              | yes (audit events) | yes (content columns)            | n/a            | yes (GCM auth)                             | [ADR-0035](adr/ADR-0035-memory-vault-encryption-at-rest.md)                                             |
| Local Knowledge (`capsules.db`)                                                                                    | yes              | n/a                | yes (content columns)            | n/a            | yes (GCM auth + sealed probe)              | [ADR-0047](adr/ADR-0047-local-knowledge-content-encryption.md)                                          |
| UI database (`keiko-ui.db`)                                                                                        | yes              | n/a                | n/a (UI state, no model content) | n/a            | n/a                                        | this contract                                                                                           |
| Evidence run manifests (`<runId>.json`)                                                                            | yes              | yes                | deferred                         | n/a            | n/a                                        | [ADR-0048](adr/ADR-0048-evidence-artifact-confidentiality.md)                                           |
| QI manifests (`<runId>.qi.json`)                                                                                   | yes              | yes                | deferred                         | yes            | yes (SHA-256)                              | [ADR-0048](adr/ADR-0048-evidence-artifact-confidentiality.md)                                           |
| QI candidates (`<runId>.candidates.json`)                                                                          | yes              | yes                | deferred                         | yes            | n/a                                        | [ADR-0048](adr/ADR-0048-evidence-artifact-confidentiality.md)                                           |
| Figma snapshots (JSON / PNG side-files)                                                                            | yes              | yes                | deferred                         | yes (cap 500)  | PNG side-file SHA-256                      | [ADR-0048](adr/ADR-0048-evidence-artifact-confidentiality.md)                                           |
| Lifecycle / launcher / portable install (`ui.pid`, `ui.log`, `launcher-state.json`, `portable-install-state.json`) | yes              | n/a                | n/a (content-free)               | n/a            | yes (launcher and install identity hashes) | this contract                                                                                           |
| Update recovery manifests (`updates/*`)                                                                            | yes              | n/a                | n/a (content-free)               | yes (one prev) | manifest validation                        | [ADR-0099](adr/ADR-0099-governed-in-app-updates-and-release-impact-contract.md)                         |

`deferred` is a documented, bounded decision — not an oversight. Customer-reconstructive evidence
artifacts are not encrypted at rest in `0.2.0`; the compensating controls are owner-only permissions,
redaction-before-persist, and deterministic bounded retention. See
[ADR-0048](adr/ADR-0048-evidence-artifact-confidentiality.md) and
[Evidence artifact confidentiality](#evidence-artifact-confidentiality).

## Confidentiality enforcement (`keiko repair` / `keiko uninstall`)

`keiko repair` and `keiko uninstall --state` operate on an allowlisted manifest of the
Keiko-owned artifacts above, resolved relative to the configured state directory
(`packages/keiko-cli/src/state-paths.ts`). The manifest covers lifecycle and launcher files,
the UI / Memory / Local-Knowledge databases and their `-wal`/`-shm` sidecars, Evidence and
Quality-Intelligence records, update recovery manifests/audit logs, the gateway config, and the sealed credential vaults
(`credentials/*.vault` + keyfile, `evidence/figma/*.vault` + keyfile).

- **Repair** normalizes POSIX permissions to `0o700` for Keiko-owned directories and `0o600`
  for Keiko-owned files, reports lingering plaintext credentials, and is content-free
  (paths and categories only). It never deletes a store and never chmods an unrecognized
  customer file. On Windows it reports that NTFS ACLs govern access instead of applying modes.
- **Uninstall `--state`** removes the manifest artifacts and then the state directory, but
  only once no unrecognized customer file or symlink remains beneath it. It never follows a
  symlink out of `.keiko` and never recursively deletes an arbitrary directory. Filesystem
  unlinking does not guarantee secure erasure of SSD-backed data.

## Evidence artifact confidentiality

Local evidence is **local machine state, not a hosted compliance archive**. Keiko does not sync,
replicate, back up, or export evidence to any remote service; there is no disaster-recovery
guarantee and no remote audit ledger. Redaction reduces secret leakage at persistence time;
permissions, retention, and (where applied) encryption reduce local at-rest exposure. The two are
distinct controls and one does not substitute for the other. The governing decision is
[ADR-0048](adr/ADR-0048-evidence-artifact-confidentiality.md).

Evidence artifacts are classified into four confidentiality tiers:

| Class                   | Example artifacts                                                                                                     | Controls                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Customer-reconstructive | `<runId>.candidates.json` (generated test-case bodies), Figma snapshot JSON (`irJson`/`tokens`), Figma PNG side-files | `0o600` file / `0o700` dir, redaction, deterministic bounded retention. Encryption-at-rest deferred (see below).                                 |
| Customer-metadata       | QI run manifests (`<runId>.qi.json`), Prompt Enhancement manifests (`<runId>.pe.json`)                                | Redacted-by-construction, integrity-hashed (tamper-evident reads), `0o600`/`0o700`.                                                              |
| Process evidence        | Run manifests (`<runId>.json` under `evidence/`)                                                                      | Redacted workflow summaries, `0o600`/`0o700`.                                                                                                    |
| Operational             | Atomic `*.tmp` write files, lock/sidecar files                                                                        | Transient; `0o600`/`0o700`; temp write files may briefly contain the target payload and are ignored by read/list paths after interrupted writes. |

**Write-time permissions.** All evidence, Quality Intelligence, Prompt Enhancement, companion,
figma-snapshot, and binary side-file writers create directories with mode `0o700` and files with
mode `0o600` at write time on POSIX filesystems. The mode is best-effort: on Windows (NTFS) and
filesystems without POSIX modes the `chmod` is a no-op and access is governed by platform ACLs.
`keiko repair` detects and remediates permission drift on supported filesystems without reading
file content (see [Confidentiality enforcement](#confidentiality-enforcement-keiko-repair--keiko-uninstall)).

**Retention enforcement.** Retention policy identifiers are operational, not passive metadata.
Quality Intelligence run manifests are purged deterministically per their stamped retention
profile (`qi:short-30d` / `qi:standard-90d` / `qi:long-365d`) once per server instance at startup;
the purge is **fail-safe** — a run is retained on any uncertainty (unknown policy id, a newest-N
slot, an unreadable or tamper-failing manifest, or a missing/unparseable timestamp) and every
deletion routes through the realpath-contained, symlink-refusing deletion primitive. Figma
snapshots are bounded by a configurable count cap (default `500`, oldest-by-`fetchedAt` evicted)
enforced once per snapshot-store instance. Startup-purge receipts are not yet written to a
persistent audit ledger (keiko-server has none today); the purge is deterministic but, like the
user-initiated delete route, not yet attested in an audit trail.

**Encryption scope.** In `0.2.0`, customer-reconstructive evidence artifacts are **not** encrypted
at rest. The compensating controls are owner-only `0o600` permissions, deterministic bounded
retention, and redaction-before-persist. This deferral is explicit and documented in
[ADR-0048](adr/ADR-0048-evidence-artifact-confidentiality.md); the atomic write boundary in every
evidence writer is preserved as the seam to introduce a cipher later. By contrast, local
credentials ([ADR-0046](adr/ADR-0046-local-credential-vault.md)) and Local Knowledge configured
content columns ([ADR-0047](adr/ADR-0047-local-knowledge-content-encryption.md)) are sealed with
AES-256-GCM, because those stores hold reconstructive content with no redaction or short-retention
mitigation available. Local Knowledge's `chunk_lexical_index.text` and `exact_text` columns are the
documented exception: they remain a plaintext lexical retrieval projection, are treated as
reconstructive residual data, and are scanned by the local-state auditor for secret-shaped material.

## Local-state verification audit

A deterministic, read-only auditor (`scripts/check-local-state.mjs`) verifies that a real `.keiko`
tree matches the [confidentiality classes and controls](#confidentiality-classes-and-controls) above.
It imports only `node:fs` and `node:sqlite`, never decrypts content (every encryption check reads the
on-disk sealed markers the product itself writes, so no vault key is required), and never mutates the
tree.

- `npm run audit:local-state -- --state-dir <path>` — audit an existing `.keiko` tree (default
  `<cwd>/.keiko`). Maintainer-facing; exit `0` when the posture is healthy, `1` on any finding.
- `npm run check:local-state` — maintainer self-test. It generates a genuinely-encrypted healthy
  fixture and a deliberately drifted one, then asserts the auditor passes the former and detects the
  drift in the latter. The required GitHub `ci` check runs the regression coverage through
  `test:coverage:quality`; that path includes `scripts/__tests__/check-local-state.test.mjs`, which
  covers the same proof plus crafted negative cases and a `keiko repair --dry-run`
  healthy/drifted comparison.

The audit covers seven classes: no plaintext credentials in the gateway config; sealed editor
hot-exit recovery snapshots (`kv1.` envelopes with owner-only key material and symlink refusal on the
recovery store); owner-only file and directory modes for Keiko-owned artifacts; sealed Memory Vault
content (`kv1.` text envelopes, binary embedding envelopes); sealed Local Knowledge content (the
`content_encryption=aes-256-gcm/v1` marker plus a sealed key-verification probe, and any populated
content columns); protected Evidence/QI artifacts (owner-only modes, redaction checks on text-bearing
artifacts, recomputed QI/Prompt Enhancement manifest hashes, Figma snapshot side-file hash checks, and
symlink refusal before artifact reads); and runtime store integrity (no unresolved memory-vault or
Evidence/QI quarantine residue left behind by a failed operation).

Update recovery snapshots are not package archives or general downgrade backups. They retain one
previous-version, local-only, content-free manifest with version pointers, affected store health,
remediation status, and aggregate artifact counts. They do not copy customer repository files,
credential vaults, raw logs, prompts, model outputs, package-manager output, or private paths.

Update remediation status is persisted in `updates/runtime-state.json` as content-free action state
only: target version, affected store, remediation kind, status, bounded warning code, and timestamps.
Scope reporting uses counts (stores, artifacts, Local Knowledge capsules/documents/chunks/vectors),
never raw document text, vector bytes, model output, package-manager output, credential material, or
customer repository paths. Local Knowledge reindex remains a domain-specific action; generic repair
does not hide or mutate Local Knowledge content.

## Limitations (honest threat model)

These controls protect data **at rest** on a single-user machine. They are deliberately scoped, and
the product does not overstate them:

- Local encryption does **not** protect against malware running as the same user, a live compromised
  Keiko process, or a stolen machine on which the OS keychain is already unlocked. While a store is
  open, its content is decrypted in process memory by necessity (retrieval and the UI consume
  plaintext records).
- The **keyfile** key tier stores the key next to the ciphertext; an attacker who can read the state
  directory has both halves. For regulated deployments prefer the environment-variable tier (injected
  from a secrets manager) or the OS keychain tier. See the per-store key-resolution sections in
  [ADR-0035](adr/ADR-0035-memory-vault-encryption-at-rest.md),
  [ADR-0046](adr/ADR-0046-local-credential-vault.md), and
  [ADR-0047](adr/ADR-0047-local-knowledge-content-encryption.md).
- **Cleartext metadata** (scopes, types, timestamps, identifiers, offsets, hashes, embedding identity)
  is retained by design so deterministic retrieval works; it leaks the _shape_ of stored data (how
  much, which scopes, when), not its content.
- Local evidence and memory are **local machine state, not a hosted compliance archive**: there is no
  remote replication, backup, disaster-recovery guarantee, or remote audit ledger. Startup retention
  purges are deterministic but not yet attested in a persistent audit trail.
- Filesystem unlinking (`keiko uninstall --state`) does not guarantee secure erasure of SSD-backed
  data; full-disk encryption remains the host's responsibility.

## Boundary notes

- Environment-variable values remain customer-owned configuration. Keiko reads them; it does not
  silently re-home or re-export them.
- Evidence is redacted before persistence and stored separately from UI durable state.
- Memory audit events are persisted without raw memory bodies or payloads.
- This page keeps migration-sensitive path and precedence details only where they remain part of
  the live product contract; it does not document retired compatibility or upgrade-only steps.
