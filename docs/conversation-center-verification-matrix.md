# Conversation Center — Verification Matrix

This document is the closure-evidence artifact for Epic
[#142](https://github.com/oscharko-dev/Keiko/issues/142). It maps every
Conversation Center release-level acceptance criterion to the package,
file, and test that satisfies it, and records the integration evidence
that must be run before the epic branch is opened for human review.

Issue [#155](https://github.com/oscharko-dev/Keiko/issues/155) is the
home for this matrix and for the integrated release-gate test at
[`packages/keiko-server/src/conversation-center-release-gate.test.ts`](../packages/keiko-server/src/conversation-center-release-gate.test.ts).

## Release-gate npm script

```bash
npm run conversation:release-check
```

This script runs, in order:

1. `npm run typecheck`
2. `npm run lint`
3. `npm run arch:check` and `npm run arch:check:negative`
4. `npm test` (vitest across the server, root, and non-UI workspace
   packages, including the release-gate file; keiko-ui tests are
   intentionally excluded from this suite and are gated instead by the
   separate CI `ui` job — see `.github/workflows/ci.yml`)
5. `tsc -p tsconfig.build.json` to produce `dist/cli/index.js`,
   followed by a smoke confirmation that the binary boots
   (`node dist/cli/index.js --version`)

A green run of `conversation:release-check` plus a manual pass of the
[Browser smoke checklist](#browser-smoke-checklist) below is the gate on
shipping epic [#142](https://github.com/oscharko-dev/Keiko/issues/142).

## Acceptance-criterion coverage map

The acceptance criteria are taken verbatim from issue
[#155](https://github.com/oscharko-dev/Keiko/issues/155).

### AC1 — Text conversation works with a freshly npm-installed Keiko package and configured OpenAI-compatible gateway

- **Test type** — integration (server) + manual smoke
- **Coverage path**
  - `packages/keiko-server/src/conversation-center-release-gate.test.ts` →
    `it("AC1: text happy path …")`
  - `packages/keiko-server/src/desktop-chat-handlers.test.ts` →
    `it("creates a GPTOSS chat scoped to a validated local project")` and
    `it("persists user and assistant messages while calling the configured model port")`
  - `packages/keiko-model-gateway/src/capabilities.test.ts` (chat capability
    contract, [#143](https://github.com/oscharko-dev/Keiko/issues/143))
- **Manual verification steps**
  1. `npm pack` the workspace and `npm install ./oscharko-dev-keiko-*.tgz`
     into a scratch directory.
  2. Configure an OpenAI-compatible gateway (`KEIKO_GATEWAY_*` env or
     `keiko.config.json`).
  3. Run `npx keiko ui`, open the Conversation Center, send a plain text
     message, and confirm an assistant response renders.
- **Evidence form** — vitest output for the two tests above, plus the
  audit ledger entry written by the live BFF run.

### AC2 — Unsupported image/document sends are blocked before provider calls

- **Test type** — integration (server) + unit (UI)
- **Coverage path**
  - `packages/keiko-server/src/conversation-center-release-gate.test.ts` →
    `it("AC2: image attachment on text-only model …")`,
    `it("AC2: document attachment on text-only model …")`,
    `it("AC2: embedding model rejected on send …")`,
    `it("AC2: oversized documentContext …")`
  - `packages/keiko-server/src/conversation-validation.test.ts` (all 16
    cases — modality, mime allowlist, size cap, aggregate cap)
  - `packages/keiko-server/src/desktop-chat-handlers.test.ts` →
    embedding / image / document rejection cases at the wire level
  - `packages/keiko-ui/src/app/components/desktop/AttachmentIntake.test.tsx`
    (UI mirror, [#147](https://github.com/oscharko-dev/Keiko/issues/147))
  - `packages/keiko-workspace/**/document-extraction*.test.ts` (safe
    extraction, [#148](https://github.com/oscharko-dev/Keiko/issues/148))
- **Manual verification steps**
  1. Pick a text-only model in the Conversation Center model picker.
  2. Try to attach an image — expect a typed rejection toast and no
     network request to the provider.
  3. Try to attach a `.bin` document — expect rejection.
- **Evidence form** — vitest output. Gateway spy `seenRequests` is
  asserted empty on every rejection, which is the AC.

### AC3 — Model switching is verified before and after conversation creation

- **Test type** — integration (server) + unit (UI)
- **Coverage path**
  - `packages/keiko-server/src/conversation-center-release-gate.test.ts` →
    `it("AC3: PATCH /api/chats updates selectedModel; reload via GET sees the new model")`
  - `packages/keiko-server/src/desktop-chat-handlers.test.ts` →
    `it("uses the configured custom chat model as the default when no modelId is supplied")`
  - `packages/keiko-ui/src/app/components/desktop/ModelSelection.test.tsx`
    ([#144](https://github.com/oscharko-dev/Keiko/issues/144),
    [#145](https://github.com/oscharko-dev/Keiko/issues/145))
- **Manual verification steps**
  1. Open the empty-state composer; confirm the model picker lists every
     chat-capable model and pre-selects the configured default.
  2. Switch model before sending — send a message, confirm the request
     used the new model.
  3. After at least one assistant turn, switch model again — send another
     message, confirm the new model was used and the previous transcript
     remains intact.
- **Evidence form** — vitest output + UI screenshot of the picker state
  before and after switch (no sensitive content).

### AC4 — Long-running responses show visible progress and support failure recovery

- **Test type** — unit (UI) + manual smoke
- **Coverage path**
  - `packages/keiko-ui/src/app/components/desktop/Streaming.test.tsx`
    ([#152](https://github.com/oscharko-dev/Keiko/issues/152))
  - `packages/keiko-ui/src/app/components/desktop/ChatWindow.test.tsx`
    (Send↔Cancel button flip)
- **Manual verification steps**
  1. Send a prompt the configured model will take >5s to answer.
  2. Confirm a `role="status"` indicator is visible while the response
     streams.
  3. Click Cancel — confirm the state transitions to `cancelled`, no fake
     answer is persisted, and the Send button is re-enabled.
- **Evidence form** — vitest output + screen recording of cancel flow.

### AC5 — Repository-aware questions over a connected Files window scope return evidence-backed answers or explicit uncertainty without hidden full-repository indexing

- **Test type** — integration (server)
- **Coverage path**
  - `packages/keiko-server/src/grounded-qa.test.ts` (24 cases covering
    connected-scope routing, citations, uncertainty, no-evidence marker,
    budget projection)
  - `packages/keiko-server/src/grounded-qa.redaction.test.ts` (user text
    redaction before persistence)
  - `packages/keiko-server/src/grounded-orchestrator.test.ts` (scope
    boundary; no recursive indexing)
  - `packages/keiko-server/src/grounded-context-index.test.ts`
- **Manual verification steps**
  1. Connect a Files window scope of three files in a small project.
  2. Ask a question whose answer is in one of the files — confirm the
     answer cites only those files.
  3. Ask a question whose answer is NOT in the connected files — confirm
     the response renders explicit insufficient-evidence text and the
     citation list is empty.
  4. Confirm no background full-repo indexing job started (no spike in
     CPU or disk while idle).
- **Evidence form** — vitest output; manual screenshot of the
  cited-citations vs. uncertainty UI; audit-ledger entry showing the
  connected-context pack `fileCount` matches scope.

### AC6 — Indexed document-knowledge questions over a selected capsule return cited grounded answers or explicit insufficient-evidence states without hidden document indexing

- **Test type** — integration (server)
- **Coverage path**
  - `packages/keiko-server/src/grounded-qa.test.ts` (citation projection,
    no-evidence marker)
  - `packages/keiko-local-knowledge/**/*.test.ts` (capsule build,
    [#192](https://github.com/oscharko-dev/Keiko/issues/192) /
    [#193](https://github.com/oscharko-dev/Keiko/issues/193) /
    [#195](https://github.com/oscharko-dev/Keiko/issues/195))
  - `packages/keiko-server/src/grounded-context-index.test.ts`
- **Manual verification steps**
  1. Build a local knowledge capsule against a small document corpus
     (`keiko` local-knowledge subcommand).
  2. Select the capsule in the Conversation Center document-knowledge
     picker.
  3. Ask a question grounded in the capsule — confirm citations and
     answer.
  4. Ask a question not covered by the capsule — confirm insufficient
     evidence.
  5. Confirm no background re-indexing started during the question.
- **Evidence form** — vitest output; capsule manifest hash recorded in
  audit ledger.

### AC7 — Memory-aware questions show included memory context, support memory-off mode, and exclude deleted or out-of-scope memory

- **Test type** — integration (server) + unit (contracts)
- **Coverage path**
  - `packages/keiko-server/src/memory-conv-handlers.test.ts`
    ([#212](https://github.com/oscharko-dev/Keiko/issues/212))
  - `packages/keiko-memory-retrieval/**/*.test.ts`
    ([#210](https://github.com/oscharko-dev/Keiko/issues/210))
  - `packages/keiko-memory-governance/**/*.test.ts` (selective forget
    suppression, [#209](https://github.com/oscharko-dev/Keiko/issues/209))
  - `packages/keiko-memory-vault/**/*.test.ts` (scope isolation,
    [#206](https://github.com/oscharko-dev/Keiko/issues/206))
- **Manual verification steps**
  1. Capture a memory in scope A (e.g., a stated user preference).
  2. Ask a question relevant to that memory — confirm the included
     memory block is shown to the user.
  3. Toggle memory-off mode — re-ask the same question and confirm the
     memory block is empty.
  4. Switch to scope B — confirm scope-A memory is not included.
  5. Delete the memory — confirm it no longer appears in retrieval.
- **Evidence form** — vitest output; UI screenshot of the included-memory
  panel with no secret content.

### AC8 — Final evidence can be attached to release PRs without customer secrets, customer model screenshots, or private endpoint details

- **Test type** — integration (server) + unit
- **Coverage path**
  - `packages/keiko-server/src/conversation-center-release-gate.test.ts` →
    `it("AC8: validation error redacts caller-supplied model id and file name …")`
  - `packages/keiko-server/src/conversation-audit.test.ts` (Bearer
    redaction, provider base URL redaction, third-party credential
    redaction, wire error envelope shape;
    [#154](https://github.com/oscharko-dev/Keiko/issues/154))
  - `packages/keiko-server/src/conversation-prompt.test.ts` (prompt
    composition does not echo secret patterns;
    [#150](https://github.com/oscharko-dev/Keiko/issues/150))
  - `packages/keiko-ui/src/app/components/desktop/ConversationRetention.test.tsx`
    (retention controls)
  - `packages/keiko-ui/src/lib/safe-markdown.test.ts` (script/embed
    stripping, [#150](https://github.com/oscharko-dev/Keiko/issues/150))
- **Manual verification steps**
  1. Run a Conversation Center session that triggers a synthetic gateway
     error (e.g., point the gateway at an unreachable URL).
  2. Export the run's evidence manifest via `keiko evidence show`.
  3. Manually inspect the JSON — confirm it contains no `Bearer`, no
     `sk-` / `ghp_` / `AKIA` shapes, no provider base URL, and no
     customer message bodies.
- **Evidence form** — `keiko evidence show` output attached to the PR
  with the verification matrix link; the on-disk audit ledger is the
  source of record.

## Browser smoke checklist

Run the following on both Firefox and Chromium (Chrome / Edge) against
the freshly installed package:

1. Install the package into a scratch directory and start the UI:
   ```bash
   mkdir /tmp/keiko-release-smoke && cd /tmp/keiko-release-smoke
   npm init -y
   npm install /path/to/oscharko-dev-keiko-*.tgz
   npx keiko init
   npx keiko start
   # or, equivalently, for a foreground run:
   #   npx keiko ui
   ```
   Confirm the UI URL is `http://127.0.0.1:<port>` (loopback only).
2. Open the Conversation Center.
3. Send a text message — confirm the response renders as safe markdown
   with no executable content.
4. Pick a text-only model — try to attach an image — confirm rejection
   with a typed error toast.
5. Pick a model with `supportsImageInput=true` — attach a `.png` —
   confirm the attachment chip shows file name and size.
6. Send a prompt that will take >5s — confirm the streaming progress
   indicator is visible — click Cancel — confirm the state transitions
   to `cancelled` and no fake assistant answer is persisted to the
   transcript.
7. Connect a Files window scope of three files — ask a question covered
   by the files — confirm citations — ask a question not covered —
   confirm explicit insufficient-evidence text.
8. Open the audit panel and export the evidence manifest — confirm no
   secret-shaped strings (`Bearer `, `sk-`, `ghp_`, `AKIA`,
   `https?://provider`) appear in the exported JSON.

Record per-browser pass / fail (P / F) in the release PR description.

## Architecture invariants

| Invariant                                                       | Enforcement                                                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing architecture and quality gates preserved               | ADR-0019 direction rules at `error` severity; `arch:check:negative` pins `EXPECTED_RULES` to the contracted count                             |
| Provider calls always behind the Model Gateway                  | `desktop-chat-handlers` route uses `modelPortFactory(config)`; no direct provider SDK import in the conversation path                         |
| Modality guardrails live server-side                            | `validateConversationPayload` runs before the gateway port is invoked; covered by `conversation-validation.test.ts` and the release-gate test |
| Wire error messages are static / value-free                     | `conversation-validation.ts` `MSG_*` constants; pinned by `conversation-validation.test.ts` line 206 and the release-gate AC8 test            |
| Audit ledger redacted at the BFF boundary                       | `buildRedactor(deps.redactionSecrets)` applied in `chat-handlers.ts`; pinned by `conversation-audit.test.ts`                                  |
| Grounded answers scoped strictly to the connected scope         | `grounded-orchestrator` pack budget + file list comes from the connected scope; pinned by `grounded-qa.test.ts` connected-scope tests         |
| Memory retrieval is bounded, explainable, scope-isolated        | `memory-conv-handlers.ts` + `keiko-memory-retrieval`; pinned by `memory-conv-handlers.test.ts`                                                |
| No customer secrets, model screenshots, or endpoints in release | Documented in [`docs/conversation-center-privacy.md`](conversation-center-privacy.md); pinned by the AC8 negative-pattern sweep               |

## Integration evidence

Each child PR for epic [#142](https://github.com/oscharko-dev/Keiko/issues/142)
ran cold-cache `typecheck` / `lint` / `arch:check{,:negative}` / `test`
from the repo root before merging to `dev`. The closure evidence for
issue [#155](https://github.com/oscharko-dev/Keiko/issues/155) is a
green run of `npm run conversation:release-check` plus the browser
smoke checklist above.
