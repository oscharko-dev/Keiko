# ADR-0152: Substrate ownership, the unified retrieval spine, and the Knowledge M2 activation record

## Status

Accepted (maintainer decision, 2026-07-18; recorded by Issue #2565 for Epic #2556 and
program Epic #2554).

## Related decisions

- [ADR-0019](ADR-0019-modular-package-architecture.md) owns package direction and provider-SDK
  isolation. This record applies that direction to vector indexing, reranking, and evaluations.
- [ADR-0012](ADR-0012-wave-1-evaluation-harness-and-model-benchmarks.md) owns the evaluation port
  and deterministic scorecard precedent.
- [ADR-0047](ADR-0047-local-knowledge-content-encryption.md) owns Local Knowledge encryption at
  rest. This record does not widen where decrypted content or vectors may exist.
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md),
  [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md), and
  [ADR-0138](ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md) own
  authority and repository delivery. The activation record below is a scheduling deviation only.
- [ADR-0139](ADR-0139-agent-first-deterministic-quality-gates.md) D2 excludes documentation from
  the editor performance-evidence subject. D4 kept the local pre-PR gate deterministic and
  diff-scoped — but D4 has since been superseded:
  [ADR-0145](ADR-0145-retire-the-agent-pre-pr-aggregate-gate.md) retired the `agent:pre-pr` aggregate
  wrapper by owner decision. The reference above was accurate when this record was written and is
  annotated rather than rewritten; local verification now names the AGENTS.md §3 minimum-loop
  commands directly.
- [ADR-0137](ADR-0137-server-owned-coding-runtime-contracts.md) keeps coding-runtime contracts and
  authority separate from the retrieval contract generalization in this record.

## Context

Knowledge M2 must consolidate existing capability without creating parallel subsystems. The current
tree has three vector paths, four server rerank orchestrations, three evaluation harness locations,
and a coding-specific context-pack contract that is structurally useful outside coding. Moving any
one of them independently would force later children to renegotiate package ownership, dependency
direction, security posture, or wire compatibility.

The verified seams already provide the required extension points:

