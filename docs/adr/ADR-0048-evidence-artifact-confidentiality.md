# ADR-0048: Evidence and Quality Intelligence artifact confidentiality hardening

## Status

Accepted (Issue #1323, Epic #1319, 2026-06-20)

## Version

0.2.0

## Context

Epic #1319 introduces regulated banking and insurance pilots. Siblings #1320 (credential
vault), #1321 (repair/uninstall runtime-state), and #1322 (Local Knowledge content
encryption) established the confidentiality baseline for credentials, databases, and
document extractions. Issue #1323 closes the remaining gap: the evidence artifact layer.

Evidence artifacts under `.keiko/evidence/` and `.keiko/evidence/qi/` are produced at
run time and persist indefinitely unless explicitly purged. They fall into four
confidentiality classes that carry different risks:

1. **Customer-reconstructive** — artifacts that, if read, allow a reader to reconstruct
   customer content or IP: `.candidates.json` (full test-case bodies — title, preconditions,
   steps, expected results from `QualityIntelligenceTestCaseCandidate`), Figma snapshot
   JSON including `irJson` and `tokens`, Figma snapshot PNG side-files.

2. **Customer-metadata** — artifacts whose fields are derived from customer content but
   carry only redacted summaries and content-free identifiers: QI run manifests
   (`.qi.json`), Prompt Enhancement manifests (`.pe.json`). These are
   redacted-by-construction and integrity-hashed.

3. **Process evidence** — standard run manifests (`.json` under `evidence/`) carrying
   redacted workflow summaries and structured audit trails.

4. **Operational** — lock files, temp files, sidecars.

Current gaps:

- **Permission gap (AC1):** `evidence/` base dir is created with no explicit mode
  (`store.ts:109 mkdirSync(baseDir, {recursive: true})` — no mode param); side-file dirs
  are similarly unguarded (`side-file.ts:58, 113`). Evidence manifest files have no
  `chmodSync` call (`store.ts:194`). Side-files have no `chmodSync` call
  (`side-file.ts:78`). QI/PE/figma-snapshot/companion stores DO set `0o700`/`0o600`
  correctly — this is an evidence-store-only gap.

- **Encryption gap (AC2):** No artifact class is encrypted at rest beyond credentials
  (ADR-0046) and Local Knowledge (ADR-0047). `.candidates.json` bodies are plaintext.
  Figma snapshot JSON and PNG files are plaintext.

- **Retention gap (AC4):** `applyQualityIntelligenceRetention` is a pure decision
  function that is **never called by any orchestrator** — confirmed by exhaustive grep
  across all packages. `enforceFigmaSnapshotRetention` is likewise never called outside
  its own tests. Retention policy IDs on QI manifests are therefore passive metadata.
  Regular evidence `applyRetention` is called only at persist time via `persist.ts:57`.

- **Repair gap (AC5):** `keiko repair` via `checkRuntimeStateArtifacts` already walks
  the full state tree including `evidence/` and `evidence/qi/`, thanks to
  `state-paths.ts:126–129` which enumerates `EVIDENCE_SUBDIR`, `QI_SUBDIR`, and
  `FIGMA_SNAPSHOTS_SUBDIR`. No code change is needed for AC5.

- **Documentation gap (AC6):** `docs/local-runtime-state-contract.md:17` states
  "Evidence and memory remain local machine state; neither is a hosted service" but does
  not articulate the confidentiality model, artifact classification, encryption scope, or
  retention enforcement guarantees for regulated use.

## Decision

### D1 — Artifact classification (AC1)

We classify every evidence artifact into one of the four classes above. The classification
is internal to keiko-evidence; it is not a new exported type. The canonical reference is
this ADR and the comments added to each writer module.

### D2 — Write-time POSIX mode enforcement (AC1)

We extend `keiko-evidence/src/store.ts` (`prepareBaseDir` at line 108 and `atomicWrite`
at line 188) and `keiko-evidence/src/side-file.ts` (`ensureDir` at lines 56 and 113, and
`atomicWriteBytes` at line 73) to apply the same `0o700`/`0o600` pattern already present
in `qualityIntelligence/store.ts:104,193` and `companionStore.ts:48,98`.

The pattern, copied verbatim from `qualityIntelligence/store.ts`, is:

- `mkdirSync(dir, {recursive: true, mode: 0o700})`. No separate post-mkdir
  `chmodSync(dir, 0o700)` is added: a directory mode is only masked by `umask`, and `0o700`
  sets no group/other bits, so `umask` cannot loosen it. A pre-existing directory created by
  an earlier build with a looser mode is remediated by `keiko repair` (AC5, D6), not at write
  time — the same division of labour the QI/PE/companion/figma-snapshot stores already use.
