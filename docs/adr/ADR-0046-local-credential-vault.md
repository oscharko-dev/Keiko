# ADR-0046: Local gateway and connector credential vault

## Status

Accepted (Issue #1320, Epic #1319, 2026-06-20). Extends the encryption-at-rest pattern of [ADR-0035](ADR-0035-memory-vault-encryption-at-rest.md) and the Figma PAT vault ([ADR-0037](ADR-0037-figma-snapshot-boundary.md)) to model-gateway provider credentials, and removes plaintext credential persistence from `keiko.config.json`.

## Date

2026-06-20

## Version

0.2.0

## Context

First-run Gateway setup wrote provider `apiKey` values and an optional `figma.accessToken` into `keiko.config.json` with `0600` permissions. Private permissions are useful but are not encryption: a copied `.keiko` directory, a synced backup, or loose host permissions exposed every credential verbatim to a `strings` dump. Epic #1319's hard requirement for regulated banking and insurance pilots is that **no model-gateway API key or connector PAT persists as plaintext in local JSON config.**

The constraints carried over from the platform baseline:

- **Reuse the existing small encryption pattern.** The AES-256-GCM `secretbox` primitive (`@oscharko-dev/keiko-security`), the env → OS-keychain → `0600` keyfile key-resolution seam (ADR-0035 / Figma PAT vault), and the existing encrypted Figma token store already exist and are audited. No new dependency, no new package.
- **Stay local-first.** No hosted control plane, cloud secret store, or network dependency for credential retrieval.
- **Keep environment-variable credentials transient.** `KEIKO_DEFAULT_API_KEY` and `KEIKO_MODEL_<ID>_API_KEY` are read from the process environment and must never be written back to disk.
- **Preserve deterministic-first boundaries.** Productive model calls stay behind the Model Gateway; the gateway itself must not gain a filesystem/keychain/crypto dependency for secrets.
- **Be crash-aware and repairable.** Migration of existing plaintext config must reuse PR #1287's deterministic, locally-diagnosable posture, not hide behind a remote service.

## Decision

### D1 — A generalized local secret vault in `keiko-security`

`keiko-security/secret-vault.ts` adds two reusable primitives, exported under the `./secret-vault` subpath (leaf package; no new package-graph edge):

- `resolveLocalVaultKey({ env, vaultDir, envVarName, keychainService, keyfileName, keychainAccess? })` — the generalized env → macOS Keychain → `0600` keyfile precedence (the pattern previously inlined per vault), parameterized by namespace.
- `createLocalSecretVault({ key, storePath })` — a multi-entry sealed store (`{ "version": 1, "entries": { "<ref>": "<kv1 envelope>" } }`), the multi-credential analogue of the single-value Figma store. Atomic temp-then-rename writes, mode `0600`, dir `0700`, symlink-segment guard. Each value is sealed with the shared `sealString`; references are opaque, non-secret identifiers.

Cross-vault replay is prevented by **key separation, not by the AAD**: every vault resolves a distinct key (distinct env var, keychain service, and keyfile), so a ciphertext sealed for one vault fails GCM authentication when opened with another's key regardless of the shared `keiko-memory-v1` AAD. The existing memory and Figma vaults are intentionally left untouched (out of scope); they may adopt this helper in a future consolidation.

### D2 — Secret references in config, resolution behind the Model Gateway

A persisted provider carries `apiKeySecretRef` (an opaque `cred:<modelId>` string) instead of `apiKey`. The gateway config parser gains an optional, crypto-free `secretResolver` seam: `parseGatewayConfig(raw, env, { secretResolver })` / `loadConfigFromFile(...)`. A provider's effective apiKey resolves in precedence order:

1. per-model env `KEIKO_MODEL_<ID>_API_KEY` (transient operator override, highest),
2. `secretResolver(apiKeySecretRef)` (the durable encrypted vault),
3. file `apiKey` (legacy plaintext, tolerated until migrated),
4. `KEIKO_DEFAULT_API_KEY` (final fallback).

The gateway stays deterministic and free of filesystem/keychain/crypto: `keiko-server` and `keiko-cli` inject a vault-backed resolver; a resolver fault degrades to the next source so a locked or tampered vault surfaces as the existing "apiKey must be set" config error, never a crash. The credential-vault policy (reference scheme, vault location next to the config, env/keychain namespace) lives in `keiko-server/credentialVault.ts`, exported under the `./credential-vault` subpath so the offline `keiko run`/`keiko repair` commands resolve and detect credentials without loading the full BFF runtime.

### D3 — Setup writes references; the Figma PAT routes to its vault

Gateway setup seals each persistable provider apiKey into the credential vault (`<config-dir>/credentials/provider-credentials.vault`, namespace `KEIKO_PROVIDER_CREDENTIALS_KEY` / keychain `keiko-provider-credentials-vault`) and the Figma PAT into the existing encrypted Figma token vault, then writes a credential-free config holding only references and non-secret metadata. The in-memory runtime config still carries the resolved secret for live calls; only the on-disk file is stripped. An env-provided credential (one the environment already supplies) is written neither as plaintext nor as a reference, so environment credentials stay transient.

### D4 — Crash-aware, idempotent one-time migration

On `keiko ui` bootstrap, an existing plaintext `keiko.config.json` is migrated once: secrets are sealed into their vaults **first**, then the config is atomically rewritten without plaintext. If the process dies between the two steps, the old plaintext config remains and the next start re-runs the migration idempotently (vault writes overwrite). Migration is best-effort and never throws into bootstrap. `keiko repair` adds a `Credential storage` diagnostic that flags any lingering plaintext `apiKey`/`figma.accessToken` as an incomplete migration requiring action.

## Consequences

- A fresh or migrated `keiko.config.json` contains no `apiKey`, `accessToken`, bearer token, PAT, or credential value — only metadata and `apiKeySecretRef` references. Verified by unit and migration tests and by browser-response-safety assertions (`toSafeObject` already strips credentials).
- Redaction is unaffected: the in-memory config still carries resolved apiKeys, so the live audit redactor scrubs them from logs and evidence exactly as before.
- On developer machines without a keychain entry, the vault degrades to a `0600` keyfile beside the store — documented as the weaker tier; OS-keychain and the explicit `KEIKO_PROVIDER_CREDENTIALS_KEY` env tier raise the bar for regulated use.
- `keiko run --config <path>` resolves references through the same vault; a config with neither a resolvable reference nor an environment credential fails with an honest configuration error.

## Out of Scope

- Hosted secret management, remote KMS, or enterprise policy-server integration.
- Refactoring the memory vault or Figma vault to the new shared helper (deferred consolidation).
- Encrypting Local Knowledge, Evidence, or chat databases (sibling issues #1322/#1323).

## Alternatives Considered

- **Keep plaintext config with `0600` only.** Rejected: permissions are not encryption; the epic's threat model (copied directory, synced backup) defeats them.
- **Resolve credentials inside the gateway parser with embedded crypto.** Rejected: it would give the deterministic gateway a filesystem/keychain dependency and add a crypto-glue name to the root-re-exported gateway surface. The injected `secretResolver` keeps the gateway pure.
- **A new `keiko-credential-vault` package.** Rejected: the multi-entry store is a small, justified extension of `keiko-security`; a new package would add a graph edge for no reuse benefit.
- **A separate `keiko migrate-config` command.** Rejected: migration on first-run bootstrap plus a `keiko repair` diagnostic is deterministic, repairable, and requires no extra user step.

## Related

- [ADR-0035](ADR-0035-memory-vault-encryption-at-rest.md) — the encryption-at-rest pattern and key-resolution seam this generalizes.
- [ADR-0037](ADR-0037-figma-snapshot-boundary.md) — the Figma PAT vault and `vault > config > env` token precedence reused for AC3.
- [ADR-0019](ADR-0019-modular-package-architecture.md) — package boundaries the resolver seam and subpath exports respect.
- `docs/local-runtime-state-contract.md` — the updated runtime-state contract for `keiko.config.json`.
