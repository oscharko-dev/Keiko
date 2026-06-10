# Connected Context Privacy

When you connect a folder or file set to a chat in the Conversation Center and ask a
question, Keiko gathers a small bundle of repository evidence to answer it. This page
documents what is in that bundle, what is sent to the model, what is kept locally,
and how to remove it.

## What is connected context?

Connected context is the slice of your repository that Keiko is allowed to inspect for
a single grounded answer. You pick the slice by binding a chat to a workspace root, a
folder, or a set of files in the Files window. Keiko reads only inside that scope and
records what it touched.

## What is sent to the model?

A grounded request to your configured model carries:

- Your question text after the same live-payload redaction used for grounded excerpts.
  Known credential-shaped substrings are scrubbed before the BFF builds the provider
  prompt.
- Redacted excerpts of files that the orchestrator selected as relevant. Excerpts pass
  through `redact()` in `@oscharko-dev/keiko-security`
  ([packages/keiko-security/src/redaction.ts](../packages/keiko-security/src/redaction.ts))
  before they are added to the model prompt; built-in patterns scrub OpenAI keys,
  GitHub tokens, AWS access keys, Slack tokens, Google API keys, PEM private-key
  blocks, and `Bearer`/`Basic` auth headers.
- Citation metadata for those excerpts (file path inside the scope, line range, score).

A grounded request never carries:

- Credentials of any kind. Your provider API key stays in
  `KEIKO_PROVIDER_TOKEN_*` env vars or the gateway config and is read only by the BFF.
- Files outside the connected scope. Path containment is enforced at multiple layers
  (`packages/keiko-workspace/src/discovery.ts`, then again at the tools layer).
- Files matching `.gitignore` (unless they were added explicitly to the scope), files
  on the security deny-list, or binary/oversized files.

## What is stored locally?

Three things live on your disk:

1. **Chat history.** SQLite database at `~/.keiko/keiko-ui.db` by default. Override
   via `KEIKO_UI_DATA_DIR`. Resolution precedence is documented in
   [packages/keiko-server/src/store/paths.ts](../packages/keiko-server/src/store/paths.ts).
   Each chat row carries its connected-scope binding (the relative paths and the
   connection timestamp).
2. **Evidence runs.** Per-run JSON manifests under `KEIKO_EVIDENCE_DIR`
   (default: `./.keiko/evidence/`), redacted at persist time
   ([packages/keiko-evidence/src/](../packages/keiko-evidence/src/)). Each manifest
   pins the workflow kind, model id, usage, applied limits, and outcome. Grounded
   connected-context answers also write a `connectedContext` audit section with selected
   scope shape, redacted scope-relative paths, query hash/byte count, tools used,
   citation line ranges, omission reasons, excerpt byte counts, and excerpt hashes. It
   does **not** persist query text or excerpt content.
3. **The connected-scope binding.** A pointer (relative paths + timestamp) on the chat
   row. The scope ID is a SHA-256 prefix of `chatId|connectedAtMs` and is opaque to
   the model.

One thing is process-local but not written to disk:

- **Micro-indexes for connected context.** Keiko may keep a small in-memory index for a
  connected scope so repeated grounded requests can reuse deterministic workspace reads.
  Micro-index entries retain assembled `ConnectedContextPack` objects, including their
  redacted excerpts and scope-relative citation metadata. These indexes are bounded by
  the workflow cache defaults, capped per server process, expire after the micro-index
  TTL, and are cleared when the chat scope is replaced, the chat is closed or deleted,
  or the project is deleted
  ([packages/keiko-server/src/grounded-context-index.ts](../packages/keiko-server/src/grounded-context-index.ts),
  [packages/keiko-server/src/store-handlers.ts](../packages/keiko-server/src/store-handlers.ts)).

The connected context **pack** is never written to disk. A freshly assembled pack is
used to answer one BFF request, and an equivalent pack may remain in the process-local
micro-index until TTL expiry, cache eviction, or an explicit chat/project cleanup hook
runs. See [ADR-0022 D1](adr/ADR-0022-connected-context-privacy.md).

## What travels to the cloud?

Only the model request body. Provider routing is local: Keiko reads
`KEIKO_PROVIDER_TOKEN_<MODEL>` (or the gateway config), constructs an OpenAI-compatible
request, and sends it directly to that provider's endpoint. There is no Keiko-hosted
relay, no telemetry endpoint, no analytics beacon.

## Cleanup

