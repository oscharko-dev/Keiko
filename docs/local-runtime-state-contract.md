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

| Surface                   | Resolution                                                                                                                                                             | Owner                                                          | Notes                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway config file       | `--config` → `KEIKO_CONFIG_FILE` → sibling `keiko.config.json` next to the resolved UI DB path                                                                         | `@oscharko-dev/keiko-cli`, `@oscharko-dev/keiko-server`        | JSON config; stores only non-secret provider metadata and stable secret references (`apiKeySecretRef`), never secret values.                    |
| Gateway credentials       | `KEIKO_DEFAULT_*` and `KEIKO_MODEL_<ID>_*` environment variables                                                                                                       | `@oscharko-dev/keiko-security`, `@oscharko-dev/keiko-server`   | Read from local environment; not written back by Keiko.                                                                                         |
| Provider credential vault | `<gateway-config dir>/credentials/provider-credentials.vault`; key via `KEIKO_PROVIDER_CREDENTIALS_KEY` → keychain `keiko-provider-credentials-vault` → `0600` keyfile | `@oscharko-dev/keiko-security`, `@oscharko-dev/keiko-server`   | AES-256-GCM sealed model-gateway API keys, referenced from config by `apiKeySecretRef`. See [ADR-0046](adr/ADR-0046-local-credential-vault.md). |
| Figma PAT vault           | `<evidence dir>/figma/figma-token.vault`; key via `KEIKO_FIGMA_KEY` → keychain `keiko-figma-vault` → `0600` keyfile                                                    | `@oscharko-dev/keiko-server`                                   | AES-256-GCM sealed Figma personal access token, resolved before the config/env fallback (ADR-0037).                                             |
| UI database               | `--ui-db` or `KEIKO_UI_DATA_DIR/keiko-ui.db` or `~/.keiko/keiko-ui.db`                                                                                                 | `@oscharko-dev/keiko-server`                                   | Local SQLite store for UI state.                                                                                                                |
| Evidence directory        | `--evidence-dir` or `KEIKO_EVIDENCE_DIR` or `./.keiko/evidence/`                                                                                                       | `@oscharko-dev/keiko-evidence`                                 | Redacted JSON manifests and related local evidence files.                                                                                       |
| Consumer package scripts  | `keiko:start`, `keiko:stop` in the consumer `package.json`                                                                                                             | `@oscharko-dev/keiko-cli`                                      | Written by `keiko init`.                                                                                                                        |
| Lifecycle files           | `KEIKO_STATE_DIR/ui.pid` and `KEIKO_STATE_DIR/ui.log` or default `.keiko/`                                                                                             | `@oscharko-dev/keiko-cli`                                      | Runtime-only process state.                                                                                                                     |
| Local `.env` discovery    | Current working directory `.env` for the closed allowlist `FIGMA_ACCESS_TOKEN` only                                                                                    | `@oscharko-dev/keiko-cli`                                      | Read-only connector convenience surface; `KEIKO_*` runtime configuration must come from explicit flags or the process environment.              |
| Memory vault              | `memoryDir` → `KEIKO_MEMORY_DIR` → `KEIKO_STATE_DIR/memory/keiko-memory.db` → `~/.keiko/memory/keiko-memory.db`                                                        | `@oscharko-dev/keiko-memory-vault` and related memory packages | Local SQLite STRICT/WAL store; workspace-local paths are rejected.                                                                              |

## Precedence ladders

| Surface         | Precedence                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| Gateway config  | `--config` → `KEIKO_CONFIG_FILE` → sibling `keiko.config.json`                    |
| UI DB           | explicit option → `KEIKO_UI_DATA_DIR/keiko-ui.db` → `~/.keiko/keiko-ui.db`        |
| Evidence dir    | `--evidence-dir` → `KEIKO_EVIDENCE_DIR` → `./.keiko/evidence/`                    |
| Lifecycle state | `--state-dir` → `KEIKO_STATE_DIR` → `.keiko/`                                     |
| Memory vault    | `memoryDir` → `KEIKO_MEMORY_DIR` → `KEIKO_STATE_DIR/memory/` → `~/.keiko/memory/` |

## Confidentiality enforcement (`keiko repair` / `keiko uninstall`)

`keiko repair` and `keiko uninstall --state` operate on an allowlisted manifest of the
Keiko-owned artifacts above, resolved relative to the configured state directory
(`packages/keiko-cli/src/state-paths.ts`). The manifest covers lifecycle and launcher files,
the UI / Memory / Local-Knowledge databases and their `-wal`/`-shm` sidecars, Evidence and
Quality-Intelligence records, the gateway config, and the sealed credential vaults
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
credentials ([ADR-0046](adr/ADR-0046-local-credential-vault.md)) and Local Knowledge extracted text
and vectors ([ADR-0047](adr/ADR-0047-local-knowledge-content-encryption.md)) are sealed with
AES-256-GCM, because those stores hold reconstructive content with no redaction or short-retention
mitigation available.

## Boundary notes

- Environment-variable values remain customer-owned configuration. Keiko reads them; it does not
  silently re-home or re-export them.
- Evidence is redacted before persistence and stored separately from UI durable state.
- Memory audit events are persisted without raw memory bodies or payloads.
- This page keeps migration-sensitive path and precedence details only where they remain part of
  the live product contract; it does not document retired compatibility or upgrade-only steps.
