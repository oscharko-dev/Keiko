# Local runtime-state confidentiality — verification record

Status: 0.2.0 — Issue #1325 (closure of Epic #1319, "Harden local runtime state confidentiality for
regulated deployments").

This is the consolidated verification record for the local `.keiko` at-rest posture. It proves that
the implementation delivered by the Epic #1319 child issues matches the
[local runtime-state contract](../local-runtime-state-contract.md) for regulated banking and
insurance deployments. It is a verification artifact, not new product scope: implementation lives in
the child issues below; this record audits and documents the combined result.

## Implementation under verification

| Child issue | Surface hardened                                                                                                  | Implementation PR(s) | Decision record                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------- |
| #1320       | Gateway + Figma credentials → AES-256-GCM local vaults, secret refs                                               | #1350, #1354, #1356  | [ADR-0046](../adr/ADR-0046-local-credential-vault.md)             |
| #1321       | `keiko repair` / `uninstall --state` runtime-state manifest hardening                                             | #1355, #1358, #1361  | [ADR-0046](../adr/ADR-0046-local-credential-vault.md)             |
| #1322       | Local Knowledge source-of-truth extracted text + vectors → AES-256-GCM at rest; declared plaintext FTS projection | #1363, #1364         | [ADR-0047](../adr/ADR-0047-local-knowledge-content-encryption.md) |
| #1323       | Evidence + Quality-Intelligence artifact confidentiality                                                          | #1365                | [ADR-0048](../adr/ADR-0048-evidence-artifact-confidentiality.md)  |
| #1325       | Verification + documentation capstone, then local-state verifier follow-up                                        | #1367, follow-up PR  | —                                                                 |

Baseline for credential and content encryption: [ADR-0035](../adr/ADR-0035-memory-vault-encryption-at-rest.md)
(Memory Vault AES-256-GCM `secretbox` primitive and content-vs-metadata model).

## Verification matrix