- Local Knowledge exposes one `VectorIndexAdapter`, checks it before built-in modes, and falls back
  when it is unavailable
  ([`vector-index.ts:47-61`](../../packages/keiko-local-knowledge/src/retrieval/vector-index.ts#L47-L61),
  [`vector-index.ts:194-201`](../../packages/keiko-local-knowledge/src/retrieval/vector-index.ts#L194-L201)).
- Memory ranking already consumes a caller-supplied semantic score map and otherwise remains a pure
  ranker
  ([`ranking.ts:87-101`](../../packages/keiko-memory-retrieval/src/ranking.ts#L87-L101)); the current
  server composition performs the linear semantic sweep
  ([`memory-retrieval-signals.ts:259-289`](../../packages/keiko-server/src/memory-retrieval-signals.ts#L259-L289)).
- Repository search already has a provider-free `SemanticSearchProvider` seam
  ([`repoSearchSemantic.ts:27-30`](../../packages/keiko-workspace/src/repoSearchSemantic.ts#L27-L30)).
  The server implementation creates a request-local vector cache
  ([`grounded-repo-semantic-search.ts:476-505`](../../packages/keiko-server/src/grounded-repo-semantic-search.ts#L476-L505))
  even though its cache key is already content-addressed
  ([`grounded-repo-semantic-search.ts:154-164`](../../packages/keiko-server/src/grounded-repo-semantic-search.ts#L154-L164)).
- Reranker consumer ports already live in their provider-free owners
  ([`conversation/types.ts:94-110`](../../packages/keiko-local-knowledge/src/conversation/types.ts#L94-L110),
  [`contextpack/reranker.ts:13-21`](../../packages/keiko-workflows/src/contextpack/reranker.ts#L13-L21)),
  while model transport and `UiHandlerDeps` are server concerns.
- `CodingContextPack` already provides bounded content-bearing and content-free projections with a
  closed purpose and source-kind vocabulary
  ([`coding-context.ts:1-64`](../../packages/keiko-contracts/src/coding-context.ts#L1-L64)).
- Local Knowledge already recognizes a real repository scope end to end
  ([`local-knowledge.ts:82-100`](../../packages/keiko-contracts/src/local-knowledge.ts#L82-L100),
  [`discovery/walk.ts:88-113`](../../packages/keiko-local-knowledge/src/discovery/walk.ts#L88-L113),
  [`indexing/orchestrator.ts:668-672`](../../packages/keiko-local-knowledge/src/indexing/orchestrator.ts#L668-L672)).

The governing objective is therefore one retrieval spine with explicit ownership, not a rewrite and
not a fourth implementation.

## Decision

### D1 — One contracts-owned vector-index port serves three closed namespaces

M2 defines exactly one `VectorIndexPort` in `@oscharko-dev/keiko-contracts`. It generalizes the
existing `VectorIndexAdapter`; no pillar may add a second index interface. Its namespace is the
closed union `knowledge | memory | repo`.

The port is candidate generation only:

- input carries the namespace, a mandatory non-empty `partitionKey`, the complete embedding
  identity, query vector, and bounded candidate limit;
- output carries candidate identifiers and finite scores, plus redacted diagnostics;
- it never returns content, performs final ranking, opens stores, or widens a scope;
- a query is confined to exactly one partition, and an implementation must not answer from a
  global or cross-partition pool; and
- `ok: false` is a normal fail-closed answer that makes the caller use its existing brute-force
  path. Activating the port may improve candidate generation but may not remove retrieval
  availability.

The partition requirement promotes the existing no-global-pool invariant
([`scoped-vector-search.ts:1-13`](../../packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.ts#L1-L13))
and the vec0 partition-key column
([`vector-index.ts:349-365`](../../packages/keiko-local-knowledge/src/retrieval/vector-index.ts#L349-L365))
into the shared contract.

The complete embedding identity key is also promoted to contracts as one canonical pure function.
The two current equivalent implementations
([`vector-index.ts:617-628`](../../packages/keiko-local-knowledge/src/retrieval/vector-index.ts#L617-L628),
[`scoped-vector-search.ts:894-909`](../../packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.ts#L894-L909))
must converge on it; a third copy is forbidden. Identity incompatibility fails closed before scores
are consumed.

`keiko-memory-retrieval` remains a pure ranker under ADR-0019 rule 3j
([`.dependency-cruiser.cjs:508-542`](../../.dependency-cruiser.cjs#L508-L542)). It continues to
receive only `semanticById`; the shared port never becomes a dependency of that package.

> **Implementation status (2026-07-20).** D1 was recorded as decided in this file but was not built
> by the children it was assigned to; a post-wave audit found `VectorIndexPort` existed only in this
> record's own prose while the wave certified a "unified substrate". What now exists in
> `keiko-contracts/src/vector-index-port.ts`: the port interface, the closed namespace union, the
> mandatory partition key, the candidate-only result with `ok: false` as a normal fail-closed answer,
> and the canonical `embeddingIdentityKey`. The two former copies in `keiko-local-knowledge` import
> it, and a repository-wide architecture test asserts the identity tuple is defined exactly once so
> the convergence cannot silently decay again.
>
> Deliberately NOT built, and deferred rather than left implied: the D3 namespace composition. No
> adapter binds `knowledge`, `memory` or `repo` to the port yet — in particular the linear loop in
> `memory-retrieval-signals.ts` `semanticScoresFrom` is untouched. Composing namespaces onto a port
> with no ANN backend behind them would be ceremony, not capability. The binding half of D1 — one
> interface so no pillar can add a second, one identity key so none can drift — is in force now; the
> wiring follows when a namespace has something to wire to.

### D2 — sqlite-vec remains dormant until its runtime is explicitly and safely configured

> **Activation record (2026-07-20).** Locks 2 and 3 below describe the PRE-activation state and are
> no longer true at the head of this wave. M2.2 discharged the activation obligation this decision
> pre-authorized: `openKnowledgeStore` passes `allowExtension: true` when — and only when — a
> vector-index runtime is configured. Lock 1 still holds exactly as written: the mode defaults to
> `disabled` and no production composition sets either environment variable, so the path stays
> opt-in.
>
> Lock 2 survives in an amended form, and deliberately so. sqlite-vec was briefly taken as an npm
> dependency and then removed: the package publishes the license string `"MIT OR Apache"`, which is
> not valid SPDX, so the dependency-review policy rejects it and the CycloneDX SBOM carries no
> license entry at all, which `check:workspace-supply-chain` rejects as `<missing>`. That second
> gate has no exception mechanism by design — "we cannot prove they are acceptable without a
> declaration" — and the repository's precedent for a license-blocked artifact is to obtain it
> directly rather than except it (the Sonar Scanner CLI in `ci.yml`). The real license is dual
> MIT / Apache-2.0, verified at the source rather than inferred: github.com/asg017/sqlite-vec
> carries both `LICENSE-MIT` and `LICENSE-APACHE`.
>
> So no binary is bundled and no package dependency is declared. The runtime is
> **operator-provisioned** through `KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH`, and
> `scripts/provision-sqlite-vec.mjs` fetches the upstream release asset against a pinned SHA-256 for
> local and CI verification only — the product never calls it. With nothing provisioned the resolver
> yields no module and retrieval keeps using brute force, which is the same fail-closed outcome an
> unavailable runtime already produced. Binary provenance and platform qualification are recorded in
> [`docs/qa/sqlite-vec-ann-evidence.md`](../qa/sqlite-vec-ann-evidence.md).
>
> The constraint that survives activation is unchanged and remains binding: encrypted stores return
> `fallback-encrypted-store` and use brute force by design. Because keiko-server injects a key
> provider, production capsule stores ARE encrypted, so ANN is inert in the shipped default
> configuration. Encrypted-store ANN is outside M2 and needs its own ADR; it may not be inferred
> from this one.
>
> **Superseded (2026-07-20, Issue #2630) by
> [ADR-0153](ADR-0153-encrypted-store-ann-and-the-temp-store-guarantee.md).** That separate ADR is
> the one this paragraph called for. It found that the encryption flag was the wrong boundary —
> brute force already decrypts every vector into process memory, and the vec0 index already never
> persists — while the real unreconciled risk, SQLite spilling its TEMP database to an
> immediately-unlinked file, went undetected on every store. The guard now tests `PRAGMA temp_store`
> read from the live connection instead of `isEncrypted`, stores that enable the index pin TEMP
> storage to memory, and the RAM-resident index is size-bounded. Locks 1 and 2 below are untouched:
> the mode still defaults to `disabled` and the runtime stays operator-provisioned.
>
> **Activation record (2026-07-20, Issue #2631).** Lock 1 is now superseded: `parseVectorIndexMode`
> resolves `undefined` and unrecognised values to `"auto"` (was `"disabled"`), so the shipped
> default no longer requires an operator to discover `KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX`. The mode
> is decided by CAPABILITY at runtime: a store opened with a validated sqlite-vec runtime pins TEMP
> storage to memory and uses ANN (ADR-0153 D2); a store opened without one keeps extension loading
> disabled and continues to answer through brute force. Lock 2 is untouched — the runtime remains
> operator-provisioned via `KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH`, and an unqualified or
> missing binary still falls closed with `sqlite-vec-runtime-not-configured`. `"disabled"` remains
> the explicit opt-out for operators who want the vector index off regardless of capability.

The current sqlite-vec path is shipped but dormant behind three independent locks:

1. vector mode defaults to `disabled`; no production caller supplies `SearchOptions.vectorIndex`,
   and neither `KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX` nor
   `KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH` is set by production composition
   ([`vector-index.ts:130-159`](../../packages/keiko-local-knowledge/src/retrieval/vector-index.ts#L130-L159),
   [`scoped-vector-search.ts:133-142`](../../packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.ts#L133-L142));
2. no native sqlite-vec binary or package dependency is bundled on any platform; and
3. the Local Knowledge store opens `DatabaseSync` without `allowExtension: true`
   ([`store.ts:270-278`](../../packages/keiko-local-knowledge/src/store.ts#L270-L278)), so both load
   mechanisms terminate in a redacted unavailable result
   ([`vector-index.ts:287-318`](../../packages/keiko-local-knowledge/src/retrieval/vector-index.ts#L287-L318)).

M2.2 may set `allowExtension: true` only when a configured and validated sqlite-vec runtime is
selected. The default and every non-vec store open keep extension loading disabled. Runtime
configuration, binary provenance, platform qualification, and real-extension CI evidence are one
atomic activation obligation; a path string alone is not activation authority.

The vec0 index stays a TEMP virtual table populated from vectors decrypted inside their owning
package. It is deliberately runtime-local so the encrypted database never gains a second on-disk
plaintext vector copy
([`local-knowledge-schema.ts:655-658`](../../packages/keiko-contracts/src/local-knowledge-schema.ts#L655-L658)).
Encrypted stores continue to return `fallback-encrypted-store`
([`vector-index.ts:204-213`](../../packages/keiko-local-knowledge/src/retrieval/vector-index.ts#L204-L213))
and use brute force by design. Sealed vectors may be decrypted only within their owning package and
only into TEMP or in-memory structures. Encrypted-store ANN is outside M2 and requires a separate
ADR; it may not be inferred from this port.

> **Superseded by [ADR-0153](ADR-0153-encrypted-store-ann-and-the-temp-store-guarantee.md).** The
> refusal is now conditional on the TEMP-storage guarantee rather than on encryption, and the
> "only into TEMP or in-memory structures" rule is enforced instead of assumed: a store that enables
> the index pins `temp_store` to MEMORY, so its TEMP structures cannot become a file. The
> no-persisted-index rule is unchanged.

### D3 — The server is the only composition root for namespace wiring

The server composes the port without moving domain behavior:

- `knowledge` adapts `VectorIndexPort` to the existing `VectorIndexOptions.adapter` seam;
- `memory` replaces only the linear loop in `semanticScoresFrom`; it leaves
  `keiko-memory-retrieval`, its weights, and all non-semantic signals untouched; and
- `repo` implements the existing `SemanticSearchProvider` with a durable repository namespace
  keyed by the current `semanticCacheKey`, replacing the per-request `new Map()`.

`keiko-memory-vault` never implements or imports the port. It remains a sealed-BLOB store whose
allowed dependency surface is contracts plus security. A namespace adapter may read vectors only
through the owning package's existing bounded seam.

For all namespaces, port unavailability, stale state, identity mismatch, invalid scores, or a
partition mismatch selects the current exact/brute-force behavior. No adapter may convert those
conditions into an empty successful result that suppresses candidates.

### D4 — One server reranker facade absorbs orchestration without moving consumer ports

The canonical reranker facade lives in `packages/keiko-server`. ADR-0019 requires this placement:
it needs `UiHandlerDeps` and model-gateway transport, while Local Knowledge and Workflows must keep
their existing provider-free ports. The facade absorbs `grounded-model-reranker.ts` and the four
server orchestrations; behavior does not move into contracts.

The model-gateway transport validator
([`rerank-adapter.ts:198-227`](../../packages/keiko-model-gateway/src/rerank-adapter.ts#L198-L227))
and the facade result validator are deliberate defense in depth. Neither may be removed as
"duplicate" validation. The facade signature carries the resolved `localReranking` decision now,
even though the operation is reserved and currently has no consumer
([`local-knowledge-model-use-policy.ts:16-24`](../../packages/keiko-contracts/src/local-knowledge-model-use-policy.ts#L16-L24),
[`local-knowledge-grounded-qa.ts:1387-1397`](../../packages/keiko-server/src/local-knowledge-grounded-qa.ts#L1387-L1397)).
A future local reranker must gate there rather than add another policy path.

M2.3 makes one deliberate behavior correction. The current connected-context path accepts an empty
provider result and returns `[]`, dropping every candidate
([`grounded-context-pack-reranker.ts:67-89`](../../packages/keiko-server/src/grounded-context-pack-reranker.ts#L67-L89)).
The canonical validator adopts the existing A/B behavior: empty results for a non-empty candidate
set are invalid and fall back to the original candidates. M2.3 must prove the defect with a
failing-first regression test before applying the correction. No other rerank ordering, scoring,
budget, or policy behavior changes in the consolidation.

### D5 — Evaluation consolidation has four parts and one physical fold

"Under `keiko-evaluations`" means exactly four things:

1. shared evaluation contract types live in `keiko-contracts`, following the proven Issue #158
   re-export pattern
   ([`keiko-evaluations/src/types.ts:1-24`](../../packages/keiko-evaluations/src/types.ts#L1-L24));
2. generic floor evaluation, the non-tautology probe pattern, and report rendering live in
   `keiko-evaluations` as pure helpers;
3. the one physical fold moves `packages/keiko-local-knowledge/src/evaluations/` bodily into
   `keiko-evaluations`, including its runner, dimensions, 29 goldsets, and report; and
4. `grounded-faithfulness-eval.ts` remains in `keiko-server` because its system under test remains
   server-owned, while `grounded-retrieval-eval.ts` moves only when M2.7 retires its current system
   under test.

The gate scripts retain their public names and remain the cross-layer composition point:
`check:retrieval-quality`, `check:grounded-retrieval-quality`, and
`check:grounded-faithfulness`
([`package.json:113-116`](../../package.json#L113-L116)). The required aggregate stays named `ci`
([`ci.yml:294-318`](../../.github/workflows/ci.yml#L294-L318)). No second evaluations package or
second regression-probe framework is permitted.

ADR-0019 rule `adr-0019-direction-3l` currently rejects the one necessary physical-fold edge, and
rule 6a correctly prevents the server from importing evaluations
([`.dependency-cruiser.cjs:301-337`](../../.dependency-cruiser.cjs#L301-L337),
[`dependency-cruiser.cjs:644-677`](../../.dependency-cruiser.cjs#L644-L677)). M2.4 must replace the
3l rule with the following object verbatim. `keiko-local-knowledge` is the only new allow-listed
package; `keiko-server`, `keiko-cli`, and `keiko-ui` remain forbidden.

```js
{
  name: "adr-0019-direction-3l-evaluations-only-contracts-security-model-gateway-workspace-tools-harness-workflows-verification-evidence-local-knowledge",
  comment:
    "ADR-0019 direction rule 3 (evaluations boundary), amended by ADR-0152 D5: " +
    "keiko-evaluations may depend on keiko-contracts, keiko-security, keiko-model-gateway, " +
    "keiko-workspace, keiko-tools, keiko-harness, keiko-workflows, keiko-verification, " +
    "keiko-evidence, and keiko-local-knowledge. The local-knowledge edge exists only for the " +
    "single physical evaluation fold governed by ADR-0152; the evaluation harness remains the " +
    "highest-level policy consumer in the runtime graph. Nothing below it imports from here, so " +
    "keiko-cli, keiko-server, and keiko-ui must NOT appear in the allow-list. surface-parity.ts " +
    "breaks the load-time cli ↔ evaluations cycle with a dynamic import; that runtime edge is " +
    "invisible to dependency-cruiser as a static violation. The boundary also forbids imports " +
    "into the retired root src/evaluations/ shim so production callers stay on package surfaces.",
  severity: "error",
  from: {
    path: "^(packages/keiko-evaluations/src/|tests/architecture/fixtures/evaluations/)",
    pathNot: "\\.test\\.ts$",
  },
  to: {
    path:
      "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|local-knowledge|evaluations)|" +
      "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|local-knowledge|evaluations)|" +
      "@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|local-knowledge|evaluations)|" +
      "src/(evaluations|gateway|workspace|tools|harness|workflows|audit|ui|verification|cli)|" +
      siblingPackageSourcePattern([
        "contracts",
        "security",
        "model-gateway",
        "workspace",
        "tools",
        "harness",
        "workflows",
        "verification",
        "evidence",
        "local-knowledge",
      ]) +
      ")",
  },
},
```

The fold must not change any floor, fixture, proof, deterministic seed, or report meaning:

- `PASS_THRESHOLDS` remains byte-identical, including the three hard `1.0` invariants
  ([`local-knowledge/types.ts:218-227`](../../packages/keiko-evaluations/src/local-knowledge/types.ts#L218-L227));
- `DEFAULT_GROUNDED_RETRIEVAL_BUDGET` remains `0.8 / 0.9 / 0.85 / 0.8`, and
  `DEFAULT_GROUNDED_FAITHFULNESS_BUDGET` remains all `1.0`
  ([`grounded-retrieval-eval.ts:463-477`](../../packages/keiko-server/src/grounded-retrieval-eval.ts#L463-L477),
  [`grounded-faithfulness-eval.ts:205-218`](../../packages/keiko-server/src/grounded-faithfulness-eval.ts#L205-L218));
- all sixteen Local Knowledge probe ids stay registered: `exact-technical`,
  `semantic-paraphrase`, `multilingual-retrieval`, `multi-space`, `html-manual-structure`,
  `code-repository`, `chained-question`, `html-manual-table-row`, `html-manual-frameset`,
  `html-manual-code-block`, `html-manual-malformed`, `html-manual-denied-link`,
  `html-manual-index-page`, `html-manual-multilingual`, `confluence-connector-pod`, and
  `jira-connector-pod`;
- `reranker-reversed` and `embedding-flat` remain negative controls, while `reranker-off` remains
  the positive fallback control;
- the sealed-pod mutation proof remains behavioral, not snapshot-only; and
- the hallucinated path, out-of-window line, connector page, and connector issue fixtures remain
  active negative faithfulness proofs.

The 29 Local Knowledge fixtures and the complete faithfulness corpus remain intact. The current
faithfulness corpus is the original six-fixture repository baseline plus six connector fixtures,
twelve fixtures total; consolidation preserves all twelve rather than freezing the stale count.

### D6 — RetrievalContextPack is an additive base, not a coding wire migration

M2.6 adds the neutral module `packages/keiko-contracts/src/retrieval-context.ts`. It owns the base
retrieval purpose, source-kind, source-tier, citation, excerpt, omission, content-bearing pack, and
content-free wire vocabulary. `coding-context.ts` re-bases its existing exports on aliases and
closed refinements of that base.

Compatibility is byte identity, not structural similarity:

- every existing coding field name, enum literal, omission meaning, pack order, and wire projection
  stays byte-identical;
- `schemaVersion` stays `"1"` for existing coding purposes;
- the coding purpose union remains closed, and `isCodingContextPurpose` continues to reject neutral
  purposes
  ([`coding-context.ts:227-230`](../../packages/keiko-contracts/src/coding-context.ts#L227-L230));
- neutral source kinds such as graph and entailment exist only in the neutral union; and
- existing run-id material, prompt hashes, and the deterministic score/id/byte ordering in
  `contextPack.ts` remain unchanged
  ([`contextPack.ts:51-68`](../../packages/keiko-workspace/src/contextPack.ts#L51-L68)).

Promoting a neutral source kind into coding is a separate schema decision. It requires a lockstep
change to the total `CODING_CONTEXT_SOURCE_TIER_BY_KIND` record
([`coding-context.ts:78-92`](../../packages/keiko-contracts/src/coding-context.ts#L78-L92)), the
total harness `SOURCE_LABEL` record
([`renderRetrievedContext.ts:11-23`](../../packages/keiko-harness/src/tasks/renderRetrievedContext.ts#L11-L23)),
the `EditorContextSourceKind` mirror
([`keiko-editor/src/types.ts:781-790`](../../packages/keiko-editor/src/types.ts#L781-L790)), and the
UI mapping. M2 does not perform that promotion.

The existing coding-context, context-route, completion, inline-completion, test-generation,
evidence, and prompt-rendering suites must pass unmodified, supplemented only by wire-fixture
snapshots that prove the aliases serialize identically.

### D7 — HS-6 is a named single-writer window with an explicit freeze surface

From this ADR's integration until the M2.6 contract batch is integrated, HS-6 designates one writer
for the contract-generalization surface. Other M2 children may read these files and coordinate
against their stable seams, but may not independently edit them. The eleven single-writer files
are:

1. `packages/keiko-contracts/src/coding-context.ts`
2. `packages/keiko-contracts/src/index.ts` (the coding-context export block)
3. `packages/keiko-contracts/src/harness.ts`
4. `packages/keiko-server/src/editor/codingContext.ts`
5. `packages/keiko-server/src/editor/codingContextProviders.ts`
6. `packages/keiko-server/src/editor/codingContextEvidence.ts`
7. `packages/keiko-server/src/editor/localKnowledgeRetrieval.ts`
8. `packages/keiko-server/src/editor/contextRoutes.ts`
9. `packages/keiko-server/src/editor/testGenerationEvidence.ts`
10. `packages/keiko-harness/src/tasks/renderRetrievedContext.ts`
11. `packages/keiko-workspace/src/contextPack.ts`

Eight coordinate-only seams must be checked for compatibility but are not independent migration
sites:

1. the completion provenance vocabulary in `packages/keiko-contracts/src/editor-completion.ts`;
2. the completion mapper in `packages/keiko-server/src/editor/completionRoutes.ts`;
3. the inline reuse of completion provenance in
   `packages/keiko-contracts/src/editor-inline-completion.ts`;
4. the inline mapper in `packages/keiko-server/src/editor/inlineCompletionRoutes.ts`;
5. the test-generation mapper in `packages/keiko-server/src/editor/testGenerationRoutes.ts`;
6. the editor mirror in `packages/keiko-editor/src/types.ts`;
7. the UI mapping in `packages/keiko-ui/src/lib/editor-test-generation.ts`; and
8. the existing git-context eligibility ceiling in the coding-context collector/provider seam.

`packages/keiko-server/src/coding-context/*` is explicitly outside HS-6. The connected-context
intake delivered for Issue #1989 shares a name but not these types. Name similarity does not
authorize consolidation.

Any active Editor or OpenCode branch that needs a frozen file must coordinate with the M2.6 writer.
A conflicting independent edit stops the wave for a maintainer decision; it is not resolved by
silently taking a second writer.

### D8 — The repository pod uses the existing repository scope, walk, ignore engine, and chunker

M2.5 lands the repository pod on the existing `{ kind: "repository" }` Local Knowledge source
scope. It walks the real working tree directly; it does not add a contract member, synthetic mount,
or second workspace abstraction. The existing bounded breadth-first walk and always-on deny list
remain authoritative.

The Local Knowledge walker currently does not consume `.gitignore`. M2.5 exposes an explicit walk
option that reuses the semantics in `packages/keiko-workspace/src/ignore.ts`, including ordered
negation and directory behavior
([`ignore.ts:140-175`](../../packages/keiko-workspace/src/ignore.ts#L140-L175)). It must not create a
second ignore parser.

Code parsing extends the existing parser registry and the one existing chunker. The chunker gains a
symbol-boundary probe before `LINE_BOUNDARY_PATTERN` in `chooseChunkEnd`
([`chunker.ts:305-358`](../../packages/keiko-local-knowledge/src/chunking/chunker.ts#L305-L358)),
seeded from the existing cross-language `symbolDefinitionPatterns`
([`grounded-orchestrator.ts:1408-1429`](../../packages/keiko-server/src/grounded-orchestrator.ts#L1408-L1429)).
Indexing maps chunk character offsets to one-based line numbers because grounded/editor citations
are `path:line`. No second code chunker or query-time line scanner is introduced.

### D9 — Repository-pod consumption preserves the existing semantic-search seam and failure contract

M2.7 swaps only the internals of `configuredRepoSemanticSearchProviderFor`; it does not widen
`SemanticSearchProvider`. The provider name remains `configured-repo-semantic-search` because
repository evidence atom stable ids include the provider-derived tool identity
([`repoSearch.ts:1582-1594`](../../packages/keiko-workspace/src/repoSearch.ts#L1582-L1594)).

The first consumption version intersects pod hits with `request.documents`, preserving current
match validation
([`repoSearchSemantic.ts:95-119`](../../packages/keiko-workspace/src/repoSearchSemantic.ts#L95-L119)).
It bumps `SEMANTIC_VECTOR_CACHE_SCHEMA_VERSION` when replacing the per-request cache. A chunk's
anchored `line` must be at least as accurate as `localizeMatchLine`; fixed `line: 1` output is a
guarded regression, not an acceptable placeholder
([`grounded-repo-semantic-search.ts:350-403`](../../packages/keiko-server/src/grounded-repo-semantic-search.ts#L350-L403)).

The hybrid failure contract is inviolable: only `EmbeddingAdapterError` is a skippable per-source
degradation; every other error propagates for the boundary to classify and redact
([`grounded-qa-hybrid.ts:495-524`](../../packages/keiko-server/src/grounded-qa-hybrid.ts#L495-L524)).

### D10 — The 2026-07-18 activation is a bounded scheduling deviation

The maintainer activated Knowledge M2 early on 2026-07-18. This is recorded as a narrow
Delivery-Constitution deviation for program Epic #2554 and Knowledge M2 Epic #2556: M2 may start
before the program's normal wave sequencing would admit it. The deviation changes scheduling only.
It does not widen issue scope, mode, Authority Envelope, deployment ceiling, delivery authority,
required checks, evidence rules, or trust boundaries.

The wave cut is:

- **Phase A entry gate:** M2.1 / Issue #2565 lands this ADR and the operational note. Only after it
  integrates may M2.2, M2.3, M2.4, and M2.5 begin in parallel.
- **Phase B integration:** M2.6 owns the shared contracts batch, HS-6 single-writer work, shared eval
  contract types, and the wave's one D12 regeneration. M2.7 consumes the repository pod after its
  prerequisites settle. M2.8 performs closeout proof after every preceding child is integrated.

M2.6 owns exactly one batched D12 evidence regeneration because its contract changes touch the
measured surface. M2.1 is documentation-only, M2.5 is outside the ADR-0139 D2 measured subject, and
no sibling may regenerate independently to create competing evidence. If the D12 measurement
toolchain itself changes, its governing policy still requires Linux-authoritative remeasurement;
this record creates no exception.

The sibling decision map is normative:

| M2 child | Governing decision |
| --- | --- |
| M2.2 — vector activation | D1 port shape and partition/identity rules; D2 sqlite-vec security disposition; D3 composition |
| M2.3 — reranker facade | D4 placement, validation, policy threading, and empty-result correction |
| M2.4 — evaluation fold | D5 four-part model, verbatim rule 3l replacement, and frozen quality assets |
| M2.5 — repository pod | D8 existing scope/walk/ignore/chunker ownership |
| M2.6 — shared contracts | D1 canonical identity helper; D6 neutral additive contract; D7 HS-6; D10 one D12 batch |
| M2.7 — repository consumption | D3 repository namespace composition and D9 seam/cache/line/error constraints |
| M2.8 — closeout | D5 unchanged gates/corpora, D6 byte identity, and D10 phase completion proof |

Operational details and the file-by-file HS-6 checklist live in
[`docs/qa/knowledge-m2-wave.md`](../qa/knowledge-m2-wave.md).

## Consequences

- The three retrieval pillars gain one candidate-generation port while retaining their owning
  rankers, stores, and consumer seams.
- sqlite-vec activation has an explicit security gate and cannot accidentally widen encrypted-store
  plaintext exposure.
- Server reranking converges without importing provider concerns into contracts or domain packages.
- Evaluation code can be physically consolidated without creating an architecture cycle or
  changing required check names, floors, fixtures, or non-tautology proofs.
- Retrieval context becomes reusable without changing existing coding wire bytes, evidence ids, or
  prompt hashes.
- The repository pod reuses the real repository scope, ignore semantics, chunker, and semantic
  provider seam.
- HS-6 makes cross-wave write ownership inspectable and gives conflicts a fail-closed escalation
  path.
- Early activation is auditable as a scheduling exception rather than becoming precedent for
  authority widening or gate bypass.

## Rejected alternatives

- **One index interface per pillar:** rejected because it duplicates identity, partition, fallback,
  and diagnostics rules and permits behavior to diverge.
- **Persist vec0 plaintext beside encrypted stores:** rejected by ADR-0047 and the no-second-copy
  invariant.
- **Put reranking in contracts or model gateway:** rejected because contracts cannot own behavior
  and the gateway cannot own consumer orchestration or `UiHandlerDeps`.
- **Move every evaluation system under one package:** rejected because rules 3l and 6a make the
  server system-under-test boundaries intentional.
- **Generalize coding context by widening its existing enums:** rejected because validators, total
  records, editor mirrors, UI mappings, prompt hashes, and wire schema would change together.
- **Create a repository-specific mount, walker, ignore parser, chunker, or search seam:** rejected
  because each duplicates an existing governed subsystem.
- **Run D12 regeneration in every child:** rejected because it creates competing evidence and
  defeats the single-writer window.
