# ADR-0010: Audit Ledger and Evidence Manifests

## Status

Accepted

Implemented in `src/audit/**` (issue #10). Three refinements landed during implementation and are
reflected below: (1) **Defense-in-depth redaction is deep field-wise, not serialized-string.** The
builder is redacted-by-construction (primary); the DiD pass in `persist.ts` re-applies the redactor
to **every string leaf** of the assembled manifest object via a generic recursive walk **before**
`JSON.stringify` (superseding D3's "re-runs the redactor over the serialized JSON string" wording).
A serialized-string pass could miss JSON-escaped secrets and risk corrupting the document; the
field-wise walk is idempotent and cannot break JSON structure. (2) **The harness is left
unedited.** The reuse-unchanged rule is absolute (zero edits to
`src/{gateway,harness,workspace,tools,verification,workflows}`), so `runAgent`/`createSession` are
NOT modified (superseding any D9/D11 wording implying an edit to `runAgent`). The "SDK runs write
evidence" requirement is satisfied at the CLI layer (`keiko run` writes by default via a tee
EventSink + `MemoryEventSink.collectManifest`) and by the supported SDK persist entry
`persistEvidence(input, deps)` exported from the audit layer. (3) **CLI tests never write into the
repo tree.** `runAgentCli`/`runEvidenceCli` take a `deps` injection point (mirroring
`runGenTestsCli`) so every test that exercises evidence writes to an injected in-memory
`EvidenceStore` or an OS `mkdtemp` dir cleaned up in `afterEach`, or passes `--no-evidence`; `.keiko/`
is added to `.gitignore` (D4).

## Context

Issue #10 adds the first persistent artifact surface in Keiko: an audit ledger that turns a
single agent run into a redacted, versioned, replay-stable **evidence manifest** written to the
local filesystem, plus an index/list API and retention controls. In a regulated banking and
insurance environment, evidence is the contract between Keiko and a human reviewer: it must be
complete enough to justify a change, redacted enough to be safe to share, and stable enough
across versions to support replay and regression triage. Cost and usage are first-class evidence,
because enterprise pilots are evaluated against operational predictability, not only output
quality.

Waves #3–#9 produced everything the ledger consumes. The harness (#4) emits a versioned
`HarnessEvent` stream and a `RunManifest`/`RunResult`; the gateway (#3) owns `UsageMetadata`
(including `costClass`) and the per-model `ModelCapability` registry; the verification
orchestrator (#7) already exposes `summarizeForAudit` — an output-text-free projection of a
verification report; the safe-tool layer (#6) established the `WorkspaceWriter` write boundary
and the realpath/symlink containment gate; the workspace layer (#5) established the read-only
`WorkspaceFs` port, the lexical+realpath two-tier path boundary, and the audit-summary
excerpt-exclusion convention.

`src/audit/index.ts` is currently a one-line stub (`export const AUDIT_MODULE = "audit"`) and is
not wired into `src/index.ts`. This ADR builds out that layer. Six forces shape the design.

**Redaction-before-persist is the security crux.** `MemoryEventSink.retainsRawContent = true`
(`src/harness/sinks.ts`), so the `RunManifest`/`RunResult.events` array it collects carries **raw**
sensitive content: `reasoning:trace`.rationale/.modelResponse, `patch:proposed`.diff,
`run:completed`.report/.patchDiff, and `run:failed`.failure.detail. The emitter only redacts for
sinks that do **not** retain raw content. Therefore the audit layer is the redaction boundary for
the persisted artifact: the manifest must be **redacted by construction**, and the writer must
never receive un-redacted data. This is the single most important property of the layer.

**The reuse-unchanged rule is absolute.** Issues #3–#9 are accepted, audited, and CI-green. This
layer makes **zero** edits to `src/{gateway,harness,workspace,tools,verification,workflows}` —
provable via an empty `git diff origin/dev` over those paths. The audit layer depends **inward**
on those layers' public types and functions only. In particular, `costClass` is **not** added to
the harness `model:call:completed` event (it is recovered from the gateway capability registry at
build time, D7).

**Zero new runtime dependencies (ADR-0001, load-bearing).** Every mechanism — atomic write,
directory listing, retention deletion, realpath containment — uses Node 22 built-ins. No JSON
schema library, no UUID library, no glob library.

**A new write surface raises a new trust boundary.** Until now the only write surface was the
`WorkspaceWriter` patch path (#6). The ledger writes audit artifacts, reads them back, and deletes
old ones. Each of those is a path operation that must be contained: writes and the retention
delete must be confined to a realpath-contained base directory, and the manifest filename must
derive from a validated `runId` with no separators or `..`. Retention deletion is the single most
dangerous operation in the layer and is bounded accordingly (D6).

**Determinism is a project invariant.** No `Date.now()`/`new Date()` in `src/`. Timestamps come
from the harness events and `RunResult`; an injectable clock supplies the wall-clock fields the
report needs. Tests inject a fixed clock and an in-memory store.

**The schema is the durable contract.** The #13 UI, cross-version replay, and regression triage
all depend on the manifest shape. It is a plain-JSON, `readonly`, versioned record with an
`evidenceSchemaVersion` literal discriminant distinct from the harness event `schemaVersion`, so
a breaking change produces version `"2"` as a new member rather than mutating `"1"`.

## Decision

### D1 — Layer boundary: `src/audit/**` is a new leaf layer

We will build the audit ledger entirely under `src/audit/**`, mirroring the established
module conventions (a `types.ts` of interfaces plus frozen tables, typed errors with redacted
messages, a barrel `index.ts`). The layer is a **leaf consumer**: it imports the public types and
functions of the harness (#4), gateway (#3), and verification (#7) layers, and it is consumed by
the CLI, the SDK barrel, and the #13 UI. It imports the realpath containment primitive and the
path helpers from the workspace layer (#5).

**Reuse-unchanged invariant (explicit).** No file under
`src/{gateway,harness,workspace,tools,verification,workflows}` is modified. The acceptance gate is
an empty `git diff origin/dev -- src/{gateway,harness,workspace,tools,verification,workflows}`.
The dependency direction is strictly inward: audit → {harness, gateway, verification, workspace};
nothing in those layers depends on audit.

### D2 — Versioned `EvidenceManifest` schema

The manifest is a plain-JSON, deeply `readonly`, versioned record. Everything is
JSON-serializable; there are no class instances, no `Date` objects (timestamps are epoch-ms
numbers or ISO strings sourced from events), and no functions. Excerpts/source snapshots are
**never** included; the workspace and verification audit projections (which already exclude
file/output text) are embedded verbatim — they are not re-derived.

```typescript
// src/audit/types.ts

export const EVIDENCE_SCHEMA_VERSION = "1" as const;

// Run identity + configuration fingerprint + outcome.
export interface EvidenceRunIdentity {
  readonly runId: string;
  readonly fingerprint: string;       // the harness config fingerprint
  readonly harnessVersion: string;
  readonly taskType: TaskType;        // from #4
  readonly outcome: RunOutcome;       // from #4 RunResult
  readonly startedAt: number;         // epoch ms (from RunResult.startedAt)
  readonly finishedAt: number;        // epoch ms (from RunResult.finishedAt)
  readonly durationMs: number;        // finishedAt - startedAt
}

// Model metadata + cost class recovered from the gateway capability registry (D7).
export interface EvidenceModel {
  readonly modelId: string;
  readonly costClass: CostClass | "unknown"; // findCapability(modelId)?.costClass ?? "unknown"
}

// Per-run usage totals (pure fold over model:call:completed events — D7).
export interface EvidenceUsageTotals {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly requestCount: number;
  readonly totalLatencyMs: number;
}

// One harness state transition (from state:transition events). Counts/labels only.
export interface EvidenceStateTransition {
  readonly seq: number;
  readonly ts: number;
  readonly from: HarnessStateName; // from #4
  readonly to: HarnessStateName;
  readonly reason: string;         // redacted at build time
}

// One tool-call record (from tool:call:started/completed/failed). Metadata only — no output.
export interface EvidenceToolCall {
  readonly seq: number;
  readonly ts: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly outcome: "completed" | "failed";
  readonly durationMs?: number | undefined;       // present on completed
  readonly errorCode?: string | undefined;        // present on failed (redacted message dropped)
}

// One command-execution record (from command:executed). Counts/flags only — no args, no stdout.
export interface EvidenceCommandExecution {
  readonly seq: number;
  readonly ts: number;
  readonly executable: string;     // bare name, already allowlist-constrained
  readonly argCount: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

// Generated-patch metadata (from patch:proposed / patch:applied). Byte/file counts always;
// the diff itself ONLY under includeDiff opt-in, and ALWAYS redacted (D3).
export interface EvidencePatch {
  readonly proposed: boolean;
  readonly applied: boolean;
  readonly targetFileCount: number;     // count from patch:proposed occurrences
  readonly patchBytes: number;          // from patch:proposed
  readonly changedFiles: number;        // from patch:applied (0 if not applied)
  readonly created: number;
  readonly deleted: number;
  // Present ONLY when includeDiff === true. Redacted via the audit redaction surface (D3).
  readonly redactedDiff?: string | undefined;
}

// Optional reasoning trace (opt-in, default excluded — D8). Each entry redacted at build time.
export interface EvidenceReasoningEntry {
  readonly seq: number;
  readonly ts: number;
  readonly phase: HarnessStateName;
  readonly rationale: string;                 // redacted
  readonly modelResponse?: string | undefined; // redacted
}

export interface EvidenceManifest {
  readonly evidenceSchemaVersion: "1";
  readonly run: EvidenceRunIdentity;
  readonly model: EvidenceModel;
  readonly usageTotals: EvidenceUsageTotals;
  // Selected-context metadata: counts/paths only, NO excerpts. The #5 audit projection verbatim.
  readonly context?: AuditSummary | undefined;            // from src/workspace (ADR-0005)
  readonly stateTransitions: readonly EvidenceStateTransition[];
  readonly toolCalls: readonly EvidenceToolCall[];
  readonly commandExecutions: readonly EvidenceCommandExecution[];
  readonly patch?: EvidencePatch | undefined;             // absent when no patch events occurred
  // Verification audit summary: output-text-free, command-redacted. The #7 projection verbatim.
  readonly verification?: VerificationAuditSummary | undefined; // from src/verification (ADR-0007)
  // Final-outcome failure category (redacted message), when the run failed.
  readonly failure?: { readonly category: HarnessCode; readonly message: string } | undefined;
  // Opt-in (D8). Absent (not empty array) when includeReasoning is false.
  readonly reasoning?: readonly EvidenceReasoningEntry[] | undefined;
}
```

`TaskType`, `RunOutcome`, `HarnessStateName`, `HarnessCode` are imported from the harness;
`CostClass` from the gateway; `AuditSummary` from the workspace layer; `VerificationAuditSummary`
from the verification layer.

**Replay/diff stability.** Records carry the event `seq` (monotone within a run) so two manifests
of the same run diff cleanly and a replay consumer can reconstruct ordering. Optional sections are
`undefined`-when-absent (never an empty array masquerading as "ran but produced nothing"), so the
presence of a key is itself information. Adding a field in a future schema is backward-compatible
for readers that ignore unknown keys; a breaking change bumps `evidenceSchemaVersion` to `"2"` as
a new union member and the builder selects the version, exactly as the harness event union does.

### D3 — Redaction-before-persist composition

We will add an audit redaction surface (`src/audit/redaction.ts`) that **composes** the gateway
`redact()` (imported, never modified) with three additional sources, producing one
`AuditRedactor` the manifest builder applies to every sensitive field **before** the manifest is
constructed. The writer (D4) therefore only ever receives redacted data; it additionally
re-redacts as defense in depth.

```typescript
export interface AuditRedactionConfig {
  // Caller-supplied literal secrets, forwarded to gateway redact()'s additionalSecrets.
  readonly additionalSecrets?: readonly string[] | undefined;
  // Environment-VALUE redaction: the values (not names) of these env vars are scrubbed as
  // literals. The builder reads them from an injected env source and passes the VALUES.
  readonly redactEnvValues?: readonly string[] | undefined;
  // Configurable sensitive-output strings, scrubbed as LITERALS (escaped), never as raw regex.
  readonly sensitiveLiterals?: readonly string[] | undefined;
}

// Returns a function string -> string that applies gateway redact() with the union of all
// literal secrets (additionalSecrets ∪ resolved env values ∪ sensitiveLiterals).
export function createAuditRedactor(
  config: AuditRedactionConfig,
  env: Readonly<Record<string, string | undefined>>,
): (input: string) => string;
```

**Safe contract for (b) and (c) — ReDoS-safe by construction.** Both environment-value redaction
and configurable sensitive-output redaction are performed by passing the **literal values** to
`redact()` as `additionalSecrets`. `redact()` escapes each literal via `escapeRegExp` before
building a `RegExp`, so no caller-controlled metacharacter reaches the regex engine and no
super-linear backtracking surface is created. We do **not** accept arbitrary user-supplied regex
patterns. This satisfies the CodeQL `js/polynomial-redos` required merge gate (ADR-0002): the
audit layer introduces **no new regex** — it reuses the gateway's audited linear patterns and the
escaped-literal path only.

- (b) **Environment values.** The builder resolves the named env vars from the injected env source
  and passes their non-empty values as literals. Names are never persisted; only the values are
  scrubbed from any string that might echo them. Empty/short values are skipped (matching `redact`,
  which skips empty literals) to avoid pathological all-matching redaction.
- (c) **Configurable sensitive output.** Operator-configured literal strings (e.g. an internal
  hostname) are scrubbed the same way.

**Per-event sensitive-field map (the builder applies this exactly).** Mirrors the harness
emitter's sensitive-field map plus the env/config additions:

| Event / field | Manifest treatment |
|---|---|
| `reasoning:trace`.rationale, .modelResponse | Redacted; included **only** when `includeReasoning` (D8). |
| `patch:proposed`.diff | Redacted; included **only** when `includeDiff` (D2 `redactedDiff`). |
| `patch:proposed`.targetFile | Redacted path string (used only to count target files; not persisted as a list in the base manifest). |
| `run:completed`.report, .patchDiff | Not persisted as raw text; the report is summarised via the existing audit projections. `patchDiff` surfaces only as counts unless `includeDiff`. |
| `run:failed`.failure.detail | Not persisted; only `failure.category` + redacted `failure.message`. |
| `state:transition`.reason | Redacted. |
| `tool:call:failed`.message, `model:call:failed`.message | Dropped (only `errorCode` retained). |
| All `*.executable`, counts, exit codes, durations, token counts | Non-sensitive; passed through. |

**Redacted by construction.** The builder applies the redactor at the moment it copies a value
into the manifest. There is no intermediate "raw manifest" object. The persist orchestration (D11,
`persist.ts`) then re-applies the redactor to **every string leaf** of the assembled manifest object
— a generic recursive deep-redact walk — as a final defense-in-depth pass **before** `JSON.stringify`
(see refinement (1) in Status; this supersedes the earlier "serialized JSON string" wording). Doing
it field-wise rather than over the serialized string cannot miss a JSON-escaped secret and cannot
corrupt the JSON structure, so a builder bug that missed a field — or a secret embedded in a verbatim
`context`/`verification` summary the builder does not itself redact — cannot silently persist a
secret. This double application is idempotent (`redact` over already-redacted text is a no-op on the
redacted tokens).

### D4 — Filesystem write boundary (the new persistent artifact surface)

**(i) Default output location.** Evidence is written to `<workspaceRoot>/.keiko/evidence/` by
default — predictable, local, and inside the repository the developer already controls. It is
overridable by an `outputDir` option and by the `KEIKO_EVIDENCE_DIR` environment variable
(option takes precedence over env, env over default). A workspace-relative default is chosen over
a user-level dir (`~/.keiko`) because evidence is *about a specific repository run* and a regulated
reviewer expects it co-located with the change under review; the user-level alternative is
rejected in Alternatives.

Because the default is inside the workspace, **`.keiko/` is added to `.gitignore`** (the only
repo-file edit this ADR makes, outside `src/`) so evidence is never accidentally committed, and
**tests MUST write to an injected tmp dir** via the in-memory store or a `mkdtemp` base — never to
the repository tree.

**(ii) `EvidenceStore` PORT + node adapter.** We define a dedicated port (mirroring the #5
`WorkspaceFs` and #6 `WorkspaceWriter` pattern) so the layer is testable with an in-memory store
and all real IO is auditable in one place:

```typescript
// src/audit/store.ts
export interface EvidenceStore {
  // Persist one manifest atomically under the base dir, named <runId>.json. Returns the path.
  readonly put: (runId: string, json: string) => string;
  // List runIds present in the base dir (deterministic, sorted), reading ONLY the base dir.
  readonly list: () => readonly string[];
  // Load one manifest's raw JSON by runId, or undefined if absent.
  readonly get: (runId: string) => string | undefined;
  // Delete one ledger-created manifest by runId (used by retention, D6). No-op if absent.
  readonly delete: (runId: string) => void;
}

export function createNodeEvidenceStore(baseDir: string, fs?: WorkspaceFs): EvidenceStore;
```

We deliberately introduce a **new** port rather than reuse the #6 `WorkspaceWriter`. Although
`WorkspaceWriter` already exposes `writeFileUtf8`/`mkdirp`/`remove`/`rename` (sufficient for an
atomic temp+rename write), it has **no read or list capability**, which D5 requires. Splitting the
audit concern across `WorkspaceWriter` (write) and `WorkspaceFs` (read) would fragment one
boundary into two and leak the manifest-record vocabulary into two ports. A single
manifest-record-typed `EvidenceStore` is the cleaner boundary ("one reason to change"). The node
adapter internally uses Node 22 `fs` built-ins, exactly as `nodeWorkspaceWriter` does.

**(iii) Path containment.** The node adapter resolves and realpath-contains its base dir once at
construction using `resolveWithinWorkspace` + `assertContainedRealPath` (reused from #5/#6) against
the workspace root, creating the dir if absent. The manifest filename is **always** derived from a
**validated** `runId`: `assertValidRunId(runId)` rejects any value containing a path separator
(`/` or `\`), `..`, a NUL byte, or a leading dot, accepting only a bounded `[A-Za-z0-9._-]` set
with a length cap — so a malicious `runId` cannot escape the base dir or overwrite an arbitrary
file. The file path is `join(baseDir, runId + ".json")` and is re-checked to remain within the
realpath-contained base dir before any write or delete.

**(iv) Atomic write.** `put` writes to a temp file (`<runId>.json.<rand>.tmp` in the same base dir,
so `rename` is same-filesystem and atomic on POSIX) then `rename`s it over the final name. A
partial write never appears under the final name. The temp name's random suffix comes from an
injected `IdSource`/RNG so tests are deterministic.

**(v) Test isolation.** All unit tests inject the in-memory `EvidenceStore`. The single
integration test that exercises the node adapter writes under an OS-temp `mkdtemp` base dir and
cleans up in `afterEach`; it never writes under the repository tree.

**Honest trust boundary.** The ledger guarantees that artifacts are confined to the contained base
dir and are redacted by construction. It does **not** guarantee tamper-evidence or immutability:
the files are ordinary developer-writable files (out of scope per the issue — no immutable-ledger
infrastructure). It does not encrypt at rest. The protection is confinement + redaction +
`.gitignore`, not cryptographic integrity.

### D5 — Evidence index/list API

`listEvidence(store): readonly EvidenceListEntry[]` and `loadEvidence(store, runId):
EvidenceManifest | undefined` enumerate and load past runs reading **only** the contained base dir
via the `EvidenceStore`. They never scan arbitrary workspace files and never traverse out of the
base dir.

```typescript
export interface EvidenceListEntry {
  readonly runId: string;
  readonly taskType: TaskType;
  readonly outcome: RunOutcome;
  readonly startedAt: number;
  readonly finishedAt: number;
}
```

`listEvidence` uses the store's deterministic `list()` (sorted by `runId`, which is stable) and
reads a small header projection from each manifest. `loadEvidence` parses one manifest's JSON;
because the persisted JSON is redacted by construction (D3), the loaded data is
**redacted-by-construction** — there is no un-redaction path. A manifest whose
`evidenceSchemaVersion` is not a recognised version is reported with a typed error, not silently
coerced. This is the #13 UI seam: the UI lists runs and loads one without bypassing redaction or
the workspace boundary.

### D6 — Retention and rotation

Default policy: **keep the most-recent N manifests** (`DEFAULT_RETENTION = { maxRuns: 50 }`),
applied after each successful `put`. We choose a count cap over a byte/age cap as the default
because it is the simplest predictable bound and a developer's local evidence dir grows by run
count; byte and age caps are offered as configurable alternatives but not the default.

```typescript
export interface RetentionPolicy {
  readonly maxRuns?: number | undefined;   // delete oldest beyond this count
  readonly maxAgeMs?: number | undefined;  // delete manifests older than this (by finishedAt)
  readonly maxTotalBytes?: number | undefined; // delete oldest until under this byte cap
  // Explicit opt-out: when disabled, the ledger never deletes.
  readonly disabled?: boolean | undefined;
}
```

**Deletion safety (load-bearing).** Retention deletes **only** files the ledger created — those
matching the `<runId>.json` naming where `runId` passes `assertValidRunId` — inside the contained
base dir, via `EvidenceStore.delete`. It is bounded (it computes the delete set, then deletes that
set; it does not recurse), it never follows symlinks (the node adapter `lstat`s and skips any
entry that is a symlink), and it never operates on a path outside the base dir. "Oldest" is
determined by reading the `startedAt`/`finishedAt` header from each manifest, not by filesystem
mtime (which a developer touch could perturb). When `disabled`, deletion is a no-op. The policy and
the configuration knobs are documented in the evidence-boundaries doc.

### D7 — Usage/cost aggregation

`aggregateUsage(events): EvidenceUsageTotals` is a **pure fold** over the `model:call:completed`
events:

```
promptTokens     = Σ usage.promptTokens
completionTokens = Σ usage.completionTokens
requestCount     = count of model:call:completed events
totalLatencyMs   = Σ usage.latencyMs
```

`costClass` is recovered as `findCapability(modelId)?.costClass ?? "unknown"` (the gateway export),
**not** from the event — the harness `model:call:completed` event omits `costClass` by design and
we do **not** add it (no #4 edit). One model per run is assumed (the `RunManifest.modelId` /
`run:started`.modelId is single-valued). The multi-model caveat is documented: if a future run
mixes models, `EvidenceModel.costClass` reflects the run's declared model and per-call cost
attribution would need a schema extension. This is stated as a known limitation, not silently
mis-aggregated.

### D8 — Reasoning trace (opt-in)

`includeReasoning` (default `false`). When `false`, the `reasoning` section is **omitted entirely**
("without inflating manifests by default") — the manifest key is absent, not an empty array. When
`true`, each `reasoning:trace` event becomes an `EvidenceReasoningEntry` with `rationale` and
`modelResponse` passed through the audit redactor (D3). This is the only path by which model
free-text reaches a persisted artifact, and it is gated and redacted.

### D9 — Final-report integration and CLI/SDK surface

**Report payload.** `buildEvidenceReport(manifest, location): EvidenceReport` produces a structured,
JSON-serializable payload, and `renderEvidenceReport(report): string` renders it for the CLI:

```typescript
export interface EvidenceReport {
  readonly evidenceLocation: string;   // the written manifest path (or base dir)
  readonly runId: string;
  readonly fingerprint: string;        // configuration fingerprint
  readonly taskType: TaskType;
  readonly outcome: RunOutcome;
  readonly changedFiles: number;       // from manifest.patch (0 when no patch)
  readonly usageTotals: EvidenceUsageTotals;
  readonly costClass: CostClass | "unknown";
  readonly verificationStatus: VerificationStatus | "not-run";
  readonly knownLimitations: readonly string[]; // static text describing Wave-1 evidence bounds
}
```

**CLI — `keiko run` writes evidence by default.** `keiko run` currently uses `CliEventSink` and
makes zero fs writes. This ADR threads a `MemoryEventSink` alongside (or a tee that both renders to
CLI and collects), assembles a `RunManifest`/`RunResult`, builds the manifest via the audit layer,
and writes it to the default base dir — then prints the `EvidenceReport`. New flags:
`--no-evidence` (disable writing), `--evidence-dir PATH` (relocate), `--include-reasoning`,
`--include-diff`. Default remains dry-run; evidence writing is on by default because evidence is
the product value.

**CLI — new `keiko evidence` subcommand** registered in `runner.ts` `dispatchCommand` and added to
`HELP_TEXT`:
- `keiko evidence list` — print the `EvidenceListEntry[]` (text or `--json`).
- `keiko evidence show <runId>` — print one `EvidenceReport` / full manifest (`--json`).
- `--evidence-dir PATH` overrides the base dir. Exit codes 0/1/2 per the existing convention
  (2 for usage errors such as an invalid `runId` or missing subcommand).

**SDK exports + name-collision discipline.** The root barrels (`src/index.ts`, `src/sdk/index.ts`)
already host two `summarizeForAudit` names (workspace canonical + verification aliased) and the
two workflow event families. The audit layer's exports are chosen to **not collide**:

- `buildEvidenceManifest`, `createAuditRedactor`, `createNodeEvidenceStore`,
  `createInMemoryEvidenceStore`, `aggregateUsage`, `listEvidence`, `loadEvidence`,
  `applyRetention`, `buildEvidenceReport`, `renderEvidenceReport`, `assertValidRunId`,
  `EVIDENCE_SCHEMA_VERSION`, `DEFAULT_RETENTION`, and the types
  (`EvidenceManifest`, `EvidenceStore`, `EvidenceReport`, `EvidenceListEntry`, `RetentionPolicy`,
  `AuditRedactionConfig`, plus the `Evidence*` record interfaces).
- None of these names is exported by any existing layer. In particular the layer does **not**
  export a bare `summarizeForAudit` or `redact` (it composes them internally). The audit barrel is
  surfaced with an explicit named re-export block (not `export *`) at both root barrels, matching
  the workflow precedent, to keep the surface auditable.

`src/index.ts` and `src/sdk/index.ts` each gain an explicit `export { … } from "./audit/index.js"`
(respectively `"../audit/index.js"`) block.

### D10 — Determinism

No `Date.now()`/`new Date()` in `src/audit/**`. The manifest's timestamps come from the events and
`RunResult` (`startedAt`/`finishedAt`/per-event `ts`). Any wall-clock value the report needs (none
are required beyond what events supply) and the temp-file random suffix come from injected
dependencies: an `EvidenceDeps` object carrying `env`, `store?`, `idSource?`, and (if needed) a
`now?: () => number`. Following the #8/#9 workflow precedent, the audit layer uses a bare
`now?: () => number` seam rather than the harness `Clock` interface, for consistency with the
sibling workflow layers it sits beside; tests inject a fixed function and an in-memory store.

### D11 — Scope fence

**In scope (core).** Build → redact → persist → index an `EvidenceManifest` from a harness
`RunResult`/`RunManifest` plus an optional `VerificationReport` (summarised via #7
`summarizeForAudit`) and an optional `ContextPack` audit summary (via #5 `summarizeForAudit`),
wired into `keiko run` and the `runAgent` SDK entry, with the `keiko evidence` list/show
subcommand.

**Out of scope (stated).** Centralized/cloud audit storage; tenant management/RBAC/admin UI;
immutable-ledger / tamper-evident infrastructure; cross-run analytics dashboards; encryption at
rest. The issue's event sources are #4/#6/#7.

**Workflow-report persistence — documented extension point, biased OUT.** The #8/#9 workflows
(`UnitTestWorkflowReport`, `BugInvestigationReport`) produce their own `WorkflowEvent` families and
already-redacted reports, not a harness `RunResult`. Persisting them through the ledger is a
**documented extension point**, not Wave-1 scope: it would require a second build entry that maps a
`WorkflowEvent` stream + workflow report into an `EvidenceManifest` variant, expanding the schema
and the event-source surface beyond the issue's stated #4/#6/#7 sources. We bias OUT to avoid >2×
scope creep. The schema's optional sections and the `EvidenceStore` port are intentionally shaped
so a follow-up issue can add a `buildEvidenceManifestFromWorkflow(...)` entry without changing the
store, the redactor, the index API, or the retention logic. This is flagged for the coordinator.

### D12 — Module file plan, public exports, and tests

**Module file plan (`src/audit/**`, each ≤ 400 LOC, functions ≤ 50 LOC, complexity ≤ 10):**

| File | Responsibility |
|---|---|
| `types.ts` | All `Evidence*` interfaces, `RetentionPolicy`, `AuditRedactionConfig`, `EvidenceDeps`, and the frozen `EVIDENCE_SCHEMA_VERSION` / `DEFAULT_RETENTION` tables. No runtime logic beyond frozen tables. |
| `errors.ts` | Typed errors with redacted messages: `EvidenceSchemaError` (unknown `evidenceSchemaVersion`), `InvalidRunIdError`, `EvidenceWriteError`. Mirrors the layer-local error pattern. |
| `redaction.ts` | `createAuditRedactor(config, env)` — composes gateway `redact()` with env-value + literal sources (D3). No new regex. |
| `aggregate.ts` | `aggregateUsage(events): EvidenceUsageTotals` — pure fold (D7); `resolveCostClass(modelId): CostClass \| "unknown"` via `findCapability`. |
| `build.ts` | `buildEvidenceManifest(input, deps): EvidenceManifest` — the redacted-by-construction builder mapping a `RunResult`/`RunManifest` (+ optional verification/context summaries) into the manifest, applying the per-event field map (D2/D3/D7/D8). |
| `runid.ts` | `assertValidRunId(runId): void` (pure, bounded char-class validation — D4 iii). |
| `store.ts` | `EvidenceStore` port; `createNodeEvidenceStore(baseDir, fs?)` (atomic temp+rename, realpath-contained, no-symlink-follow); `createInMemoryEvidenceStore()` for tests. |
| `index-api.ts` | `listEvidence`, `loadEvidence`, `EvidenceListEntry` (D5). |
| `retention.ts` | `applyRetention(store, policy)` — bounded, deletion-safe (D6). |
| `report.ts` | `buildEvidenceReport(manifest, location)`, `renderEvidenceReport(report)` (D9). Pure. |
| `persist.ts` | `persistEvidence(input, deps): { manifest, location, report }` — the top-level orchestration: build → store.put → applyRetention → buildEvidenceReport. The single entry the CLI/SDK call. |
| `index.ts` | Barrel re-exporting the public surface. |

**Public export list** (surfaced via `src/index.ts` and `src/sdk/index.ts` explicit blocks):
`buildEvidenceManifest`, `persistEvidence`, `createAuditRedactor`, `createNodeEvidenceStore`,
`createInMemoryEvidenceStore`, `aggregateUsage`, `resolveCostClass`, `listEvidence`,
`loadEvidence`, `applyRetention`, `buildEvidenceReport`, `renderEvidenceReport`,
`assertValidRunId`, `EVIDENCE_SCHEMA_VERSION`, `DEFAULT_RETENTION`, and the types
`EvidenceManifest`, `EvidenceStore`, `EvidenceReport`, `EvidenceListEntry`, `RetentionPolicy`,
`AuditRedactionConfig`, `EvidenceDeps`, `EvidenceRunIdentity`, `EvidenceModel`,
`EvidenceUsageTotals`, `EvidenceStateTransition`, `EvidenceToolCall`,
`EvidenceCommandExecution`, `EvidencePatch`, `EvidenceReasoningEntry`.

**Test plan outline:**

- **Unit — schema build** (`build.test.ts`): a canned `RunResult` with the full event mix →
  assert every section maps correctly; absent sections are `undefined`; `seq` preserved; optional
  `reasoning`/`redactedDiff` present only under their opt-ins.
- **Unit — redaction matrix** (`redaction.test.ts`): a table covering Bearer headers, `sk-` API
  keys, GitHub/AWS/Slack/Google tokens, PEM header, an **environment value** (injected env var
  whose value appears in a `reasoning:trace` rationale and is scrubbed), an authorization header,
  and a configured literal — each asserted `[REDACTED]` in the built manifest. Plus an idempotence
  case (redacting twice equals redacting once).
- **Unit — aggregation** (`aggregate.test.ts`): multiple `model:call:completed` events → assert the
  four totals; `resolveCostClass` returns the registry value and `"unknown"` for an unregistered id.
- **Unit — retention deletion-safety** (`retention.test.ts`): `maxRuns` deletes the oldest beyond
  the cap and only `<runId>.json` files; a symlink entry in the base dir is never followed/deleted;
  `disabled` is a no-op; `maxAgeMs`/`maxTotalBytes` variants.
- **Unit — path containment / traversal** (`runid.test.ts`, `store.test.ts`): `assertValidRunId`
  rejects `..`, `/`, `\`, NUL, leading dot, over-length, and accepts a normal id; the node store
  refuses to write/delete outside the base dir.
- **Unit — index/list** (`index-api.test.ts`): in-memory store seeded with manifests → `listEvidence`
  returns sorted header entries; `loadEvidence` returns the redacted manifest; an unknown
  `evidenceSchemaVersion` raises `EvidenceSchemaError`.
- **Unit — report** (`report.test.ts`): `buildEvidenceReport` populates location/runId/fingerprint/
  changedFiles/usage/costClass/verificationStatus/knownLimitations; `renderEvidenceReport` text.
- **Integration — round-trip** (`integration.test.ts`): `createNodeEvidenceStore` under an
  OS-`mkdtemp` base → `persistEvidence` writes a real `<runId>.json` atomically → `listEvidence`
  finds it → `loadEvidence` reads it back equal to the built manifest → retention prunes to the cap.
  Cleanup via `rmSync(dir, { recursive: true })` in `afterEach`. Never writes under the repo tree.

## Consequences

### Positive

- The manifest is **redacted by construction** and the writer re-redacts as defense in depth, so a
  raw secret cannot reach disk even through the `retainsRawContent` memory sink — the security crux
  is closed structurally, not by convention.
- The audit layer introduces **no new regex** and accepts **no user-supplied regex**: env-value and
  configurable-output redaction go through `redact()`'s escaped-literal path, keeping the
  `js/polynomial-redos` gate green by construction.
- Cost/usage is first-class evidence: a pure fold plus a registry lookup gives reviewers token and
  latency totals and a cost class with no harness edit.
- The `EvidenceStore` port keeps all real IO in one auditable adapter and makes the whole layer
  testable with an in-memory store and a fixed clock — deterministic, no real FS in unit tests.
- The retention path deletes only ledger-created, validated-`runId`, non-symlink files inside the
  contained base dir — the most dangerous operation is the most tightly bounded.
- A versioned, optional-section schema with `seq`-stamped records gives the #13 UI and future
  replay a stable, diff-clean contract; a breaking change bumps the version as a new member.

### Negative

- **No tamper-evidence or immutability.** Manifests are ordinary developer-writable files; a local
  actor can edit or delete them. Immutable-ledger infrastructure is explicitly out of scope. The
  controls are confinement + redaction + `.gitignore`, not cryptographic integrity.
- **No encryption at rest.** Evidence sits in plaintext JSON under `.keiko/evidence/`. Redaction
  removes known secret shapes and configured literals, but a novel secret format not matched by
  `redact()` and not configured as a literal could persist.
- **Cost attribution is per-run, not per-call.** `costClass` is the run's declared model's class;
  a multi-model run would need a schema extension. Documented, not silently mis-aggregated.
- **Redaction completeness is bounded by `redact()`.** It covers Bearer/`sk-`/GitHub/AWS/Slack/
  Google/PEM-header + supplied literals; it does not generically catch arbitrary env *values* unless
  the operator names them in `redactEnvValues`, nor the PEM key body. This inherits #6's honest
  redaction limits.
- **`includeDiff` persists redacted source.** Even redacted, a diff is source-derived; the opt-in
  default-off keeps manifests lean and avoids persisting code unless explicitly requested.
- **Workflow reports are not persisted in Wave 1.** #8/#9 outputs require a follow-up build entry;
  the schema is shaped for it but the entry is out of scope (D11).

### Neutral

- `.keiko/` is added to `.gitignore` — the only repo edit outside `src/audit/**` and the docs/CLI
  wiring. The existing `.keiko-itest-*/` entry is unrelated (the #8 integration fixture prefix).
- The layer uses a bare `now?: () => number` seam (matching #8/#9) rather than the harness `Clock`
  interface; both conventions coexist in the repo and the choice is for sibling-layer consistency.
- A dedicated `EvidenceStore` port is introduced rather than reusing `WorkspaceWriter`, because the
  index/list requirement (D5) needs read+list, which `WorkspaceWriter` lacks.
- Evidence writing is **on by default** for `keiko run` (with `--no-evidence` to disable), inverting
  the prior zero-fs-write behaviour of that command — a deliberate change, because evidence is the
  product value this issue delivers.

## Alternatives Considered

### Alternative 1: Redact in the harness emitter / a custom EventSink instead of at the audit layer

Move redaction upstream so the persisted events are already clean, or implement a redacting
`EventSink` that the harness uses.

- **Pros**: a single redaction point; the audit layer would receive only clean data; no
  defense-in-depth double pass needed.
- **Cons**: it requires editing `src/harness/**` (the emitter or a new sink), violating the
  absolute reuse-unchanged rule. The harness deliberately keeps `MemoryEventSink.retainsRawContent
  = true` so the in-memory manifest is a *faithful* replay record; redacting there would destroy
  fidelity for non-persisting consumers and couple the harness to the audit policy.
- **Why rejected**: it breaks the reuse-unchanged invariant (D1) and the harness's deliberate
  raw-retention design. The correct boundary for *persistence* redaction is the layer that
  persists. Redact-at-build + re-redact-at-write (D3) keeps the harness untouched and the persisted
  artifact safe.

### Alternative 2: Reuse the #6 `WorkspaceWriter` as the evidence write surface

Use the existing `WorkspaceWriter` port (`writeFileUtf8`/`mkdirp`/`remove`/`rename`) for the atomic
temp+rename write rather than defining a new `EvidenceStore`.

- **Pros**: zero new port; `WorkspaceWriter` already has exactly the four write ops needed and an
  audited node adapter (`nodeWorkspaceWriter`).
- **Cons**: `WorkspaceWriter` has no read or list capability, which D5's index/list API requires.
  Reading back would force a parallel dependency on `WorkspaceFs`, splitting one audit concern
  across two ports and leaking raw-byte vocabulary where a manifest-record vocabulary belongs. A
  future store backend (e.g. a single index file, or a different on-disk layout) would have to
  change two ports.
- **Why rejected**: a single manifest-record-typed `EvidenceStore` (read+write+list+delete) is the
  cleaner boundary with one reason to change. The node adapter reuses the same Node built-ins and
  the same realpath containment primitive, so nothing is lost on safety or dependency count.

### Alternative 3: User-level evidence directory (`~/.keiko/evidence`) as the default

Default the output location to a per-user home directory rather than `<workspaceRoot>/.keiko/`.

- **Pros**: survives `git clean`; no `.gitignore` change; one location aggregates evidence across
  repositories.
- **Cons**: evidence is *about a specific repository run*; a regulated reviewer expects it
  co-located with the change under review, and a per-user dir mingles unrelated repositories'
  evidence. It also reintroduces the home-directory credential-adjacency concern #6 worked to avoid,
  and it is less discoverable for a developer inspecting "what did this run produce."
- **Why rejected**: a predictable, local, workspace-relative dir is the requirement ("predictable,
  local, safe-by-default"). The `.gitignore` addition is a one-line cost; the env override
  (`KEIKO_EVIDENCE_DIR`) covers the rare cross-repo-aggregation need without making it the default.

### Alternative 4: Accept configurable redaction regexes for sensitive-output patterns

Let operators supply arbitrary regular expressions for (c) configurable sensitive-output patterns,
giving maximum flexibility to match bespoke secret formats.

- **Pros**: an operator can match any secret shape, including formats `redact()` does not know.
- **Cons**: an arbitrary user regex is exactly the `js/polynomial-redos` shape the required CI gate
  blocks; applied to attacker-influenceable content (model output, command echoes) it is a real
  ReDoS surface. Validating a regex for linearity is itself undecidable in general and fragile in
  practice.
- **Why rejected**: D3 redacts configured strings as **escaped literals** through `redact()`'s
  existing path — covering the common "redact this hostname/token literal" need with zero new regex
  and zero ReDoS surface. The flexibility loss (no pattern matching) is the correct trade for a
  regulated, fail-safe layer; a future structured-detector approach can be added without accepting
  raw regex.

### Alternative 5: Persist the full raw event array (or full message history) for perfect replay

Store the complete `RunManifest.events` verbatim (and optionally the model message array) so replay
is byte-perfect.

- **Pros**: the strongest replay fidelity; nothing is lost; debugging is maximal.
- **Cons**: the raw events carry the sensitive fields (`reasoning:trace`, `patch:proposed`.diff,
  `run:completed`.report) — persisting them verbatim is precisely the security failure this layer
  exists to prevent. The model message array additionally carries raw tool output (which #6 keeps
  out of events deliberately) and full source excerpts. It also inflates manifests massively.
- **Why rejected**: incompatible with "redacted enough to be safe to share." The schema (D2) keeps
  the replay-relevant *structure* (ordered `seq`-stamped records, counts, transitions, usage) while
  excluding raw text by construction; reasoning and redacted diffs are opt-in (D8/D2). This is the
  deliberate fidelity-vs-safety trade the regulated context demands.

## Related

- ADR-0001: Project Foundation and Toolchain — zero-runtime-dependency constraint (load-bearing);
  `src/audit/` module location; strict TypeScript/ESM/LOC limits.
- ADR-0002: CI and Supply-Chain Security Baseline — `js/polynomial-redos` gate governs D3: the
  audit layer adds no new regex and accepts no user regex (escaped-literal redaction only).
- ADR-0003: Model Gateway Boundary — `redact()` composed (not modified); `findCapability`,
  `ModelCapability.costClass`, `UsageMetadata`, `CostClass` consumed for D3/D7.
- ADR-0004: Agent Harness Boundary and State Machine — `RunResult`, `RunManifest`, `HarnessEvent`,
  `TaskType`, `RunOutcome`, `HarnessStateName`, `HarnessCode` consumed; the versioned schema mirrors
  the harness event `schemaVersion` discriminant pattern; `MemoryEventSink.retainsRawContent` is the
  reason redaction lives here. No harness edit (`costClass` recovered from the registry, not added).
- ADR-0005: Repository Context and Workspace Access Layer — `AuditSummary`/`summarizeForAudit`
  embedded verbatim (counts/paths, no excerpts); `resolveWithinWorkspace`, `assertContainedRealPath`,
  `isWithinWorkspace`, `WorkspaceFs` reused for the store's path containment.
- ADR-0006: Safe Tool Execution and Sandbox Boundary — the `WorkspaceWriter` port pattern is
  mirrored by `EvidenceStore`; the realpath/symlink containment gate is reused; the honest-limits
  framing (no tamper-evidence, no encryption at rest) follows this ADR's candour.
- ADR-0007: Verification Orchestrator and Resource Limits — `summarizeForAudit` /
  `VerificationAuditSummary` (output-text-free) embedded verbatim; `VerificationStatus` consumed.
- ADR-0008 / ADR-0009: Workflow ADRs — the workflow report/event families are a documented
  extension point for ledger persistence, biased OUT of Wave-1 scope (D11); the `now?: () => number`
  seam convention is adopted from these layers.
- Issue #10: Add audit ledger, evidence manifests, cost aggregation, and redaction controls.
- Issue #13: UI layer — consumes `listEvidence`/`loadEvidence` and the `EvidenceReport` payload.

## Date

2026-05-29
