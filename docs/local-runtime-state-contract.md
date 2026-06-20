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
- Evidence and memory remain local machine state; neither is a hosted service.

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

## Boundary notes

- Environment-variable values remain customer-owned configuration. Keiko reads them; it does not
  silently re-home or re-export them.
- Evidence is redacted before persistence and stored separately from UI durable state.
- Memory audit events are persisted without raw memory bodies or payloads.
- This page keeps migration-sensitive path and precedence details only where they remain part of
  the live product contract; it does not document retired compatibility or upgrade-only steps.
