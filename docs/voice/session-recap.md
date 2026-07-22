# Voice Session Recap — user-triggered memory capture from committed transcript with governed review

**Audience:** maintainers of the historical #504 recap contract, operators, and security reviewers.

> **Current amendment (ADR-0154):** the original #504 memory-gap premise is superseded. Productive
> Twin Voice now persists every settled final transcript as the ordinary canonical user message, so
> the normal per-turn MemoriaViva capture path processes spoken facts exactly as it processes typed
> facts. Raw audio and partial transcripts remain ephemeral. The recap contract and
> `POST /api/voice/recap/build` server route still exist, but the current UI has no recap component or
> hook and does not feed the legacy segment store into that route. The historical design below applies
> only to an explicit recap-route request; its "transcript is never persisted" statements must not be
> read as claims about canonical Twin chat.

Specification for Epic #491, the deliverable of Issue
[#504](https://github.com/oscharko-dev/Keiko/issues/504) and the authoritative companion to
[ADR-0109](../adr/ADR-0109-voice-session-recap.md). It **defines** the recap feature, the data-retention contract, the memory capture integration, the capability gating, and the content-free audit model. The contract lives in
[`packages/keiko-contracts/src/voice-session-recap.ts`](../../packages/keiko-contracts/src/voice-session-recap.ts);
the still-registered server handler lives in
[`packages/keiko-server/src/voice-recap.ts`](../../packages/keiko-server/src/voice-recap.ts). The UI
hook and component described by the original issue are not present in the current tree.

## 0. Historical purpose: Capture a separate voice session as reviewable memory

> At the #504 implementation point, full-realtime voice conversations carried user speech over the
> WebRTC audio plane without a canonical text-chat request. The existing per-turn memory capture path
> therefore received no `request.content` for those turns. ADR-0154 removed that architecture: a settled
> final is now the canonical user message and no separate memory gap remains.
>
> **Session recap fills this gap.** It is a user-triggered feature that derives memory candidates
> exclusively from the committed voice transcript projection for the entire session, using the
> **existing** governed memory capture path (`extractCandidatesFromUserText`). The recap preserves
> all governance: secrets are redacted, scope inference fails closed, sensitivity classification
> applies. Candidates surface in the existing review queue as proposals (`status: "proposed"`) for
> explicit user approval, edit, or rejection.
>
> No raw audio, no unreviewed transcript text, and no assistant claims are stored. The user controls
> what enters permanent memory through two deliberate actions: triggering recap, then accepting
> candidates in the review queue.

## 1. Scope and data-retention contract

- **In scope:** the recap trigger mechanism; capability gating based on `voiceRecapAllowed`; memory
  candidate derivation via `extractCandidatesFromUserText` from committed transcript projection only;
  content-free audit record; integration with the existing memory review queue; data-retention
  guarantees (what is retained locally, what is never stored by default).
- **Out of scope (deferred to later issues):** visible session transcript display before recap trigger
  (see §10).

**Versioning:** `VOICE_SESSION_RECAP_SCHEMA_VERSION = "1"`. A breaking change introduces a new
literal rather than mutating `"1"`. It is independent of `VOICE_TRANSCRIPT_SCHEMA_VERSION`,
`VOICE_ACTION_INTENT_SCHEMA_VERSION`, and `CONVERSATION_CAPABILITY_CONTRACT_VERSION`.

## 2. Legacy recap-route data-retention contract

The guarantees in this section apply to an explicit recap-route request. Canonical Twin chat separately
persists the settled final user message and its governed chat metadata under ADR-0154.

### Retained locally (with explicit user control)

After a user triggers recap and **approves candidates in the review queue:**

- **Governed memory candidates** (in the vault under `status: "accepted"`): key phrases, facts,
  corrections, and preferences extracted from the user's committed voice transcript via
  `extractCandidatesFromUserText`. These are never raw transcript excerpts; they are structured
  facts classified by sensitivity (public, sensitive, credentials redacted) and scope (project,
  workspace, user). Approval requires explicit user action in the review queue.
- **Content-free audit records** (in the evidence store): record that a recap was triggered, how many
  candidates were extracted, how many were rejected by policy, and the aggregate character count of
  the committed transcript — no transcript text, no audio, no assistant claims.

### Never stored by default

- **Raw audio** — no audio is stored after it flows through the WebRTC media plane. No local cache,
  no server-side persistence of audio blobs.
- **Unreviewed transcript text as durable truth** — the committed transcript projection is held in
  local memory during the session and is transmitted to the server once for extraction. It is never
  persisted in the server as a raw transcript. After extraction, the server retains only the audit
  record (which carries a character count, not text).
- **Provider credentials, endpoints, or metadata** — no API keys, model IDs, provider URLs, or
  authentication tokens are carried in audit records or candidate structures.
- **Assistant response text as user fact** — the assistant's conversational replies are context-only
  and never submitted to the memory extraction engine. `VoiceRecapAssistantTurnDescriptor` records
  only that an assistant turn occurred, not what was said.
- **Unreviewed proposals** — recap candidates with `status: "proposed"` remain in the vault pending
  explicit user action (accept, reject, or forget). They are not marked as facts or preferences until
  the user approves them. A user who triggers recap but then closes the tab without reviewing
  candidates leaves them in a proposed state, never auto-promoting them to accepted.

### Dormancy when voice is unavailable

When the voice profile is `"none"` or `"speech-output"` (no speech input capability):

- The recap UI control does not appear.
- No network call to build recap candidates is made.
- No local state is read or stored.
- No observer fires.

This is an **AC1 dormancy guarantee** by construction (see §3).

## 3. Capability gating and dormancy

`voiceRecapAllowed(profile: VoiceProfile): boolean` is derived from
`voiceTranscriptCaptureAllowed(profile)`:

| Profile          | `voiceRecapAllowed` | Reason                                   |
| ---------------- | ------------------- | ---------------------------------------- |
| `none`           | **no**              | No voice input; recap is not applicable  |
| `speech-to-text` | **yes**             | STT dictation produces committed text    |
| `speech-output`  | **no**              | No speech input; only assistant playback |
| `full-realtime`  | **yes**             | Full WebRTC conversation produces text   |

**AC1 enforcement (dormancy):** The UI hook short-circuits at the predicate before reading any
stored state or making network calls. The "Review session" button does not render unless
`voiceRecapAllowed(profile) === true` AND `committedSegmentCount > 0`.

## 4. How recap derives memory candidates: reused governed capture

Memory candidates are derived by calling `extractCandidatesFromUserText()` from
`@oscharko-dev/keiko-memory-capture` — the same entry point that the per-turn chat handler uses
(`collectMemoryActions`). This reuse is **load-bearing for governance:**

- `scanForSecrets`: credential/provider-URL rejection applied at candidate generation; secrets never
  reach the vault.
- Scope inference: unknown scope → candidate rejected.
- Sensitivity classification: each candidate is classified (public, sensitive, credentials required).
- `buildProposal`: produces a `MemoryProposal` with `initialStatus: "proposed"`.

### Input source: committed transcript only

The recap input is **exclusively** `selectCommittedVoiceTranscript(segments).text` — the projection
that contains only `committed` and `corrected` segments (see
[transcript-semantics.md](transcript-semantics.md) §7 for the exact definition). Partial, stable,
discarded, redacted, and provider-error segments are structurally excluded by construction.

For STT dictation, the committed text may overlap with the dictated text submitted in `request.content`
for per-turn capture. This overlap is handled by vault deduplication (see §5).

### Extraction timing and flow

1. User presses "Review session" button in the recap control.
2. UI hook sends `POST /api/voice/recap/build` with the committed text and transcript counts.
3. Server receives the request and invokes `extractCandidatesFromUserText` once per committed span.
4. For each `CaptureOutcome` of kind `"candidate"` that passes the `isPersistableMemoryCandidate` filter
   (public, no required approval): insert into vault with `initialStatus: "proposed"`.
5. Count rejections (sensitive, approval-gated, and other non-persistable outcomes) and return the proposal
   count and vault ids to the client.
6. Candidates automatically appear in the existing memory review queue.

### Content redaction before candidate storage

When a candidate's text contains secrets (detected by `scanForSecrets`), the candidate is rejected
and a content-free count is recorded. The secret-containing text never reaches the vault and does
not enter the proposal pool. This ensures that credentials, API keys, and provider tokens cannot
leak into memory via voice recap.

## 5. Memory review and deduplication

### Candidates surface in the existing review queue

Recap proposals enter the vault as `status: "proposed"` and are automatically included in the
response of `GET /api/memory/review-queue`, which filters for `status: ["proposed", "conflicted", "expired"]`.

The user reviews, edits, accepts, or rejects candidates using the existing endpoints:

- Accept: `POST /api/memory/proposals/:id/accept`
- Reject: `POST /api/memory/proposals/:id/reject`
- Edit: `PATCH /api/memory/:id`
- Forget (remove): `POST /api/memory/:id/forget`

**No new governance endpoints, no new mutation surface.** The recap only writes new proposals to the
vault; it does not modify, accept, or reject existing ones. The user is the sole authority to
transition candidates from proposed to accepted.

### Deduplication for STT dictation

For STT dictation sessions, the same text can produce candidates twice:

1. **Per-turn proposal:** when the user sends a chat request with `request.content` = the STT
   dictation text, `collectMemoryActions` extracts candidates.
2. **Recap proposal:** when the user triggers recap, the same committed text is extracted again.

**Deduplication layers:**

1. **Vault scope+body dedup:** the memory vault detects proposals with identical `scope + body` and
   either merges them or raises a conflict marker, rather than creating exact duplicates. This is
   the existing vault behavior; recap relies on it without new code.
2. **Review queue visibility:** if a near-duplicate reaches the queue, the user sees it and can
   reject it explicitly.

**Architecture note:** The recap feature is primarily targeted at full-realtime sessions where
`request.content` is empty (audio over WebRTC, not in the HTTP body), so double-proposal risk is low
in the primary use case. For STT dictation, vault dedup and review-queue visibility provide the path
to user control.

## 6. UI control and user agency

### The "Review session" button

When `voiceRecapAllowed(profile) === true` and the committed transcript contains at least one
segment:

- A "Review session" button appears in the ChatWindow voice controls (alongside dictation and
  realtime indicators).
- On click, the button triggers the recap build endpoint and navigates to the memory review queue,
  filtered to show recap candidates.
- No modal, no multi-step confirmation flow, no additional "confirm capture" prompt.

### Post-trigger state

After recap completes:

- The client receives `{ candidatesProposed: number; candidatesRejected: number }` (counts only, no
  text).
- The UI navigates to the review queue with a filter or highlight showing the newly proposed
  candidates.
- The user can accept, reject, or edit candidates using the existing review UI.
- Closing the review queue without action leaves candidates in `status: "proposed"` until the user
  acts on them.

### Design-system tokens

The recap button reuses existing design-system tokens; no new CSS classes are introduced.
`design-system/globals.css` is untouched.

## 7. Content-free invariants

Every type and boundary in the recap feature is content-free by construction:

| Type / Boundary                            | Fields                                                           | Never contains           |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------ |
| `VoiceSessionRecapAuditRecord`             | counts, enums, duration, profile                                 | text, audio, credentials |
| `VoiceRecapCommittedSpanDescriptor`        | spanIndex, charCount, segmentCount, seq                          | transcript text          |
| `VoiceRecapAssistantTurnDescriptor`        | turnIndex, source enum                                           | assistant text, audio    |
| `POST /api/voice/recap/build` request body | committedSpans, transcript roll-up (transient, extraction input) | —                        |
| `POST /api/voice/recap/build` response     | candidatesProposed, candidatesRejected, proposalIds              | transcript text, audio   |
| Memory audit record in evidence store      | counts, timestamps, effect enum                                  | raw transcript           |

The contract module is scanned for forbidden substrings as a test invariant: apikey, secret,
password, credential, bearer, baseurl, endpoint, authorization, privatekey, accesskey, token,
systemprompt, toolauthority, grantedtools, allowedtools, canexecute. Any match in the module source
fails the test.

## 8. Assistant turns are not extracted as facts

The recap derives candidates from the user's committed text only. The assistant's response text is
**not** submitted to `extractCandidatesFromUserText` and does not produce memory candidates.

This preserves the invariant established by the per-turn path (`collectMemoryActions`): the
assistant's response is context for salience scoring, not a fact to be stored about the user.

`VoiceRecapAssistantTurnDescriptor` records that an assistant turn occurred (for audit and metrics)
but carries no assistant response text, making it safe to store in audit records without risk of
storing assistant claims as user facts.

## 9. Trigger is user-driven, not automatic

Recap is **triggered explicitly by the user**, not automatically when a voice session ends. This
decision is load-bearing:

1. **Ambiguous session boundaries:** Keiko has no single "session close" event. STT dictation is
   per-message; full-realtime WebSocket disconnects on idle, navigation, or explicit close. An
   automatic trigger tied to disconnection would fire on transient reconnects and tab-switches,
   producing unwanted proposals.
2. **User agency over retention:** The "no unreviewed transcript claims as durable truth" guarantee
   requires active user control. Passive automatic extraction violates this principle.
3. **Synchronous with intent:** A user-triggered action at the moment of button press captures the
   committed state authoritative to the user's intent. An automatic trigger on disconnect would race
   against corrections still in flight.

## 10. Deferred: visible session transcript summary

The render path that displays the committed transcript text to the user before they decide to trigger
recap is **deferred**. This mirrors the deferral posture of ADR-0103 D10, ADR-0104 D10, ADR-0107 D10,
and ADR-0108 D9.

The original #504 `VoiceRecap.tsx` component and hook seam were intended to provide structure for
this future addition, but neither is present in the current tree:

- `binding.committedSegmentCount` exposes a count (not text) for a summary like "you have N committed
  voice turns to review."
- A future issue can add a disclosure panel showing the committed text before the user presses
  "Review session."
- A future product surface would require new, current integration and acceptance work; the server
  contract alone does not imply a UI seam.

## 11. No external destinations

No raw transcript, audio buffer, provider URL, or session token associated with the recap escapes
the client or BFF:

- The committed text is sent to the server once, for extraction.
- No external storage (S3, analytics, logging pipelines) receives transcript or audio.
- Evidence records are stored in Keiko's local or hosted vault only.
- No provider is queried for summarization, sentiment, or filtering; recap uses the local
  extraction engine only.

This preserves the privacy-first principle (ADR-0100).

## 12. Server route specification

### `POST /api/voice/recap/build`

**Request:**

```json
{
  "committedSpans": ["string (each non-empty after trim)"],
  "transcript": {
    "schemaVersion": "1",
    "segmentCount": "number",
    "committedCount": "number",
    "correctedCount": "number",
    "discardedCount": "number",
    "redactedCount": "number",
    "providerErrorCount": "number",
    "committedChars": "number",
    "highestSeq": "number"
  }
}
```

**Capability check:**

- `voiceRecapAllowed(serverTrustedVoiceProfile(deps))` against **deployment capability**, not client claim.
  If false, return `503 VOICE_UNAVAILABLE` (content-free, redacted).

**Validation:**

- At least one non-empty span required in `committedSpans` for non-dormant behavior; empty array is a
  no-op (AC1).
- Body size capped at 16 KB; return 413 Payload Too Large if exceeded.
- Invalid JSON returns 400 bad request.

**Handler logic:**

1. For each committed span, call `extractCandidatesFromUserText(span, buildCaptureContext(...), policy)`.
2. Union all resulting `CaptureOutcome[]`.
3. For each outcome of kind `"candidate"` that passes `isPersistableMemoryCandidate` (public, no required
   approval): insert into vault as `initialStatus: "proposed"`. Collect the inserted vault ids.
4. Count every other extracted outcome (sensitive, approval-gated, rejected, update/forget/supersession) as
   `candidatesRejected`.
5. Recompute `committedChars` server-side from the submitted spans; build and store `VoiceSessionRecapAuditRecord`
   via the evidence store with the server-authoritative character count.
6. Return `{ candidatesProposed: number; candidatesRejected: number; proposalIds: string[] }`.

**Response:**

```json
{
  "candidatesProposed": "number",
  "candidatesRejected": "number",
  "proposalIds": ["string (vault ids)"]
}
```

No transcript text in request or response. Counts only.

## 13. Current integration status

The contract and `POST /api/voice/recap/build` handler remain registered and tested as a bounded,
capability-gated server surface. There is no current `useVoiceSessionRecap` hook, `VoiceRecap` component,
or product caller in `keiko-ui`, and the standalone transcript-segment store is not wired into Twin chat.
Operators must not treat the route as the product's normal memory path or infer that a recap button exists.
Canonical per-turn MemoriaViva capture is instead owned by the ordinary chat pipeline after the final Voice
transcript handoff (ADR-0154 D1/D5).

## 14. Historical #504 acceptance criteria and current route evidence

| AC  | Acceptance Criterion                                    | Satisfied by                                                                                                                     | Evidence                                                                    |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| AC1 | Recap is dormant when voice is unavailable              | `voiceRecapAllowed(profile)` false for `none`/`speech-output`; empty spans → no-op                                               | Contract predicate and server-handler tests; there is no current UI caller  |
| AC2 | Route input is bounded committed spans                  | Server parser accepts only the closed, bounded recap request shape; callers remain responsible for the committed-only projection | Contract, parser, and handler tests                                         |
| AC3 | Candidates enter existing review queue as proposed      | `extractCandidatesFromUserText` → `vault.insertMemory(initialStatus:"proposed")`                                                 | Review queue integration; existing memory endpoints unchanged               |
| AC4 | No raw audio / transcript text stored beyond extraction | Transient committedSpans; server never persists them; audit record is content-free                                               | Module forbidden-substring scan; server handler tests                       |
| AC5 | Canonical text-chat authority remains unchanged         | Recap remains an additive review route and does not create an assistant-answer or message-persistence path                       | Canonical chat and route-boundary tests; exact PR-head run is authoritative |
| AC6 | Secrets rejected before vault insert                    | `extractCandidatesFromUserText` runs `scanForSecrets` internally                                                                 | Eval fixture with credential string; rejected candidates not proposed       |

## Related

- [ADR-0109](../adr/ADR-0109-voice-session-recap.md) — the authoritative decision record; threat
  model; integration with existing memory governance.
- [ADR-0105](../adr/ADR-0105-voice-transcript-segment-semantics.md) — committed-only transcript
  boundary; `selectCommittedVoiceTranscript()`; `summarizeVoiceTranscript()`.
- [ADR-0108](../adr/ADR-0108-voice-spoken-action-governance.md) — voice is untrusted; governance
  layers; proposal vs. authorization distinction.
- [ADR-0107](../adr/ADR-0107-discussion-intelligence.md) — assistant claims are informational only;
  no extraction from assistant text; same invariant preserved in recap.
- [ADR-0100](../adr/ADR-0100-voice-digital-twin-capability-architecture.md) — privacy contract;
  no external destinations; capability-gating principle.
- [ADR-0019](../adr/ADR-0019-modular-package-architecture.md) — leaf-package rule.
- [transcript-semantics.md](transcript-semantics.md) — committed segment definition and projection.
- [privacy-contract.md](privacy-contract.md) — local-first data boundary; external-call rule;
  redaction seam.
- [`docs/voice/README.md`](README.md) — index of all voice feature documentation.
- [`packages/keiko-contracts/src/voice-session-recap.ts`](../../packages/keiko-contracts/src/voice-session-recap.ts) —
  contract types and capability predicates.
- [`packages/keiko-server/src/voice-recap.ts`](../../packages/keiko-server/src/voice-recap.ts) —
  server handler implementation.
- The original #504 UI hook and component are not present in the current tree; the server route has no
  product UI caller.
- [`packages/keiko-memory-capture/src/index.ts`](../../packages/keiko-memory-capture/src/index.ts) —
  `extractCandidatesFromUserText`; the governed capture entry point.
- [`packages/keiko-server/src/memory-handlers.ts`](../../packages/keiko-server/src/memory-handlers.ts) —
  existing review queue and mutation endpoints.
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491), Issue
  [#504](https://github.com/oscharko-dev/Keiko/issues/504).