- `chmodSync(temp, 0o600)` after `writeFileSync` and before `renameSync`, inside a try-catch
  that is non-fatal on non-POSIX (matching the existing QI pattern; `rename` preserves the mode).

`chmodSync` is added to the `node:fs` import of `store.ts` and `side-file.ts`. Zero new
package-graph edges.

### D3 — Encryption at rest: documented deferral with bounded retention (AC2)

For **customer-reconstructive** artifacts:

- **`.candidates.json`** (written by the QI candidate pipeline): bounded retention via
  `QI_EVIDENCE_OWNED_COMPANION_SUFFIXES` in `retention.ts:39` already sweeps it on
  deletion. The deferral condition is: retention purge becomes deterministic (D5 below).
  Encryption is deferred pending a future issue once per-artifact key management is
  designed. Rationale: the candidates file is already redacted before write
  (`redactQualityIntelligenceEvidence` at `store.ts:590`) and has a short lifetime
  bounded by the parent run's retention policy.

- **Figma snapshot JSON + PNG side-files**: contain design IR and screenshots. These
  carry the highest reconstruction risk. Encryption is deferred to a follow-up issue.
  The deferral condition is: `enforceFigmaSnapshotRetention` becomes deterministically
  wired (D5 below). Figma-snapshot retention is count-based (`maxRecords`, evict oldest by
  `fetchedAt`; figma snapshots carry no retention-policy id) with a bounded, configurable
  default of `500`.

The deferral is explicit and documented; the issue brief authorizes "documented
bounded-retention deferral" as an alternative to immediate encryption. This ADR is that
documentation.

This decision is **reversible**: the atomic-write boundary (temp + rename) in every
evidence writer is the natural seam to introduce a cipher at a later date, mirroring
the LK `StoreContentCipher` pattern from ADR-0047 D1.

### D4 — Integrity hashes and redaction survive hardening (AC3)

No change to the integrity hash or redaction paths. Permission hardening (D2) applies
after content is written; it does not touch the JSON payload. The hash is computed over
the redacted manifest object before `JSON.stringify` in `recordQualityIntelligenceRun`
(`store.ts:609–616`) and `buildIntegrityHashes` — chmod does not affect it.

### D5 — Deterministic retention purge (AC4)

`applyQualityIntelligenceRetention` and `enforceFigmaSnapshotRetention` are exported but
have no production call site. We wire them deterministically:

- **QI run retention**: keiko-evidence gains a new leaf-clean orchestrator
  `enforceQualityIntelligenceRetentionPolicy({evidenceDir, now, companionSuffixes, sideFileRoot})`.
  It lists the QI store, builds a snapshot from each manifest's `retentionPolicyId` and
  `completedAt ?? planAt`, calls the pure `applyQualityIntelligenceRetention`, deletes each
  `expiredRunId` through the unchanged hardened `deleteQualityIntelligenceRun`
  (realpath-contained, symlink-refusing), and returns the deletion receipts. It never calls
  the audit ledger (keiko-evidence is a leaf — ADR-0019 trust-rule 6). It is **fail-safe**:
  a run is RETAINED on any uncertainty — an unknown `retentionPolicyId`, a newest-N slot, a
  manifest load error or integrity/tamper throw, or an unparseable/missing timestamp.
  keiko-server wraps it in `enforceQiRetentionAtStartup` and calls it once from
  `buildUiHandlerDeps` with `SERVER_OWNED_COMPANION_SUFFIXES` and the figma side-file root.
  This is NOT a background timer (a `setInterval` would race the filesystem-backed store) —
  it runs lazily, once per server instance, and is best-effort: it never throws into
  bootstrap, so a transient fault simply re-runs next start.

  Audit visibility: keiko-server has no persistent QI audit ledger today (the user-initiated
  DELETE route forwards its receipt by returning it in the HTTP response). The startup-purge
  helper forwards each receipt's audit event to an **injectable sink whose default is a
  no-op**, so production startup-purge receipts are currently **dropped**. The injectable
  sink is the single wiring point for a future audit-ledger; see the Negative consequences.

- **Figma snapshot retention**: `enforceFigmaSnapshotRetention` is count-based (`maxRecords`,
  evict oldest by `fetchedAt`; figma snapshots carry no retention-policy id). It is called
  from the figma-snapshot store's once-per-instance `ensureSwept` closure, alongside the
  existing `sweepOrphanedSideDirs` call. The default cap is
  `DEFAULT_FIGMA_SNAPSHOT_MAX_RECORDS = 500` (matching the `qi:standard-90d` profile's
  `maxRunArtifacts`) — a bounded value chosen so a normal local fixture set is never silently
  purged; it is configurable via `FigmaSnapshotStoreOptions.retention.maxRecords`, and a
  non-positive cap disables eviction.

