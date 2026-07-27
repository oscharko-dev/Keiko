# Knowledge M2 — the clean-checkout demo (Issue #2634)

The Definition of Done for
[Knowledge M2](../adr/ADR-0152-substrate-ownership-and-unified-retrieval-spine.md) asks for a
clean-checkout demonstration of the repository pod: index a small real slice of this repository,
ask a grounded multi-file question, and receive a provider-generated, line-cited result through the
unified service. The run must also prove the shared vector provider is available, exercise the
provider-backed reranker with policy enabled and disabled, and abstain on a deliberately
evidence-free question.

The acceptance entry point is
[`scripts/knowledge-m2-clean-checkout-demo.mjs`](../../scripts/knowledge-m2-clean-checkout-demo.mjs).
It emits content-free evidence—counts, modes, statuses, and hashes—and exits non-zero before
printing JSON when any acceptance condition fails.

## Acceptance mode requires real configured providers

The CLI runs only in `executionMode="acceptance"`. It does not start the repository's loopback mock
and refuses injected answer adapters. Before running it, provide:

- `KEIKO_CONFIG_FILE`: a Keiko gateway configuration readable by the current process.
- `KEIKO_CLEAN_CHECKOUT_DEMO_EMBEDDING_MODEL_ID`: a configured capability with
  `kind="embedding"`.
- `KEIKO_CLEAN_CHECKOUT_DEMO_ANSWER_MODEL_ID`: a configured capability with `kind="chat"`.
- `KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS`: the verified output dimensions of the embedding model.
- A `reranker` entry in the same gateway configuration.
- Provider credentials through the gateway parser's environment inputs
  (`KEIKO_MODEL_<ID>_API_KEY`/`KEIKO_DEFAULT_API_KEY` and `KEIKO_RERANKER_API_KEY`). The standalone
  CLI does not open the server-owned credential vault. Never put credentials in this document, the
  command line, the gateway JSON, or evidence.

The provider may be customer-hosted or remote, but it must be a real configured implementation of
the OpenAI-compatible embedding/chat and LiteLLM-compatible rerank contracts. A deterministic mock
is suitable for the hermetic regression suite, not for acceptance.

## Steps for a fresh checkout

```bash
# 1. Fresh clone in a throwaway directory: no .keiko state and no build artifacts.
tmp="$(mktemp -d)"
git clone --depth=1 https://github.com/oscharko-dev/Keiko.git "$tmp/Keiko"
cd "$tmp/Keiko"

# 2. Point to an operator-owned gateway config outside the checkout and select its models.
export KEIKO_CONFIG_FILE=/absolute/operator/path/keiko.config.json
export KEIKO_CLEAN_CHECKOUT_DEMO_EMBEDDING_MODEL_ID=your-embedding-model
export KEIKO_CLEAN_CHECKOUT_DEMO_ANSWER_MODEL_ID=your-chat-model
export KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS=1024

# 3. Supply credentials through the normal Keiko environment flow, then run.
npm ci --no-audit --no-fund
npm run demo:clean-checkout > /tmp/knowledge-m2-evidence.json
cat /tmp/knowledge-m2-evidence.json
```

`npm run demo:clean-checkout` builds the workspace packages, provisions the pinned USearch 2.26.0
runtime with `npm run provision:usearch`, and starts the acceptance CLI. Add `-- --pretty` for
formatted JSON.

On an offline host, provision `.usearch/2.26.0/<platform>-<arch>/usearch.node` from the exact
verified artifact before disconnecting and set `KEIKO_USEARCH_BINARY_PATH` to that file if it is
outside the default layout. The acceptance CLI verifies the platform-pinned SHA-256 before the
small-corpus exact lane runs; the HNSW loader repeats that check before native loading. Missing,
unsupported, or tampered native artifacts fail closed, and the demo never silently substitutes
brute-force retrieval.

## What the acceptance run does

1. Loads the exact provisioned USearch runtime through the production shared vector-index provider.
2. Opens a fresh encrypted in-memory `KnowledgeStore`. Decrypted vectors exist only in process
   memory; the demo supplies no serialization path and writes no plaintext index.
3. Uses the selected real embedding provider for capability verification, repository indexing, and
   both retrieval questions.
4. Creates a repository pod over `packages/keiko-local-knowledge/src/retrieval/` and indexes
   `vector-index.ts`, `local-vector-index-port.ts`, and `scoped-vector-search.ts` through
   `refreshRepositoryPod`.
5. Runs the multi-file question through `runGroundedAnswer` and
   `ModelGatewayAnswerGenerator`, so the selected chat provider must generate non-empty text with
   valid inline citation markers. Only citations actually attached from those markers count toward
   the two-file condition.
6. Runs the same grounded-answer path with external reranking allowed and denied. The allowed path
   must report `applied`; the denied path must report `denied/policy-denied`; their selected
   reference-order hashes must differ.
7. Runs the evidence-free question through `runGroundedAnswer` and proves the no-evidence
   short-circuit made zero generation calls, returned zero references and citations, and produced
   zero generated characters.
8. Validates the six acceptance criteria and the redaction contract before emitting evidence.

## Honest USearch execution mode

This demo intentionally indexes only three real files. That corpus is below the shared USearch
engine's 20,000-row HNSW crossover, so acceptance requires:

```text
provider=usearch
status=available
searchMode=exact
```

