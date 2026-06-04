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

- Your question text (verbatim).
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
   pins the workflow kind, model id, usage, applied limits, and outcome.
3. **The connected-scope binding.** A pointer (relative paths + timestamp) on the chat
   row. The scope ID is a SHA-256 prefix of `chatId|connectedAtMs` and is opaque to
   the model.

The connected context **pack** itself — the in-process bundle that carries the actual
excerpts — is ephemeral. It exists only for the duration of one BFF request. See
[ADR-0022 D1](adr/ADR-0022-connected-context-privacy.md).

## What travels to the cloud?

Only the model request body. Provider routing is local: Keiko reads
`KEIKO_PROVIDER_TOKEN_<MODEL>` (or the gateway config), constructs an OpenAI-compatible
request, and sends it directly to that provider's endpoint. There is no Keiko-hosted
relay, no telemetry endpoint, no analytics beacon.

## Cleanup

- **Delete a chat:** removes the chat row and its messages. Connected-scope bindings
  on that chat go with it.
- **Delete an evidence run:** evidence runs survive chat deletion (one-way reference —
  [ADR-0022 D3](adr/ADR-0022-connected-context-privacy.md)). Remove a run manifest
  directly via `rm -f $KEIKO_EVIDENCE_DIR/<runId>.json` until issue #154 ships a
  first-class `keiko evidence rm`. The auditability-over-isolation trade-off is
  intentional: deleting a chat must not erase the audit trail.
- **Clear all evidence:** `rm -rf $KEIKO_EVIDENCE_DIR` (default `./.keiko/evidence/`).

## Retention defaults

The evidence ledger keeps the most recent 50 runs per process
(`DEFAULT_RETENTION.maxRuns`). Override via the audit config; see
[packages/keiko-contracts/src/evidence.ts](../packages/keiko-contracts/src/evidence.ts).

## Per-answer transparency

Every grounded answer in the Conversation Center displays a "Context inspection summary"
region underneath the citations. It reads:

```
Scope: 2 files in files (deadbeef)
Searched: 3× / 16   Read: 5 / 32 files   Bytes: 12,400 / 131,072 B
Time: 1,812 / 30,000 ms   Query: natural-language
```

The values are counts and enums from the `GroundedAnswerContextPackSummary` wire shape
(see [packages/keiko-contracts/src/bff-wire.ts](../packages/keiko-contracts/src/bff-wire.ts)).
No raw paths, query text, or excerpt content reach this surface. The privacy contract
is enforced by the type system; the test in
[packages/keiko-server/src/grounded-qa.redaction.test.ts](../packages/keiko-server/src/grounded-qa.redaction.test.ts)
proves it by feeding an attacker-controlled pack and asserting nothing leaks.

## Limitations

The following are **not** redacted:

- **Your question text.** It is sent to the model as you typed it. If you paste a
  credential into the chat composer, that credential goes to the model. Do not paste
  credentials into chat.
- **Your model/provider selection.** Evidence manifests record the model id you used.
  This is intentional for audit; the credential itself is never written.
- **Line ranges from public source files.** Citations carry path + start/end line. If
  you do not want a file's structure surfaced, do not add it to the connected scope.

## Where this is documented in code

- Wire surface: `GroundedAnswerContextPackSummary` in
  [packages/keiko-contracts/src/bff-wire.ts](../packages/keiko-contracts/src/bff-wire.ts).
- BFF wiring: `runAsk` in
  [packages/keiko-server/src/grounded-qa.ts](../packages/keiko-server/src/grounded-qa.ts).
- UI presentation: `ContextPackSummary` in
  [packages/keiko-ui/src/app/components/desktop/GroundedAnswer.tsx](../packages/keiko-ui/src/app/components/desktop/GroundedAnswer.tsx).
- Redaction enforcement: `grounded-qa.redaction.test.ts` in
  [packages/keiko-server/src/grounded-qa.redaction.test.ts](../packages/keiko-server/src/grounded-qa.redaction.test.ts).
- Decision record: [ADR-0022](adr/ADR-0022-connected-context-privacy.md).