Retention policy IDs on existing manifests are not migrated; unknown IDs are retained
(forward-compat, already guaranteed by `retention.ts:106–108`).

### D6 — keiko repair: no new code needed (AC5)

`checkRuntimeStateArtifacts` in `repair.ts:219` already:

1. Calls `scanRuntimeState(stateDir)` which walks `evidence/` (via `evidenceSubtree`)
   and `evidence/qi/` (via `qiSubtree`) including `figma-snapshots/` (via
   `figmaSnapshotsSubtree`).
2. Calls `tightenNodes` which `statSync`s each node, compares mode to expected
   `0o700`/`0o600`, and chmods without reading file content.
3. Reports "Runtime state artifacts" findings with path + observed mode only —
   content-free.

No new code is required for AC5. The only gap is that write-time modes (D2) are not
currently enforced, so repair may find and fix them at first run post-#1323.

### D7 — Documentation (AC6)

We extend `docs/local-runtime-state-contract.md` with:

- An explicit artifact classification table (the four classes from D1).
- A statement that evidence artifacts are local machine state, not a hosted compliance
  archive: retention is local-only, no remote sync, no disaster-recovery guarantee.
- The encryption deferral rationale (D3) and the expected follow-up issue.
- Platform note: POSIX mode enforcement is best-effort on non-POSIX filesystems (Windows,
  NFS); `keiko repair` detects and remediates drift on supported filesystems.

## Consequences

### Positive

- Evidence and side-file directories created with `0o700`; files created with `0o600`
  intent — consistent with QI/PE/companion/figma-snapshot stores (which already do this).
- `keiko repair` will find zero or minimal permission drift on artifacts created after
  this issue, rather than correcting hundreds of `0o644` files from prior runs.
- QI retention becomes operational: expired runs are purged on server startup instead
  of accumulating indefinitely.
- Figma snapshot retention becomes operational with a bounded `maxRecords=500` default
  (`DEFAULT_FIGMA_SNAPSHOT_MAX_RECORDS`). `ensureSwept` runs at the head of read ops too, so the
  count-cap eviction can fire on a load/list, not only on write; it is best-effort (a transient
  eviction fault is swallowed, never surfacing as a read error).
- The encryption deferral is explicitly documented with the conditions under which it can
  be lifted.

### Negative

- `.candidates.json` bodies and Figma snapshot JSON/PNG remain plaintext. A local file
  system read (e.g., `cat .keiko/evidence/qi/<runId>.candidates.json`) exposes
  generated test bodies. The mitigating control is bounded retention + `0o600` file mode.
- Startup-time QI retention adds latency proportional to the number of expired runs on
  first invocation after a long idle period. This is bounded by `maxRunArtifacts`
  (100/500/2000 per profile) and expected to be sub-second.
- Production startup-purge receipts are currently dropped: the default audit sink is a no-op
  because keiko-server has no persistent QI audit ledger today. The startup purge is
  therefore deterministic but not yet attested in an audit trail. The injectable sink is the
  single wiring point; wiring it to a persistent ledger is a tracked follow-up, not a blocker
  for this issue (the user-initiated DELETE route has the same limitation today).
- The fail-safe (retain-on-uncertainty) guarantee covers only _uncertainty_ — an unknown
  policy id, a newest-N slot, an unreadable/tamper-failing manifest, or a missing timestamp.
  It does NOT add an "always keep the newest run regardless of age" floor: a store whose runs
  all carry a short policy (`qi:short-30d`) and that is left idle past `retainedDays` will have
  every run age-expire, so the next startup purges the whole store. This is the operator's own
  stamped policy applied deterministically, not a defect; a retain-newest-regardless-of-age
  floor is a possible future product decision, out of scope here.
- `chmodSync` calls are non-fatal on Windows and silently no-op. `keiko repair` reports
  this rather than treating it as an error, consistent with #1321.

### Neutral

- Zero new package-graph edges. All changes are within `keiko-evidence` (permission
  hardening, Figma retention wiring) and `keiko-server` (QI retention wiring). Neither
  imports a new dependency.
- Test suites for `store.ts` and `side-file.ts` must be extended to assert `0o700`/`0o600`
  post-write on POSIX (skipped on `process.platform === "win32"`). Existing QI tests
  already assert dir mode implicitly; they need no change.