- **Delete a chat:** removes the chat row and its messages. Connected-scope bindings
  on that chat go with it, and any process-local grounded micro-index for the chat is
  cleared.
- **Close a chat or replace/clear its connected scope:** clears any process-local
  grounded micro-index for that chat.
- **Delete a project:** clears any process-local grounded micro-index for that
  workspace root.
- **Delete an evidence run:** evidence runs survive chat deletion (one-way reference —
  [ADR-0022 D3](adr/ADR-0022-connected-context-privacy.md)). Remove a run manifest
  directly via `rm -f $KEIKO_EVIDENCE_DIR/<runId>.json` until a first-class evidence
  deletion control exists. The auditability-over-isolation trade-off is
  intentional: deleting a chat must not erase the audit trail.
- **Clear all evidence:** `rm -rf $KEIKO_EVIDENCE_DIR` (default `./.keiko/evidence/`).

## Retention defaults

The evidence ledger keeps the most recent 50 runs per process
(`DEFAULT_RETENTION.maxRuns`). Override via the audit config; see
[packages/keiko-contracts/src/evidence.ts](../packages/keiko-contracts/src/evidence.ts).
Process-local grounded micro-indexes use the workflow micro-index TTL and per-index
entry cap, plus a server registry cap of 128 scopes; expired entries are swept or
evicted before reuse, and evicted indexes are cleared.

## Per-answer transparency

Every grounded answer in the Conversation Center displays a "Context inspection summary"
region underneath the citations. It reads:

```
Scope: 2 files in files (deadbeef)
Searched: 3× / 16   Read: 5 / 32 files   Bytes: 12,400 / 131,072 B
Input: 8 / 16   Output: 3 / 8   Rerank: 2 / 8
Time: 1,812 / 30,000 ms   Query: natural-language
Omitted: 2 candidates (ignored: 1, denied: 1)
View connected-context audit evidence
```

The values are counts and enums from the `GroundedAnswerContextPackSummary` wire shape
(see [packages/keiko-contracts/src/bff-wire.ts](../packages/keiko-contracts/src/bff-wire.ts)).
No raw paths, query text, or excerpt content reach the summary surface. The evidence
link points to the local manifest described above, which stores redacted metadata and
hashes instead of raw prompt/excerpt text. The privacy contract is enforced by the type
system and by evidence-layer redaction; the test in
[packages/keiko-server/src/grounded-qa.redaction.test.ts](../packages/keiko-server/src/grounded-qa.redaction.test.ts)
proves it by feeding an attacker-controlled pack and asserting nothing leaks.

## Limitations

The following are **not** redacted:

- **Ordinary non-secret question text.** The BFF redacts known credential-shaped
  substrings before sending the prompt, but it does not classify arbitrary private
  prose. Do not paste credentials, customer data, or other private material into chat.
- **Your model/provider selection.** Evidence manifests record the model id you used.
  This is intentional for audit; the credential itself is never written.
- **Line ranges from public source files.** Citations carry path + start/end line. If
  you do not want a file's structure surfaced, do not add it to the connected scope.

## Where this is documented in code

- Wire surface: `GroundedAnswerContextPackSummary` in
  [packages/keiko-contracts/src/bff-wire.ts](../packages/keiko-contracts/src/bff-wire.ts).
- BFF wiring: `runAsk` in
  [packages/keiko-server/src/grounded-qa.ts](../packages/keiko-server/src/grounded-qa.ts).
- Evidence metadata: `connected-context-evidence.ts` in
  [packages/keiko-evidence/src/connected-context-evidence.ts](../packages/keiko-evidence/src/connected-context-evidence.ts).
- Micro-index lifecycle: `grounded-context-index.ts` and chat/project cleanup hooks in
  [packages/keiko-server/src/grounded-context-index.ts](../packages/keiko-server/src/grounded-context-index.ts)
  and [packages/keiko-server/src/store-handlers.ts](../packages/keiko-server/src/store-handlers.ts).
- UI presentation: `ContextPackSummary` in
  [packages/keiko-ui/src/app/components/desktop/GroundedAnswer.tsx](../packages/keiko-ui/src/app/components/desktop/GroundedAnswer.tsx).
- Redaction enforcement: `grounded-qa.redaction.test.ts` in
  [packages/keiko-server/src/grounded-qa.redaction.test.ts](../packages/keiko-server/src/grounded-qa.redaction.test.ts).
- Decision record: [ADR-0022](adr/ADR-0022-connected-context-privacy.md).