This is not a claim that HNSW ran. It proves the verified common USearch engine owned the query and
honestly chose its bounded small-corpus exact lane. The separate Knowledge M2 closeout measurement
uses more than 20,000 rows and is the executable proof of actual `searchMode=ann` HNSW operation,
recall, latency, and memory bounds. Artificially inflating this clean-checkout corpus would weaken,
not strengthen, the evidence.

[ADR-0163](../adr/ADR-0163-one-bounded-in-memory-usearch-hnsw-runtime.md) supersedes Issue #2634's
original sqlite-vec assumption that every non-empty run could honestly call itself ANN. The
acceptance pair is now explicit: this run proves real clean-checkout composition over real files;
`npm run check:knowledge-m2-closeout` proves genuine HNSW above the production crossover. Evidence
schema 3 names the former `vectorIndex.providerAvailable` and references the latter under
`hnswQualifiedBy`; it never labels exact search as active ANN.

## Hermetic tests are not acceptance evidence

[`scripts/__tests__/knowledge-m2-clean-checkout-demo.test.mjs`](../../scripts/__tests__/knowledge-m2-clean-checkout-demo.test.mjs)
uses the loopback embedding/rerank server and an explicitly injected deterministic answer adapter.
Its evidence is stamped:

```json
{
  "executionMode": "hermetic-test",
  "acceptanceEligible": false
}
```

Those tests protect orchestration, fail-closed validation, citation attachment, abstention, and
redaction without network flakiness or provider cost. The acceptance CLI rejects that mode, so a
mock-backed result cannot be presented as the production proof.

## Evidence contract

| Criterion             | Decisive evidence                                                                    | Required condition                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| clean-checkout        | indexed paths, fingerprints, start-state flags                                       | All three requested paths indexed; no `.keiko` or `dist` state in strict acceptance mode.                                                   |
| vector-index-active   | provider, status, search mode, forbidden statuses, HNSW proof command                | `usearch`, `available`, `exact`; no fallback or disabled status; HNSW qualification points to the closeout gate.                            |
| multi-file citations  | generated-character count, generation hash, attached citations, file/line resolution | Non-empty generated output; at least one attached citation; attached citations span at least two files and resolve to positive line ranges. |
| abstention            | references, citations, generated characters, generation calls, `noEvidence`          | All counts zero and `noEvidence=true`.                                                                                                      |
| reranker toggle       | enabled/disabled diagnostics and selected-order hashes                               | `applied` versus `denied/policy-denied`; order hashes differ.                                                                               |
| content-free evidence | whole record                                                                         | No endpoints, credential labels, answer bodies, excerpts, or raw provider responses.                                                        |

Example shape:

```jsonc
{
  "demo": "knowledge-m2-clean-checkout",
  "issue": "#2634",
  "schemaVersion": "3",
  "executionMode": "acceptance",
  "acceptanceEligible": true,
  "cleanCheckout": {
    "workspaceRootExists": true,
    "keikoStatePresentAtStart": false,
    "buildArtifactsPresentAtStart": false,
    "indexedPathsRequested": 3,
    "indexedPathsResolved": 3,
    "fingerprintCount": 3,
  },
  "vectorIndex": {
    "provider": "usearch",
    "status": "available",
    "searchMode": "exact",
    "indexIdentityHash": "<64 hex chars>",
    "vectorCount": 5,
    "examinedCandidateCount": 60,
    "estimatedIndexBytes": 100000,
    "forbiddenStatusesAvoided": [
      "disabled",
      "fallback-unavailable",
      "fallback-encrypted-store",
      "fallback-unsupported-metric",
      "fallback-incompatible-identity",
      "fallback-index-too-large",
      "fallback-query-error",
    ],
    "providerAvailable": true,
    "hnswQualifiedBy": "npm run check:knowledge-m2-closeout",
  },
  "multiFileQuery": {
    "queryHash": "<64 hex chars>",
    "referenceCount": 3,
    "attachedCitationCount": 3,
    "citationCount": 3,
    "generatedCharacters": 180,
    "generationHash": "<64 hex chars>",
    "noEvidence": false,
    "distinctFileCount": 3,
    "spansMultipleFiles": true,
    "citationFiles": ["<workspace-relative paths>"],
    "citationLinesResolved": true,
    "fileLineHash": "<64 hex chars>",
  },
  "abstention": {
    "queryHash": "<64 hex chars>",
    "references": 0,
    "citations": 0,
    "generatedCharacters": 0,
    "generationCalls": 0,
    "noEvidence": true,
    "abstained": true,
  },
  "reranker": {
    "enabled": {
      "policyExternalReranking": "allow",
      "diagnosticStatus": "applied",
      "selectedOrderHash": "<64 hex chars>",
    },
    "disabled": {
      "policyExternalReranking": "deny",
      "diagnosticStatus": "denied",
      "diagnosticFailureKind": "policy-denied",
      "selectedOrderHash": "<64 hex chars>",
    },
    "answerPathDiffers": true,
  },
  "toolchain": { "node": "24.18.0", "platform": "linux", "arch": "x64" },
  "elapsedMs": 500,
}
```

## Relationship to the closeout gate

The Knowledge M2 closeout gate proves the substrate's ANN quality/performance, encrypted-store
boundary, reranker ownership, evaluation determinism, wire shape, and repository-pod scorecard.
This acceptance demo proves those production components compose from a fresh checkout with real
configured providers and an actual generated-answer/citation flow. Neither surface emits
repository bodies, generated text, credentials, or provider endpoints.