## Alternatives Considered

### Alternative 1: Immediate encryption for all customer-reconstructive artifacts

Encrypt `.candidates.json`, Figma snapshot JSON, and PNG files at write time using
`sealString`/`openString` from `keiko-security/secretbox.ts`.

- **Pros**: Eliminates file-system read risk for highest-sensitivity artifacts.
- **Cons**: Requires per-artifact key management design (which env var? which keychain
  service? separate from `KEIKO_PROVIDER_CREDENTIALS_KEY`?). Figma PNG encryption
  requires deciding between wrapper file (breaks MIME preview) or in-place binary
  envelope (breaks standard tools). Read-side decryption must be threaded through every
  BFF route that serves candidates or Figma screenshots. Adds complexity proportional
  to ADR-0047 but without the clean SQLite column abstraction.
- **Why rejected**: The issue brief explicitly authorizes "documented bounded-retention
  deferral." The complexity cost is not justified at this stage because: (a) `0o600`
  mode limits exposure to the file owner, (b) bounded retention limits the time window,
  (c) the write boundary is preserved for a future cipher seam. Deferral is reversible.

### Alternative 2: Whole-file encryption for evidence manifests

Seal the entire `JSON.stringify(manifest)` result with `sealString` and write the
ciphertext blob as the file content.

- **Pros**: Uniform: no field-level classification needed.
- **Cons**: The entire file becomes opaque to `keiko repair`, `grep`, debugging tools,
  and the retention header reader (`retention.ts:readHeader` which parses `finishedAt`).
  The BFF read path and the CLI `keiko report` command must both resolve a key before
  reading any evidence file. Key loss is unrecoverable without backup.
- **Why rejected**: Evidence manifests are already redacted-by-construction and
  integrity-hashed. The confidentiality model for these is "owner-only file access" +
  "redacted content," not "encrypted file." Whole-file encryption would break the
  existing retention, repair, and reporting tooling.

### Alternative 3: Background retention timer

Run `applyQualityIntelligenceRetention` on a periodic `setInterval` in the server
process.

- **Pros**: Guaranteed eventual enforcement regardless of request rate.
- **Cons**: Introduces a background timer with potential for concurrent mutation against
  the same filesystem-backed store. The QI store does not use a database lock; concurrent
  deletes and reads on the same `<runId>.qi.json` are not protected beyond the atomic
  write seam. Adds process complexity; tests must mock timers.
- **Why rejected**: Startup-time enforcement (D5) is simpler, deterministic, and
  consistent with `sweepOrphanedSideDirs` (already lazy-once-per-instance).

## Threat model and limitations

**Defeats:** casual disk inspection of evidence and QI artifacts (owner-only `0o600`/`0o700`
modes), secret leakage into persisted records (redaction before persist), undetected modification of
QI manifests (SHA-256 integrity hashes verified on read), and unbounded accumulation
(deterministic, fail-safe retention purge).

**Does not defeat (honest limitations):**

- Customer-reconstructive evidence (`<runId>.candidates.json`, Figma snapshot JSON/PNG) is **not yet
  encrypted at rest** (D3). On a copied or synced `.keiko`, or on a machine an attacker can read as
  the same user, the compensating controls are owner-only permissions, redaction, and bounded
  retention only — not confidentiality of the content itself. Encryption remains the documented next
  step; the atomic write boundary is preserved as the seam to introduce a cipher.
- Integrity hashes are tamper-**evident**, not tamper-**proof**: an attacker who can rewrite both the
  artifact and its hash is not stopped, only detected on a faithful read.
- Startup retention purges are deterministic but not yet attested in a persistent audit ledger
  (keiko-server has none today).
- These controls protect data at rest; they do not protect against a live compromised process or
  malware running as the same user.

## Related

- ADR-0010: Evidence layer design (local-first, redacted-by-construction)
- ADR-0023: Quality Intelligence migration architecture (D7/D8: local state contract)
- ADR-0035: Memory vault encryption at rest (AES-256-GCM primitive baseline)
- ADR-0046: Local credential vault (generalized key resolution seam)
- ADR-0047: Local Knowledge content encryption (cipher-at-store-boundary pattern)
- Issue #1319: Epic — regulated use confidentiality
- Issue #1320: Credential vault (sibling)
- Issue #1321: Repair/uninstall runtime-state hardening (sibling — AC5 already done)
- Issue #1322: LK encryption at rest (sibling)
- `docs/local-runtime-state-contract.md`: live artifact inventory

## Date

2026-06-20
