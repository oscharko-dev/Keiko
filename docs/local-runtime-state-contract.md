# Local Runtime State Contract

This document is the upgrade-compatibility contract referenced by issue #170. It enumerates every
on-disk path, environment variable, and SQLite schema that Keiko reads or writes locally, and
records the per-category verdict for the 0.1.x → post-modular (epic #156, PRs #159–#168) upgrade.

The executable evidence backing this contract is
[`tests/upgrade-smoke/upgrade-compatibility.test.ts`](../tests/upgrade-smoke/upgrade-compatibility.test.ts),
which exercises the on-disk categories (1, 3, 4, 5, 6) against a frozen pre-modular install
fixture at [`tests/upgrade-smoke/fixture/pre-modular-0.1.x/`](../tests/upgrade-smoke/fixture/pre-modular-0.1.x/).
Categories 2 (credential env-var names) and 7 (`ui.pid` / `ui.log` lifecycle files) are
documentary-only: the smoke verifies the env-var names are preserved in the fixture `.env`,
and the lifecycle files exist only while `keiko ui` is running, so their compatibility is
asserted by the unchanged `packages/keiko-cli/src/lifecycle.ts:165-186` path constants rather
than by an in-process read.

## Scope

Nine categories of locally-resident state:

1. Gateway configuration file (`keiko.config.json`).
2. Credentials supplied via environment variables (`KEIKO_*_API_KEY`, `KEIKO_*_BASE_URL`).
3. UI SQLite database (`keiko-ui.db`).
4. Project, chat, and message rows inside the UI SQLite database.
5. Evidence manifests on disk under `.keiko/evidence/`.
6. CLI scripts registered in the consumer's `package.json` (`keiko:start`, `keiko:stop`).
7. Lifecycle state (`.keiko/ui.pid`, `.keiko/ui.log`).
8. Local `.env` discovery for `KEIKO_*` keys.
9. Enterprise Memory Vault SQLite database (`keiko-memory.db`).

## Non-goals

- This document does NOT describe runtime API contracts (those live in `@oscharko-dev/keiko-contracts`).
- It does NOT describe customer-owned configuration sources outside Keiko's control (shell profiles,
  secret managers, IDE settings).
- It does NOT promise behavioural compatibility for unreleased pre-`0.1.0-beta.0` builds.

## Verdict

Categories 1-8 are **no-op (read-compat evidence only)** for the 0.1.x upgrade. No shim, migration,
or per-package source change is required. Paths, environment-variable names, SQLite schema, and
package-script contents are byte-identical pre- and post-extraction.

Category 9 (Enterprise Memory Vault DB) is **new state introduced by epic #204**. It did not
exist in `0.1.x`, so no upgrade fixture is required: a `0.1.x` install upgrading past epic #204
finds no pre-existing `keiko-memory.db` and the vault writes a fresh V1 file on first open. The
upgrade-smoke fixture under `tests/upgrade-smoke/fixture/pre-modular-0.1.x/` is intentionally NOT
extended for category 9 because there is no `0.1.x` artifact to assert read-compat against.

## Inventory

