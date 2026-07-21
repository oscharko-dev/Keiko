# Knowledge M2 — the clean-checkout demo (Issue #2634)

The Definition of Done for [Knowledge M2](../adr/ADR-0152-substrate-ownership-and-unified-retrieval-spine.md)
asks for a clean-checkout demo of the repository pod: from a fresh clone, index a small real slice of
this repo as a pod, ask a grounded multi-file question, and receive a line-cited answer through the
unified service — with ANN active, the reranker facade exercised in both enabled and disabled
states, and abstention verified on a deliberately evidence-free question. No fixtures, no mocks;
the production retrieval + grounding path.

That demo is [`scripts/knowledge-m2-clean-checkout-demo.mjs`](../../scripts/knowledge-m2-clean-checkout-demo.mjs).
It emits **content-free** evidence — counts, timings, statuses, hashes — verified against the
six-bullet DoD contract before it prints. A run that violates the contract exits non-zero rather
than emitting misleading evidence.

## Steps a reader can execute unmodified

The container image below matches the one the CI `Build, scan, SBOM, smoke` job uses. Anything
else with Node 24.18 and `git` on `PATH` works too; the container is the reference so the ANN
extension resolves cleanly on Linux.

```bash
# 1. Fresh clone in a throwaway directory (no .keiko state, no build artifacts).
tmp="$(mktemp -d)"
git clone --depth=1 https://github.com/oscharko-dev/Keiko.git "$tmp/Keiko"
cd "$tmp/Keiko"

# 2. Run inside the Linux container that matches CI.
docker run --rm -it \
    -v "$PWD":/workspace -w /workspace \
    node:24-bookworm \
    bash -lc '
        set -euo pipefail
        npm ci --no-audit --no-fund
        npm run demo:clean-checkout > /tmp/evidence.json
        cat /tmp/evidence.json
    '
```

`npm run demo:clean-checkout` is a composed alias — it builds the workspace packages, provisions
the sqlite-vec loadable extension (`npm run provision:sqlite-vec`), and runs
`node scripts/knowledge-m2-clean-checkout-demo.mjs`. It writes the JSON evidence to stdout and a
short acceptance report to stderr. Add `-- --pretty` for a formatted print.

The demo requires the sqlite-vec extension binary to be present. On offline hosts, copy
`.sqlite-vec/0.1.9/vec0.<so|dylib|dll>` from a machine that has run
`npm run provision:sqlite-vec`. Without it the ANN diagnostic falls back to
`sqlite-vec-runtime-not-configured` — one of the two statuses the AC explicitly forbids — and the
runner exits non-zero.

## What the demo does

1. Provisions and loads the `sqlite-vec` v0.1.9 loadable extension (ADR-0152 D2, ADR-0153).
2. Opens a fresh **encrypted** in-memory `KnowledgeStore` with the vector index runtime configured
   — replaying the ADR-0153 D1 boundary so the ANN path is reachable on an encrypted store, then
   producing the diagnostic that proves it.
3. Boots a loopback OpenAI-compatible mock server
   ([`scripts/lib/clean-checkout-demo-mock-server.mjs`](../../scripts/lib/clean-checkout-demo-mock-server.mjs))
   that serves deterministic embeddings on `/v1/embeddings` and a deterministic reverse-order
   rerank on `/v1/rerank`. The mock never proxies to a provider; each request-response is
   byte-reproducible, so the whole demo runs offline with the real
   `keiko-model-gateway` HTTP adapters carrying the transport.