Each durable runtime-state surface and the controls that protect it. `deferred` is a documented,
bounded decision (owner-only permissions + redaction + retention are the compensating controls), not
a gap. The authoritative, maintained version of this matrix is in the
[local runtime-state contract](../local-runtime-state-contract.md#confidentiality-classes-and-controls);
it is reproduced here as the closure snapshot.

| Surface (file)                                  | Permissions     | Redaction                      | Encryption                                                            | Retention | Tamper evidence                        |
| ----------------------------------------------- | --------------- | ------------------------------ | --------------------------------------------------------------------- | --------- | -------------------------------------- |
| Gateway config (`keiko.config.json`)            | `0o600`         | n/a                            | secret refs only                                                      | n/a       | n/a                                    |
| Provider credential vault (`*.vault` + `*.key`) | `0o600`         | n/a                            | AES-256-GCM                                                           | n/a       | GCM auth                               |
| Figma PAT vault (`figma-token.vault` + key)     | `0o600`         | n/a                            | AES-256-GCM                                                           | n/a       | GCM auth                               |
| Memory vault (`keiko-memory.db`)                | `0o600`/`0o700` | audit events                   | AES-256-GCM content                                                   | n/a       | GCM auth                               |
| Local Knowledge (`capsules.db`)                 | `0o600`/`0o700` | lexical projection secret scan | AES-256-GCM reconstructive content; declared plaintext FTS projection | n/a       | GCM auth + sealed probe + scope marker |
| UI database (`keiko-ui.db`)                     | `0o600`/`0o700` | n/a                            | n/a (UI state)                                                        | n/a       | n/a                                    |
| Evidence run manifests (`<runId>.json`)         | `0o600`/`0o700` | yes                            | deferred                                                              | n/a       | n/a                                    |
| QI manifests (`<runId>.qi.json`)                | `0o600`/`0o700` | yes                            | deferred                                                              | yes       | SHA-256                                |
| QI candidates (`<runId>.candidates.json`)       | `0o600`/`0o700` | yes                            | deferred                                                              | yes       | n/a                                    |
| Figma snapshots (JSON / PNG)                    | `0o600`/`0o700` | yes                            | deferred                                                              | cap 500   | PNG side-file SHA-256                  |
| Lifecycle / launcher files                      | `0o600`/`0o700` | n/a                            | n/a (content-free)                                                    | n/a       | launcher content hash                  |

## Automated audit

`scripts/check-local-state.mjs` is a deterministic, read-only auditor. It imports only `node:fs` and
`node:sqlite`, requires no vault key (every encryption check reads the on-disk sealed markers the
product itself writes), and never mutates the tree.

- `npm run audit:local-state -- --state-dir <path>` — audit a real `.keiko` tree (maintainer).
- `npm run check:local-state` — maintainer self-test that generates a genuinely-encrypted healthy
  fixture and a deliberately drifted one, then asserts the auditor passes the former and detects the
  drift in the latter.
- `scripts/__tests__/check-local-state.test.mjs` — the same proof plus crafted negative cases and a
  `keiko repair --dry-run` comparison, run under the required GitHub `ci` check through
  `test:coverage:quality` (the package coverage `vitest` config includes
  `scripts/__tests__/**/*.test.mjs`).

The fixture is built with the real workspace store code paths (`createMemoryVault`,
`openKnowledgeStore` with an encrypted key provider, `openProviderCredentialVault`,
`createNodeEvidenceStore`, `recordQualityIntelligenceRun`, `recordQualityIntelligenceCandidates`,
`recordPromptEnhancementRun`, `createNodeFigmaSnapshotStore`, and the shared `secretbox` for the
Figma token vault), so the audit cannot drift from the implementation it verifies.

**Scope of each store's positive proof, stated precisely.** The Memory Vault fixture inserts real
content rows, so the audit samples and confirms sealed `body`, `payload_json`, `tags_json`,
`capture_rationale`, `stale_reason`, `memory_edges.provenance_summary`,
`memory_tombstones.reason`, and a sealed embedding. The Local Knowledge fixture demonstrates
**encryption-at-open** — the `content_encryption=aes-256-gcm/v1` marker, a sealed
key-verification probe, and the explicit
`content_encryption_scope=reconstructive-columns/v3` marker written by the real store at open — but
seeds no content rows, because the public ingest path requires the model-gateway embeddings adapter
and the row-layer seal helpers are package-internal. The auditor's Local Knowledge **content-row
sealing** branch (plaintext reconstructive columns must fail), missing-scope branch, and plaintext
lexical-projection secret scan are exercised directly by crafted-DB negative tests in
`scripts/__tests__/check-local-state.test.mjs`, and the real content seal / round-trip /
no-plaintext-in-encrypted-columns guarantee is covered by the `keiko-local-knowledge` suite delivered
under #1322 / #1364. The plaintext lexical FTS projection is an explicitly documented residual risk,
not part of the encryption claim. Each of the seven audit classes additionally has a dedicated
negative test that drives it to `fail`, so a weakened check is caught by a red test.

Evidence/QI verification is intentionally precise: the auditor checks owner-only modes and product
redactor-pattern coverage for text-bearing evidence, recomputes QI and Prompt Enhancement manifest
integrity hashes, verifies Figma PNG side-file hashes against snapshot metadata, validates the sealed
Figma token vault prefix, and refuses symlinked artifacts before reading. It does not claim generic
tamper evidence for plain evidence manifests, QI candidate companions, Figma management metadata, or
Figma snapshot JSON beyond the local metadata/hash checks it can recompute without importing product
packages.

## Verification commands and outcomes

All commands run from the repository root on the PR head.

### 1. Generated-fixture audit (AC3)

```
$ npm run check:local-state

self-test: healthy fixture (expect PASS)
  [PASS] No plaintext credentials
  [PASS] Private file and directory modes
  [PASS] Encrypted editor hot-exit recovery snapshots  (1 recovery snapshot sealed as a hot-exit vault entry)
  [PASS] Encrypted Memory Vault content      (11 text values across 7 audited columns + 1 embedding sealed)
  [PASS] Encrypted Local Knowledge content   (marker + sealed key probe + scope verified; plaintext lexical FTS projection scanned)
  [PASS] Protected Evidence / Quality-Intelligence artifacts
        (evidence manifest + QI manifest + candidate artifact + PE manifest + Figma snapshot JSON/PNG + sealed Figma vault)
  [PASS] Runtime store integrity residue     (no unresolved DB or QI quarantine artifacts)
  => PASS
self-test: drifted fixture (expect FAIL)
  [FAIL] No plaintext credentials            (plaintext apiKey injected into keiko.config.json)
  [FAIL] Private file and directory modes     (capsules.db loosened to 0o644)
  [PASS] Encrypted editor hot-exit recovery snapshots
  [PASS] Encrypted Memory Vault content
  [PASS] Encrypted Local Knowledge content   (scope marker verified; plaintext lexical FTS projection scanned)
  [PASS] Protected Evidence / Quality-Intelligence artifacts
  [PASS] Runtime store integrity residue
  => FAIL
self-test: drift detected in classes: credentials, file-modes
local-state: PASS
```

### 2. `keiko repair --dry-run` over a healthy and a drifted fixture (AC4)

```
######## keiko repair --dry-run : HEALTHY fixture (exit 0) ########
Keiko repair
  [ok] UI process state: no pid file recorded
  [ok] State directory: permissions are 0o700
  [ok] Runtime state artifacts: 14 artifact(s) have owner-only permissions
  [ok] Launcher records: no shortcuts recorded
  [ok] Gateway config: valid JSON at <fixture>/healthy/.keiko/keiko.config.json
  [ok] Credential storage: no plaintext credentials in config
Keiko repair: system is healthy.

######## keiko repair --dry-run : DRIFTED fixture (exit 1) ########
Keiko repair
  [ok] State directory: permissions are 0o700
  [would-fix] Runtime state artifacts: 1 Local Knowledge store artifact(s) group/world-readable (e.g. local-knowledge/default/capsules.db 0o644)
  [ok] Gateway config: valid JSON at <fixture>/drifted/.keiko/keiko.config.json
  [action] Credential storage: plaintext credentials present in config — start `keiko ui` to migrate them into encrypted storage
Keiko repair: review the items marked `action` above.
```

(Install-layout and launch-path checks are environmental and orthogonal to state confidentiality; in
the capture above the UI static export is stubbed so the dry-run exit code reflects only the state
classes.)

### 3. Regression test (AC3 + AC4, under `ci`)

```
$ npx vitest run scripts/__tests__/check-local-state.test.mjs
 Test Files  1 passed (1)
      Tests  67 passed (67)
```

## Known limitations (carried into the contract and README)

- Local encryption protects data at rest only. It does not defeat malware running as the same user, a
  live compromised Keiko process, or a stolen machine on which the OS keychain is already unlocked —
  open stores decrypt content in process memory by necessity.
- The keyfile key tier stores the key beside the ciphertext; regulated deployments should prefer an
  injected `KEIKO_*_KEY` (from a secrets manager) or the OS keychain.
- Cleartext metadata leaks the shape of stored data, not its content.
- The read-only auditor confirms the Local Knowledge encryption marker, verifies that the
  key-verification probe is present and sealed (`kv1.` envelope), and checks every populated
  reconstructive Local Knowledge column for sealed values. It does not decrypt the probe (no key is
  supplied by design), so the store's own fail-closed read path (#1322) remains the runtime guarantee
  for wrong-key or hand-tampered probe detection.
- Customer-reconstructive evidence artifacts are not yet encrypted at rest (documented deferral,
  ADR-0048); compensated by owner-only permissions, redaction, and bounded retention.
- Filesystem unlinking does not guarantee secure erasure of SSD-backed data; full-disk encryption
  remains the host's responsibility.

## Deferred follow-ups (not Epic #1319 blockers)

- Encryption at rest for customer-reconstructive evidence (`.candidates.json`, Figma snapshots) —
  tracked by the ADR-0048 deferral; the atomic write boundary is preserved as the cipher seam.
- A persistent audit ledger for startup retention purges (keiko-server has none today).