| #   | Path or identifier                                                                                                    | File:Line (post-modular owner)                                                                                                                                           | Format              | Secrets                  | R/W        | Verdict                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------ | ---------- | ---------------------------------------------------------------------------- |
| 1   | `--config PATH` ∥ `$KEIKO_CONFIG_FILE` ∥ `dirname(uiDbPath)/keiko.config.json`                                        | `packages/keiko-server/src/deps.ts:180-213`, `packages/keiko-cli/src/ui.ts:164`                                                                                          | JSON                | yes (apiKey)             | R          | no-op                                                                        |
| 2   | `KEIKO_DEFAULT_API_KEY`, `KEIKO_MODEL_<id>_API_KEY`, `KEIKO_MODEL_<id>_BASE_URL`                                      | `packages/keiko-security/src/secrets.ts:24-25`, `packages/keiko-server/src/deps.ts:144-146`                                                                              | env                 | yes (apiKey)             | R          | no-op                                                                        |
| 3   | `--ui-db PATH` ∥ `$KEIKO_UI_DATA_DIR/keiko-ui.db` ∥ `~/.keiko/keiko-ui.db`                                            | `packages/keiko-server/src/store/paths.ts:53-65`                                                                                                                         | SQLite              | no                       | R/W        | no-op                                                                        |
| 4   | `projects`, `chats`, `chat_messages` rows in the UI DB                                                                | `packages/keiko-server/src/store/schema.ts:14-56` (V1+V2)                                                                                                                | SQLite STRICT       | no                       | R/W        | no-op                                                                        |
| 5   | `--evidence-dir PATH` ∥ `$KEIKO_EVIDENCE_DIR` ∥ `./.keiko/evidence/`                                                  | `packages/keiko-evidence/src/store.ts:35-45`; `EVIDENCE_SCHEMA_VERSION` at `packages/keiko-contracts/src/evidence.ts:21`                                                 | JSON                | redacted by construction | R/W        | no-op                                                                        |
| 6   | `"keiko:start": "keiko start"`, `"keiko:stop": "keiko stop"`                                                          | `packages/keiko-cli/src/init.ts:7-8,46-49`                                                                                                                               | JSON                | no                       | R/W (init) | no-op                                                                        |
| 7   | `$KEIKO_STATE_DIR/ui.pid`, `$KEIKO_STATE_DIR/ui.log` (default `.keiko/`)                                              | `packages/keiko-cli/src/lifecycle.ts:165-167,182-186`                                                                                                                    | text/PID, text/log  | no                       | R/W        | no-op                                                                        |
| 8   | KEIKO\_\* keys in cwd `.env`                                                                                          | `packages/keiko-cli/src/ui.ts:144-162`                                                                                                                                   | dotenv              | yes (apiKey)             | R          | no-op                                                                        |
| 9   | `memoryDir` opt ∥ `$KEIKO_MEMORY_DIR` ∥ `$KEIKO_STATE_DIR/memory/keiko-memory.db` ∥ `~/.keiko/memory/keiko-memory.db` | `packages/keiko-memory-vault/src/paths.ts:64-83` (resolveMemoryDir/resolveMemoryDbPath); `MEMORY_VAULT_SCHEMA_VERSION` at `packages/keiko-memory-vault/src/schema.ts:23` | SQLite STRICT (WAL) | redacted at boundary     | R/W        | new — no 0.1.x fixture required (state did not exist pre-modular; epic #204) |

## Precedence rules

The four categories that resolve a configurable path follow an explicit-flag → env → default ladder:

| Category        | Precedence ladder                                                                               | Resolver                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway config  | `--config` → `$KEIKO_CONFIG_FILE` → `dirname(uiDbPath)/keiko.config.json`                       | `packages/keiko-cli/src/ui.ts:164` (CLI), `packages/keiko-server/src/deps.ts:186-213` (resolveConfig), `packages/keiko-server/src/deps.ts:180` (sibling) |
| UI DB           | explicit option → `$KEIKO_UI_DATA_DIR/keiko-ui.db` → `homedir()/.keiko/keiko-ui.db`             | `packages/keiko-server/src/store/paths.ts:53-65` (resolveUiDbPath)                                                                                       |
| Evidence dir    | `--evidence-dir` → `$KEIKO_EVIDENCE_DIR` → `./.keiko/evidence`                                  | `packages/keiko-evidence/src/store.ts:40-45` (resolveEvidenceDir)                                                                                        |
| Lifecycle state | `--state-dir` → `$KEIKO_STATE_DIR` → `.keiko` (cwd-relative)                                    | `packages/keiko-cli/src/lifecycle.ts:140-167` (buildLifecycleOptions)                                                                                    |
| Memory vault    | `memoryDir` opt → `$KEIKO_MEMORY_DIR` → `$KEIKO_STATE_DIR/memory/` → `homedir()/.keiko/memory/` | `packages/keiko-memory-vault/src/paths.ts:64-83` (resolveMemoryDir)                                                                                      |

For the UI-DB path, the configured-path branch additionally enforces four fail-closed rules
(absolute, not-inside-cwd, not-symlink, no-symlink-ancestor) and normalizes the result at
`packages/keiko-server/src/store/paths.ts:30-44`. The same containment rules apply to a value
supplied via `$KEIKO_UI_DATA_DIR`. The Memory Vault path resolver enforces the identical
four fail-closed rules at `packages/keiko-memory-vault/src/paths.ts:42-55` against both the
explicit option and any value supplied via `$KEIKO_MEMORY_DIR` or `$KEIKO_STATE_DIR`.

## Risk register

| ID  | Risk                                                                                                                                                                                                          | Mitigation                                                                                                                                                              | Citation                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| R1  | Env vars the customer set on 0.1.x must still be set after upgrade — the upgrade does not re-export them                                                                                                      | Document explicitly: env-var values are customer-owned configuration, not Keiko-persisted state. The post-modular code paths read the same names                        | `packages/keiko-security/src/secrets.ts:21-26`, `packages/keiko-server/src/deps.ts:144-146` |
| R2  | A pre-`0.1.0-beta.0` evidence manifest without `evidenceSchemaVersion` would be rejected with a typed `EvidenceSchemaError` rather than silently consumed                                                     | Out of scope by design: `0.1.x` already wrote `evidenceSchemaVersion: "1"`; the schema-version gate is the correct fail-closed behaviour for any earlier internal build | `packages/keiko-evidence/src/index-api.ts:53-67`                                            |
| R3  | If a customer set `$KEIKO_CONFIG_FILE` in their shell profile, the post-modular resolver still honours it; if they later delete the file, the resolver falls back to env-only config without leaking the path | Confirmed: `resolveConfig` swallows `GatewayError` and falls back to `resolveEnvOnlyConfig` without logging the failed path                                             | `packages/keiko-server/src/deps.ts:186-213`                                                 |
| R4  | A corrupted `keiko-ui.db` after an unclean shutdown was quarantined to `<path>.corrupt.<iso>` in 0.1.x and is still quarantined post-modular                                                                  | Confirmed: identical code path; sidecars (`-wal`, `-shm`) are quarantined alongside                                                                                     | `packages/keiko-server/src/store/db.ts:193-200,245-258`                                     |
| R5  | `$KEIKO_EVIDENCE_DIR` set on 0.1.x must still be set after upgrade to read the existing manifests at a non-default location                                                                                   | Customer-owned configuration like R1; the resolver still has identical precedence                                                                                       | `packages/keiko-evidence/src/store.ts:35-45`                                                |

## Upgrade behaviour

A 0.1.x install requires no user-visible migration step. The customer's existing on-disk artifacts
(`keiko-ui.db`, evidence manifests, `.env`, `package.json` scripts) are consumed unchanged by the
post-modular packages. Environment variables the customer was already setting (`$KEIKO_CONFIG_FILE`,
`$KEIKO_UI_DATA_DIR`, `$KEIKO_EVIDENCE_DIR`, `$KEIKO_STATE_DIR`, `KEIKO_*_API_KEY`, `KEIKO_*_BASE_URL`)
must remain set — they are customer-owned configuration, not state Keiko persists on disk.

## Fresh install behaviour

A fresh install path is also unchanged. The CLI registers `keiko:start` and `keiko:stop` scripts in
the consumer's `package.json` using the same literals (`packages/keiko-cli/src/init.ts:7-8`). On
first run, the UI store creates `~/.keiko/keiko-ui.db` with directory mode `0o700` and file mode
`0o600` (Unix), then runs migrations V1 → V2 (`packages/keiko-server/src/store/db.ts:223-258`).

## Evidence for issue #170

The smoke test [`tests/upgrade-smoke/upgrade-compatibility.test.ts`](../tests/upgrade-smoke/upgrade-compatibility.test.ts)
exercises the contract end-to-end. It makes the following read-compat assertions:

1. Gateway config — `$KEIKO_CONFIG_FILE` and the sibling-of-UI-DB default both resolve to the fixture
   file; the JSON parses to a `GatewayConfig` with the seeded provider.
2. UI SQLite — opening the pre-modular DB lists the seeded project, chat, and message row; the
   `PRAGMA user_version` is `2` before and after the open (no implicit migration).
3. Evidence — `$KEIKO_EVIDENCE_DIR` set to the fixture surface lists the seeded manifest;
   `loadEvidence` returns a record with `evidenceSchemaVersion: "1"`.
4. CLI scripts — the fixture `package.json` has the byte-exact `keiko:start` and `keiko:stop`
   command strings registered by `keiko init`.
5. Path validation — relative and symlinked UI-DB paths are rejected with a typed error whose
   message does not leak the resolved path or the symlink target.
6. Fresh install — pointing `KEIKO_UI_DATA_DIR` at an empty tmpdir and opening the store creates
   `keiko-ui.db` at the canonical location with no migration step required.
