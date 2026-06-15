# Conversation Center Privacy and Retention

When you chat in the Conversation Center, Keiko keeps almost everything on your
local machine. This page documents what is stored locally, what is sent to your
configured model gateway, what is never transmitted, and how to delete it.

## What stays on your local machine

- **Chat messages.** Every user and assistant turn is written to the UI store at
  `~/.keiko/keiko-ui.db` (override via `KEIKO_UI_DATA_DIR`). Resolution
  precedence is documented in
  [packages/keiko-server/src/store/paths.ts](../packages/keiko-server/src/store/paths.ts).
- **Pending attachments.** Files you attach to the composer live in browser
  memory only. They are never written to disk by Keiko and are dropped when you
  close the tab, switch chats, send the message, or remove each chip
  individually using the per-attachment remove button in the strip.
- **Document extraction context.** Issue #148 extracted text from documents you
  attach is composed into the model request body once and is not stored on the
  chat row. It travels with the next send and is then forgotten by the BFF.
- **MemoriaViva records.** Governed memories are stored in the local memory
  vault. Conversation Center requests receive only scoped excerpts and
  provenance metadata for the memories selected for the current turn.
- **Evidence runs.** Workflow runs launched from the Conversation Center (Issue
  #153) write redacted JSON manifests under `KEIKO_EVIDENCE_DIR` (default:
  `./.keiko/evidence/`). The manifest pins workflow kind, model id, usage, and
  outcome. It does **not** persist raw prompt text, raw assistant output, or
  attachment contents.

## MemoriaViva scope, retrieval, and deletion

MemoriaViva is Keiko's local memory surface. It can keep durable facts such as
user preferences, recurring project routines, accepted outcomes, procedural
guidance, and corrections that a reviewer approved or that a governed capture
policy proposed for review. It is not a hosted profile, cloud telemetry, shared
team memory, or a remote audit upload.

Each memory has a scope coordinate:

- **User** memories apply to the local user.
- **Workspace** memories apply to a bounded workspace.
- **Project** memories apply to a selected project path.
- **Workflow** memories apply to a workflow family.
- **Global** memories apply only when the memory was intentionally created with
  global scope.

Retrieval uses those scopes before memory context reaches a prompt. Conversation
requests ask for the current conversation/project scopes; workflow agents ask for
their governed workflow/project scopes. Memories outside the requested scope are
not eligible for that turn. When a memory is retrieved, Keiko may include a
bounded, redacted memory block in the model request. The prompt treats the block
as reference context, not as executable instruction; it cannot trigger tools,
patching, workflow runs, or scope expansion by itself.

MemoriaViva exposes separate lifecycle controls:

- **Approve / reject** decides whether a proposed memory can be recalled later.
- **Edit / correct** updates reviewable memory content. Corrections create a new
  proposed correction and preserve a body-free supersession audit record when
  accepted.
- **Pin / unpin** controls retention priority. Pinned memories are not eligible
  for retention cleanup.
- **Archive** removes a memory from the active working set without deleting the
  audit trail.
- **Forget / delete** removes the active memory record and writes a tombstone so
  reviewers can audit that deletion happened without retaining the raw body in
  diagnostics.
- **Tombstone retention** purges expired tombstones through the local vault port
  when a tombstone-retention threshold is configured.

`keiko memory maintain` runs the same bounded maintenance pass as the UI memory
maintenance route. It can promote strong proposed memories, reinforce frequently
used memories, decay stale memories, archive faded memories, and forget expired
or very low-confidence memories. It can also purge tombstones that are older
than the configured tombstone-retention threshold. Maintenance reports counts
and review items; it does not print memory bodies.

Memory diagnostics are designed for local support and audit review. The
`keiko memory diagnostics` command reports schema version, generated time, scope
counts, status histogram, redacted storage path, and a redacted tail of recent
memory audit events. It does not serialize raw memory bodies or structured
payload values.

The desktop Digital Twin panel does not store separate MemoriaViva entries in
browser `localStorage`. MemoriaViva's user-facing memory surface is the
governed `/memoriaviva` route backed by the local vault and `/api/memory/*`
routes.

## What is sent to the model gateway

The primary chat request carries:

- **Your draft message** (the text you typed).
- **Included memory context** when MemoriaViva is enabled and relevant scoped
  memories are selected for the turn. The system prompt treats those memory
  excerpts as untrusted reference data, not instructions.
- **Extracted document text** for attachments the selected model supports.
  Extraction runs locally and is redacted by `redact()` from
  `@oscharko-dev/keiko-security`
  ([packages/keiko-security/src/redaction.ts](../packages/keiko-security/src/redaction.ts))
  before it reaches the prompt.
- **Recent conversation history** within the context budget for the selected
  model. The estimator
  ([packages/keiko-contracts/src/conversation-budget.ts](../packages/keiko-contracts/src/conversation-budget.ts))
  caps history bytes; you can use **Clear conversation history** to reset.

That request goes directly to your configured provider endpoint. There is no
Keiko-hosted relay, no telemetry beacon, no analytics ping.

When MemoriaViva is enabled, Keiko may make additional calls to the configured
model gateway for memory-specific processing:

- **Semantic retrieval ranking.** If an embedding model is configured and the
  turn text passes the memory capture safety check, Keiko may embed the current
  user draft to rank already-stored local memories. If the text looks like a
  credential, provider endpoint, raw log, configured customer identifier, or
  non-public memory candidate, Keiko skips this embedding call and falls back to
  deterministic local retrieval signals.
