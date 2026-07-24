# Knowledge M2 — local verification runbook

How to drive the repository pod through the running product yourself, without a provider account.
Every step below was executed on this branch; the observed results are recorded at the bottom.

The point of this document is that the repository pod was previously reachable only from tests. It
is now reachable from the product, and this is how you confirm that on your own machine.

## Why a local model mock

Local Knowledge requires an embedding-capable model configuration before it creates a capsule, but
creating an interactive Draft performs no provider I/O. The Draft records a provisional,
content-safe identity from that configuration. Immediately before the first indexing job, Keiko
probes the provider, pins the verified dimensions and embedding-space fingerprint, and only then
writes vectors. This keeps Draft creation local and responsive while indexing still fails closed.

To verify the complete indexing path without a provider account, point the gateway at the loopback
mock the repository already ships for its end-to-end suite
(`tests/e2e/support/model-mock-server.mjs`). It speaks the OpenAI-compatible chat and embeddings
contracts and returns byte-reproducible values, so the whole path — capsule, connect, index,
refresh, retrieve — runs through the real model gateway with a repeatable result.

The mock is a verification aid, not a product component. It proves the wiring and the incremental
behavior; it says nothing about answer quality, which needs a real model.

## Steps

```bash
# 1. Start the deterministic local model mock (chat + embeddings).
node tests/e2e/support/model-mock-server.mjs &

# 2. Point the dev gateway at it. Both entries use the same loopback endpoint; the gateway config
#    schema permits http:// for loopback hosts, and the egress policy allows loopback.
mkdir -p .keiko/dev/ui
cat > .keiko/dev/ui/keiko.config.json <<'JSON'
{
  "providers": [
    { "modelId": "local-chat", "baseUrl": "http://127.0.0.1:32186/v1", "apiKey": "local-mock-token-1234567890", "timeoutMs": 30000, "maxRetries": 0, "retryBaseDelayMs": 100 },
    { "modelId": "local-embedding", "baseUrl": "http://127.0.0.1:32186/v1", "apiKey": "local-mock-token-1234567890", "timeoutMs": 30000, "maxRetries": 0, "retryBaseDelayMs": 100 }
  ],
  "capabilities": [
    { "id": "local-chat", "kind": "chat", "contextWindow": 8192, "maxOutputTokens": 1024, "toolCalling": true, "structuredOutput": true, "streaming": true, "supportsImageInput": false, "supportsDocumentInput": true, "workflowEligible": true, "costClass": "low", "latencyClass": "fast", "throughputHint": "Local loopback mock for manual verification.", "preferredUseCases": ["Local verification"], "knownLimitations": ["Deterministic mock, not a real model."] },
    { "id": "local-embedding", "kind": "embedding", "contextWindow": 8191, "maxOutputTokens": 0, "toolCalling": false, "structuredOutput": false, "streaming": false, "supportsImageInput": false, "supportsDocumentInput": false, "workflowEligible": false, "costClass": "low", "latencyClass": "fast", "throughputHint": "Local loopback mock for manual verification.", "preferredUseCases": ["Local verification"], "knownLimitations": ["Deterministic mock, not a real model."] }
  ],
  "circuitBreaker": { "failureThreshold": 5, "cooldownMs": 30000, "halfOpenProbes": 2 },
  "grounding": { "maxConnectedSources": 16, "maxLocalKnowledgeSources": 16 }
}
JSON
chmod 600 .keiko/dev/ui/keiko.config.json

# 3. Start Keiko. Override the ports if another Keiko instance is already running.
KEIKO_DEV_UI_PORT=1993 KEIKO_DEV_BFF_PORT=1994 KEIKO_DEV_NEXT_PORT=1995 npm run dev:start
```

Then, in the UI at the printed URL: open Local Knowledge, create a Knowledge Pod, and connect a
source. **Tick "Connect as a code repository"** and give it a path to a source tree — that checkbox
is what makes the capsule a repository pod rather than a document folder. Index it, then press
refresh again without changing any file.

The same flow over the API, which is what the UI calls:

```bash
B=http://127.0.0.1:1993
H=(-H 'content-type: application/json' -H 'x-keiko-csrf: 1')

CAP=$(curl -s -X POST "$B/api/local-knowledge/capsules" "${H[@]}" \
  -d '{"displayName":"Keiko Parsers"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["capsule"]["id"])')

# Build the body with a JSON encoder rather than string interpolation: a repository path may
# legitimately contain a quote or a backslash, which would produce an invalid request body.
ROOT="$PWD/packages/keiko-local-knowledge/src/parsers"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"scope": {"kind": "repository", "repositoryRoot": sys.argv[1]}, "displayName": "Keiko parsers"}))' "$ROOT")

curl -s -X POST "$B/api/local-knowledge/capsules/$CAP/connection" "${H[@]}" -d "$BODY"

curl -s -X POST "$B/api/local-knowledge/capsules/$CAP/index" "${H[@]}" -d '{}'
curl -s -X POST "$B/api/local-knowledge/capsules/$CAP/reindex" "${H[@]}" -d '{"mode":"changed-files"}'
```

## What to look for

The store is at `.keiko/dev/ui/local-knowledge/default/capsules.db`. Its content columns are
encrypted, but the counts below are not, so they can be read directly:

```sql
PRAGMA user_version;                                   -- 30
SELECT outcome, added_files, changed_files, unchanged_files FROM repository_pod_runs;
SELECT COUNT(*) FROM repository_file_fingerprints;     -- one per indexed file
SELECT COUNT(*) FROM repository_chunk_line_ranges;     -- what makes path:line citations possible
```

`repository_pod_runs` is the decisive table: only the pod path writes it. A row there proves the
capsule went through `refreshRepositoryPod` and not the generic indexing path.

## Observed on this branch (2026-07-20)

Indexing `packages/keiko-local-knowledge/src/parsers`:

| Check                                  | Result                                                 |
| -------------------------------------- | ------------------------------------------------------ |
| Capsule create                         | HTTP 201                                               |
| Connect `repository` scope             | HTTP 201                                               |
| Index                                  | HTTP 200                                               |
| Schema version                         | 30                                                     |
| Pod run 1                              | `succeeded`, applied, 49 added, 0 changed, 0 unchanged |
| Pod run 2 (no edits)                   | `succeeded`, **0 added, 0 changed, 49 unchanged**      |
| Files / chunks / vectors / line ranges | 49 / 1884 / 1884 / 1884                                |

The second run is the one that matters: an unchanged working tree re-embeds nothing, which is the
behavior the M2 substrate exists to provide.

## What this does not cover

Answer quality. The mock returns a fixed completion, so a grounded question asked against it proves
the retrieval and citation plumbing, not the answer. For that, configure a real model gateway and
ask a question in the UI — the citations should resolve to file and line within the indexed
repository.