4. Creates a repository pod over `packages/keiko-local-knowledge/src/retrieval/` and indexes three
   real files — `vector-index.ts`, `local-vector-index-port.ts`, `scoped-vector-search.ts` — using
   the production `refreshRepositoryPod` (Issue #2569 / ADR-0152 D8).
5. Runs three grounded queries through the production `runLocalKnowledgeRetrieval` pipeline:
   - a multi-file question whose citations must resolve to file + line inside ≥ 2 of the indexed
     files;
   - a deliberately evidence-free question that must abstain (`noEvidence: true`, zero references);
   - a rerun of the multi-file question fed through the `rerankSelection` facade with the
     external-reranking policy toggled `allow` and then `deny` — the order hashes must differ.
6. Validates the six acceptance criteria (see below) and the content-free redaction contract,
   then prints the evidence.

## The evidence contract

The runner refuses to print evidence that violates any of the six DoD bullets, and refuses to
print evidence that contains an endpoint URL, a credential label, or an excerpt phrase. The
validators live in
[`scripts/lib/clean-checkout-demo.mjs`](../../scripts/lib/clean-checkout-demo.mjs) and are unit
tested end-to-end in
[`scripts/__tests__/knowledge-m2-clean-checkout-demo.test.mjs`](../../scripts/__tests__/knowledge-m2-clean-checkout-demo.test.mjs)
— the test drives the same journey against the same mock and asserts every AC bullet plus
negative controls for the redaction / acceptance validators.

### Acceptance criteria coverage

| Bullet                | Evidence field                                               | Contract                                                                                           |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| clean-checkout        | `cleanCheckout.indexedPathsResolved`, `.fingerprintCount`    | Both non-zero; workspace root exists.                                                              |
| ann-active            | `annActive.provider`, `.status`, `.forbiddenStatusesAvoided` | `provider="sqlite-vec"` AND `status="available"`; neither of the two forbidden statuses.           |
| multi-file citations  | `multiFileQuery.spansMultipleFiles`, `.distinctFileCount`    | `spansMultipleFiles=true`, `distinctFileCount ≥ 2`, `citationLinesResolved=true`.                  |
| abstention            | `abstention.abstained`, `.references`, `.noEvidence`         | `abstained=true`, `references=0`, `noEvidence=true`.                                               |
| reranker toggle       | `reranker.enabled`, `.disabled`, `.answerPathDiffers`        | `answerPathDiffers=true`; `enabled.selectedOrderHash ≠ disabled.selectedOrderHash`.                |
| content-free evidence | (whole record)                                               | No `http(s)://`, no `api_key\|secret\|token`, no `excerpt\|answer\|body\|response text\|raw text`. |

### Expected evidence shape

Deterministic fields (counts, statuses, hashes) hold across runs on the same host. Wall-clock
`elapsedMs` and the host `toolchain` fields differ — the runner never asserts on them.

```jsonc
{
  "demo": "knowledge-m2-clean-checkout",
  "issue": "#2634",
  "schemaVersion": "1",
  "cleanCheckout": {
    "workspaceRootExists": true,
    "keikoStatePresentAtStart": false,
    "buildArtifactsPresentAtStart": false,
    "indexedPathsRequested": 3,
    "indexedPathsResolved": 3,
    "fingerprintCount": 3,
  },
  "annActive": {
    "provider": "sqlite-vec",
    "status": "available",
    "indexName": "keiko_lk_vec_32_cosine",
    "vectorCount": 60,
    "forbiddenStatusesAvoided": ["fallback-encrypted-store", "sqlite-vec-runtime-not-configured"],
    "active": true,
  },
  "multiFileQuery": {
    "queryHash": "<64 hex chars>",
    "referenceCount": 5,
    "citationCount": 5,
    "distinctFileCount": 3,
    "spansMultipleFiles": true,
    "citationFiles": [
      "packages/keiko-local-knowledge/src/retrieval/local-vector-index-port.ts",
      "packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.ts",
      "packages/keiko-local-knowledge/src/retrieval/vector-index.ts",
    ],
    "citationLinesResolved": true,
    "fileLineHash": "<64 hex chars>",
  },
  "abstention": {
    "queryHash": "<64 hex chars>",
    "references": 0,
    "noEvidence": true,
    "reason": "no-evidence-stated",
    "abstained": true,
  },
  "reranker": {
    "enabled": {
      "policyExternalReranking": "allow",
      "diagnosticStatus": "applied",
      "selectedOrderHash": "<64 hex chars>",
      "candidateCount": 5,
      "documentCount": 5,
      "keptCount": 3,
    },
    "disabled": {
      "policyExternalReranking": "deny",
      "diagnosticStatus": "denied",
      "diagnosticFailureKind": "policy-denied",
      "selectedOrderHash": "<64 hex chars>",
      "candidateCount": 5,
      "documentCount": 0,
      "keptCount": 3,
    },
    "answerPathDiffers": true,
  },
  "toolchain": { "node": "24.18.0", "platform": "linux", "arch": "x64" },
  "elapsedMs": 500,
}
```

## Relationship to the closeout gate

The Knowledge M2 closeout gate
([`scripts/check-knowledge-m2-closeout.mjs`](../../scripts/check-knowledge-m2-closeout.mjs))
proves the _pieces_ of the substrate independently — the ANN latency + encrypted-store boundary,
the reranker facade importer set, the eval harness determinism, the retrieval-context wire
shape, and the repository pod scorecard. This demo proves the pieces still hold together on a
**fresh checkout**, end-to-end, without any pre-seeded store or worktree state. Both are kept
alive because they answer different questions:

- The closeout gate keeps drift out of the substrate on every gated CI run.
- The clean-checkout demo answers the DoD's own "does a reviewer see the substrate work on their
  own machine, from scratch?" question — the observable a maintainer signs off on before closing
  the epic.

Content-free evidence is the shared discipline. Neither surface ever emits repository content,
answers, or credentials.