- **Salience learning.** After a completed response, Keiko may ask the selected
  chat model to propose durable user-stated facts for review. This call uses the
  user draft only; assistant output is not forwarded into the salience prompt.
  The same memory capture safety check suppresses this call for unsafe turn
  text, and proposed memories still require governed review before they can be
  recalled.

## What is never transmitted to a model

- **Gateway credentials.** Your provider API key stays in the
  `KEIKO_MODEL_<NAME>_API_KEY` env var or the gateway config file and is read
  only by the BFF when assembling the request to your provider.
- **Provider base URLs.** The base URL is server-side only. It does not appear
  in conversation state, UI model lists, error envelopes, or evidence
  manifests.
- **File system paths from outside the connected scope.** When you connect a
  scope (Issue #184), only redacted excerpts inside that scope travel. See
  [docs/connected-context-privacy.md](./connected-context-privacy.md).
- **Raw error bodies from the provider.** The BFF runs `redact()` over every
  conversation error message before it is returned to the UI; `sk-…`,
  `ghp_…`, `AKIA…`, `Bearer …` and configured literal secrets are scrubbed.
- **Assistant output for MemoriaViva salience learning.** Conversation replies
  are stored in chat history, but they are not forwarded to the separate
  salience-learning model call.

## How to delete conversation data

The Conversation Center exposes the following retention controls inline in the chat:

1. **Remove pending attachment.** Each pending attachment chip in the
   composer strip carries an individual remove button. Clicking it removes
   that attachment before send. There is no bulk "clear all" affordance;
   each attachment must be removed individually. Does not touch chat history.
2. **Clear conversation history.** The context-budget indicator in the
   composer includes a "Clear history" button. Clicking it empties the
   in-memory message list for the next prompt so no prior turns are replayed
   to the model. The chat row is retained so you can keep the topic open.
   This control is visible only when a model with a known context-window limit
   is selected and the budget indicator is shown.
3. **Delete conversation** _(API only — not yet surfaced in the UI)._
   The `deleteChat` API (`DELETE /api/chats?id=…`) exists and removes the
   entire chat row and every persisted message from `keiko-ui.db`. The
   corresponding evidence runs are intentionally kept — deletion of a chat
   must not erase the audit trail. A visible affordance (delete button) is a
   documented follow-up. See
   [docs/connected-context-privacy.md](./connected-context-privacy.md#cleanup)
   for the broader cleanup contract.

Project-wide cleanup (deleting a project, clearing a connected scope,
clearing all evidence) is documented in
[docs/connected-context-privacy.md](./connected-context-privacy.md).

## Where audit and evidence records are stored

Conversation Center workflow runs (Issue #153) and grounded answers (Issue
#185) write evidence to `KEIKO_EVIDENCE_DIR`. Every manifest goes through the
live-payload redactor at persist time
([packages/keiko-server/src/deps.ts](../packages/keiko-server/src/deps.ts):
`buildRedactor`), so credential-shaped substrings, `Bearer` tokens, and
configured literal secrets never reach disk. Manifests record metadata
(workflow kind, model id, usage counters, outcome, redacted error messages),
not raw conversation content.

MemoriaViva audit records use the same evidence store. Memory audit events cover
proposal, acceptance, rejection, update, supersession, pin/unpin, archive,
forget/delete, retrieval, workflow use, workflow omission, and workflow
write-candidate proposals. Audit summaries, storage paths, and scope coordinates
are redacted before persistence; raw memory bodies and payloads are excluded from
the audit event model.

## Limitations

The following are **not** redacted:

- **Ordinary non-secret message text.** The BFF scrubs known credential shapes,
  but it does not classify arbitrary private prose. Do not paste credentials,
  customer data, or other private material into chat.
- **Your model selection.** Evidence manifests record the model id you used.
  The credential itself is never written.

## Where this is documented in code

- Conversation redaction at the BFF boundary:
  [packages/keiko-server/src/chat-handlers.ts](../packages/keiko-server/src/chat-handlers.ts)
  (`desktopChatErrorResult`).
- Redactor surface:
  [packages/keiko-server/src/deps.ts](../packages/keiko-server/src/deps.ts)
  (`buildRedactor`, `currentRedactionSecrets`).
- Retention UI controls:
  [packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx](../packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx).
- Audit redaction tests:
  [packages/keiko-server/src/conversation-audit.test.ts](../packages/keiko-server/src/conversation-audit.test.ts).
- Retention UI tests:
  [packages/keiko-ui/src/app/components/desktop/ConversationRetention.test.tsx](../packages/keiko-ui/src/app/components/desktop/ConversationRetention.test.tsx).
- Connected-context privacy (sibling document):
  [docs/connected-context-privacy.md](./connected-context-privacy.md).
- Local runtime state contract:
  [docs/local-runtime-state-contract.md](./local-runtime-state-contract.md).
- Security and audit boundaries:
  [docs/security-and-audit-boundaries.md](./security-and-audit-boundaries.md).
- MemoriaViva BFF routes:
  [packages/keiko-server/src/memory-handlers.ts](../packages/keiko-server/src/memory-handlers.ts).
- Memory audit and diagnostics:
  [packages/keiko-server/src/memory-audit-handler.ts](../packages/keiko-server/src/memory-audit-handler.ts),
  [packages/keiko-server/src/memory-diagnostics.ts](../packages/keiko-server/src/memory-diagnostics.ts).
