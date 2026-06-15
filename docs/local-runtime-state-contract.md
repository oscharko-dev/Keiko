# Local Runtime State Contract

This document enumerates the local paths, environment variables, and durable stores that Keiko
intentionally reads or writes at `0.2.0`. It is a current-state contract, not a historical rollout
or compatibility playbook.

## Principles

- Explicit CLI flags override environment variables; environment variables override defaults.
- Secrets enter through local config, local environment, or explicit local setup flows only.
- UI database and memory-vault configured paths use fail-closed validation; path escapes and
  symlink-based bypasses are rejected.
- Evidence and memory remain local machine state; neither is a hosted service.

## Inventory

| Surface                  | Resolution                                                                                                      | Owner                                                          | Notes                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Gateway config file      | `--config` → `KEIKO_CONFIG_FILE` → sibling `keiko.config.json` next to the resolved UI DB path                  | `@oscharko-dev/keiko-cli`, `@oscharko-dev/keiko-server`        | JSON config; may contain provider secrets.                                                                                         |
| Gateway credentials      | `KEIKO_DEFAULT_*` and `KEIKO_MODEL_<ID>_*` environment variables                                                | `@oscharko-dev/keiko-security`, `@oscharko-dev/keiko-server`   | Read from local environment; not written back by Keiko.                                                                            |
| UI database              | `--ui-db` or `KEIKO_UI_DATA_DIR/keiko-ui.db` or `~/.keiko/keiko-ui.db`                                          | `@oscharko-dev/keiko-server`                                   | Local SQLite store for UI state.                                                                                                   |
| Evidence directory       | `--evidence-dir` or `KEIKO_EVIDENCE_DIR` or `./.keiko/evidence/`                                                | `@oscharko-dev/keiko-evidence`                                 | Redacted JSON manifests and related local evidence files.                                                                          |
| Consumer package scripts | `keiko:start`, `keiko:stop` in the consumer `package.json`                                                      | `@oscharko-dev/keiko-cli`                                      | Written by `keiko init`.                                                                                                           |
| Lifecycle files          | `KEIKO_STATE_DIR/ui.pid` and `KEIKO_STATE_DIR/ui.log` or default `.keiko/`                                      | `@oscharko-dev/keiko-cli`                                      | Runtime-only process state.                                                                                                        |
| Local `.env` discovery   | Current working directory `.env` for the closed allowlist `FIGMA_ACCESS_TOKEN` only                             | `@oscharko-dev/keiko-cli`                                      | Read-only connector convenience surface; `KEIKO_*` runtime configuration must come from explicit flags or the process environment. |
| Memory vault             | `memoryDir` → `KEIKO_MEMORY_DIR` → `KEIKO_STATE_DIR/memory/keiko-memory.db` → `~/.keiko/memory/keiko-memory.db` | `@oscharko-dev/keiko-memory-vault` and related memory packages | Local SQLite STRICT/WAL store; workspace-local paths are rejected.                                                                 |

## Precedence ladders

| Surface         | Precedence                                                                        |
| --------------- | --------------------------------------------------------------------------------- |
| Gateway config  | `--config` → `KEIKO_CONFIG_FILE` → sibling `keiko.config.json`                    |
| UI DB           | explicit option → `KEIKO_UI_DATA_DIR/keiko-ui.db` → `~/.keiko/keiko-ui.db`        |
| Evidence dir    | `--evidence-dir` → `KEIKO_EVIDENCE_DIR` → `./.keiko/evidence/`                    |
| Lifecycle state | `--state-dir` → `KEIKO_STATE_DIR` → `.keiko/`                                     |
| Memory vault    | `memoryDir` → `KEIKO_MEMORY_DIR` → `KEIKO_STATE_DIR/memory/` → `~/.keiko/memory/` |

## Boundary notes

- Environment-variable values remain customer-owned configuration. Keiko reads them; it does not
  silently re-home or re-export them.
- Evidence is redacted before persistence and stored separately from UI durable state.
- Memory audit events are persisted without raw memory bodies or payloads.
- This page keeps migration-sensitive path and precedence details only where they remain part of
  the live product contract; it does not document retired compatibility or upgrade-only steps.
