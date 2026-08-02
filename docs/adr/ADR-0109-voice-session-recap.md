# ADR-0109: Voice session recap — committed-transcript-derived memory candidates, reused governance, and content-free audit

> Renumbered from ADR-0067 on 2026-07-04 to resolve the 0058-0069 editor/voice numbering collision (Epic #491 voice series moved to 0100-0111).

## Status

Accepted (Issue #504, Epic #491, 2026-06-25); amended 2026-07-21 and by
[ADR-0154](ADR-0154-canonical-twin-voice-pipeline.md) on 2026-07-22. Canonical per-turn capture is
normative. The recap contract and server route remain, but the current UI contains no recap caller;
the route is not the productive Twin memory path.

## Version

0.3.2

## 2026-08-02 amendment — persisted status is authoritative

The product-wide memory autonomy posture also governs explicit recap capture. A public,
non-approval-gated candidate may therefore be persisted directly as `accepted` in supervised or
autonomous mode through the same canonical promotion predicate used by every other capture surface.
The recap response and content-free audit record report `candidatesAccepted` separately from
`candidatesProposed`; accepted record ids are returned as `acceptedIds`, while `proposalIds` contains
only records that actually entered the review queue. The per-record audit kind likewise matches the
persisted status (`memory:accepted` or `memory:proposed`).

## 2026-07-21 amendment — per-turn capture is canonical; recap is aggregation only

The original decision assumed that a full-realtime user turn might never enter the normal chat request
because speech travelled on the WebRTC media plane. That assumption is superseded. In Digital Voice, the
Realtime provider now owns media transport, VAD, and transcription only. Every final transcript is submitted
as a normal user message through the same chat-session send path as typed input.

This amendment is authoritative wherever the historical text below conflicts with it:

1. The final spoken transcript appears immediately in the existing chat and runs the normal retrieval,
   grounding, context, approval, and `collectMemoryActions` pipeline. MemoriaViva capture therefore happens
   per committed user turn under the same memory settings and governance as typed chat.
2. The Realtime session has automatic response creation disabled and advertises no Keiko retrieval or memory
   tools. It cannot persist or speak a competing provider-native assistant answer.
3. The sole assistant answer is the canonical chat answer. Speech output synthesizes that exact visible text;
   source metadata, code, tables, and other rich rendering remain visual.
4. Interim transcription is ephemeral UI state. It is replaced by the final user chat message and is never
   persisted as a transcript or memory input. Raw audio remains transient.
5. Session recap remains useful as an explicit aggregation and review action across several committed turns.
   It is no longer the primary or only way for full-realtime speech to reach MemoriaViva.
6. Endpointing is deliberately patient. A capable provider uses semantic VAD with low eagerness, and the
   browser keeps a final transcript provisional for 1.6 seconds. New speech in that continuation window
   joins the same user turn; repeated boundary words are deduplicated. Only the settled turn enters chat.
7. Grounded asks carry and return the same governed memory request/result as ungrounded chat. Repository or
   Knowledge Pod retrieval therefore cannot bypass MemoriaViva merely because it owns answer generation.
8. The recap contract and server route remain in the tree, but there is no current UI hook, component,
   or caller. References below to `useVoiceSessionRecap`, `VoiceRecap.tsx`, an inert recap button, or
   future wiring are retained historical design text, not a description of current UI availability.

The recap contracts, content-free audit, review queue, and explicit user-trigger semantics remain accepted.
The old statements that full-realtime `request.content` is absent, that recap fills the only per-turn memory
gap, or that live voice-to-chat wiring is deferred are retained below as historical rationale and are
superseded by this amendment.

## Context

[ADR-0105](ADR-0105-voice-transcript-segment-semantics.md) establishes the committed-only
integration boundary: `selectCommittedVoiceTranscript(segments)` returns only `committed` and
`corrected` segments, excluding partial, stable, discarded, redacted, and provider-error segments by
construction. This is the integration boundary that recap (#504) must consume.

[ADR-0108](ADR-0108-voice-spoken-action-governance.md) confirms that voice is an untrusted input
source and that any mechanism using committed transcript content must preserve existing governance —
adding gates, removing none.

The existing per-turn memory capture path (`collectMemoryActions` in `keiko-server/src/chat-handlers.ts`)
runs `extractCandidatesFromUserText` on `request.content` (the user's typed or dictation-derived text
message) per turn, gated by `memory.enabled`. This works well for STT dictation where the transcript IS
`request.content`. Historically, full-realtime voice sessions did not submit their committed transcript as
`request.content`, so they produced no per-turn memory candidates. The 2026-07-21 amendment closes that gap
at the owning layer: the final transcript is now normal chat request content. Recap remains an additional
aggregation surface.

Issue #504 delivers a voice session recap: a user-triggered summary of committed voice-session output
that derives memory candidates exclusively from the committed transcript projection. The recap must be:

1. Fully dormant when `voiceTranscriptCaptureAllowed(profile)` returns false.
2. Sourced exclusively from `selectCommittedVoiceTranscript(segments)` — the same committed-only
   integration boundary that #503 and the evaluation layer use.
3. Governed by the existing `extractCandidatesFromUserText` capture path — not a new extraction
   mechanism. The existing `scanForSecrets`, scope inference, sensitivity classification, and
   `buildProposal` logic applies unchanged.
4. Persisted through the existing governed capture policy: eligible records may be accepted in
   supervised or autonomous mode; proposals surface in the existing review queue. No new mutation
   surface or governance endpoint is introduced.
5. Content-free in every contract boundary: no raw audio, no transcript text, no provider URLs.
6. Additive at the route and request/response boundaries. Recap and per-turn chat capture share the
   same mode-aware persistence policy, including eligible promotion to `accepted`. Recap audit schema
   v2 adds the accepted count while its validator continues to read legacy v1 audit records as zero
   accepted.

The five-artifact plan follows the established pattern of ADR-0105 through ADR-0108:

- **Artifact A**: contract leaf `packages/keiko-contracts/src/voice-session-recap.ts`
- **Artifact B**: server `packages/keiko-server/src/voice-recap.ts`
- **Artifact C**: keiko-ui hook `hooks/voice-session-recap.ts` + visible component `VoiceRecap.tsx`
- **Artifact D**: eval `packages/keiko-evaluations/src/voice-recap/`
- **Artifact E**: docs `docs/voice/session-recap.md` + this ADR

## Decision

### D1 — Leaf contract in `keiko-contracts` with content-free types and capability predicate (AC1 / AC2)

The session-recap contract lives in a new leaf module at
[`packages/keiko-contracts/src/voice-session-recap.ts`](../../packages/keiko-contracts/src/voice-session-recap.ts).
It is a pure-data module: no IO, no clock reads, no randomness, no audio processing. It defines the
recap event model, the candidate lifecycle, the capability predicate, and the evidence audit record.

The module follows the ADR-0019 leaf-package rule: no `@oscharko-dev/keiko-*` imports appear; siblings
in `keiko-contracts` are reached by relative path (`./gateway.js`, `./voice-transcript.js`). It does
NOT import `./memory-records.js` or any memory-domain types — the leaf contract is upstream of the
memory domain. The server (Artifact B) is the site that imports both `keiko-contracts/voice-session-recap`
and `@oscharko-dev/keiko-memory-capture` and wires them together.

`VOICE_SESSION_RECAP_SCHEMA_VERSION = "2" as const` follows the same evolution rule as prior contract
schema versions. Version 2 adds the required `candidatesAccepted` count. Validation explicitly
normalizes a persisted version-1 audit record that lacks that field to zero accepted, while newly
emitted descriptors, summaries, and audit records use version 2. The version remains independent of
`VOICE_TRANSCRIPT_SCHEMA_VERSION`, `VOICE_ACTION_INTENT_SCHEMA_VERSION`, and
`CONVERSATION_CAPABILITY_CONTRACT_VERSION`.

The capability predicate `voiceRecapAllowed(profile: VoiceProfile): boolean` is derived from
`voiceTranscriptCaptureAllowed(profile)` imported via relative path from `./voice-transcript.js`.
It returns `true` for `speech-to-text` and `full-realtime`; `false` for `none` and `speech-output`.
This makes AC1 dormancy a one-line derivation — the same pattern `voiceCanProposeAction` uses in
`voice-action-intent.ts`.

**Pinned public API surface for `voice-session-recap.ts`:**

```typescript
// Schema version
export const VOICE_SESSION_RECAP_SCHEMA_VERSION = "2" as const;
export type VoiceSessionRecapSchemaVersion = "1" | "2";
export function isVoiceSessionRecapSchemaVersionSupported(version: unknown): boolean;

// Capability gating (AC1) — derived from voiceTranscriptCaptureAllowed
export function voiceRecapAllowed(profile: VoiceProfile): boolean;

// Recap candidate lifecycle — maps onto existing memory status lifecycle
// proposed → accepted | rejected | forgotten; eligible captures may initially persist as accepted
export type VoiceRecapCandidateStatus = "proposed" | "accepted" | "rejected" | "forgotten";
export const VOICE_RECAP_CANDIDATE_STATUSES: readonly VoiceRecapCandidateStatus[];
export function isVoiceRecapCandidateStatus(value: unknown): value is VoiceRecapCandidateStatus;

// Content-free committed-span descriptor.
// The leaf contract does NOT carry transcript text — text lives in the server at extraction time
// and in the UI hook's local state. This shape is the content-free bridge the server uses to
// record WHAT was submitted for extraction without retaining the text itself.
export interface VoiceRecapCommittedSpanDescriptor {
  readonly schemaVersion: VoiceSessionRecapSchemaVersion;
  readonly spanIndex: number;                     // ordinal position in the committed projection
  readonly source: VoiceTranscriptSource;         // "dictation" | "realtime"
  readonly charCount: number;                     // character count of this span; never the text
  readonly segmentCount: number;                  // number of committed segments in this span
  readonly highestSeq: number;                    // highest seq number contributing to this span
}

// Content-free assistant-turn descriptor.
// Records that an assistant response occurred at a given turn without retaining any text.
export interface VoiceRecapAssistantTurnDescriptor {
  readonly schemaVersion: VoiceSessionRecapSchemaVersion;
  readonly turnIndex: number;
  readonly source: "text-response";               // "text-response" only; no audio/TTS payloads
}

// Evidence summary for the recap as a whole — reuses VoiceTranscriptEvidenceSummary
// from voice-transcript.ts for the committed transcript roll-up; adds recap-specific counts.
export interface VoiceSessionRecapEvidenceSummary {
  readonly schemaVersion: VoiceSessionRecapSchemaVersion;
  readonly transcript: VoiceTranscriptEvidenceSummary;  // from ./voice-transcript.js
  readonly candidatesExtracted: number;   // CaptureOutcome[] length from extraction
  readonly candidatesRejected: number;    // how many were rejected by scanForSecrets / policy
  readonly candidatesProposed: number;    // how many reached status "proposed" in the vault
  readonly candidatesAccepted: number;    // how many governance accepted at capture time
  readonly triggeredByUser: boolean;      // always true (recap is user-triggered, never automatic)
}

// Content-free audit record for the recap trigger event.
// Mirrors SpokenActionAuditRecord posture: no text, no audio, only enums/ints/bools.
export interface VoiceSessionRecapAuditRecord {
  readonly schemaVersion: VoiceSessionRecapSchemaVersion;
  readonly profile: VoiceProfile;          // voice profile at recap time
  readonly committedSegmentCount: number;  // from selectCommittedVoiceTranscript projection
  readonly committedChars: number;         // character count; never transcript text
  readonly candidatesExtracted: number;
  readonly candidatesRejected: number;
  readonly candidatesProposed: number;
  readonly candidatesAccepted: number;
  readonly triggeredByUser: boolean;
  readonly durationMs: number;             // extraction + vault write duration
}

// Validation
export function validateVoiceSessionRecapAuditRecord(
  value: unknown,
): { ok: true } | { ok: false; reason: string };
```

The contract barrel (`keiko-contracts/src/index.ts`) is extended with explicit named exports for all
public types and functions above, following the pattern of the existing voice leaf additions. The root
`@oscharko-dev/keiko` package surface (`scripts/root-package-surface.contract.json`) is unaffected:
the root surface is the `keiko-model-gateway` barrel, not `keiko-contracts` (confirmed by prior issues
#500–#503 in this epic; contracts-barrel additions are surface-neutral at root).

### D2 — Recap is user-triggered, not automatic on session close (AC1 / AC5)

The recap does **not** trigger automatically when a voice session ends. It is triggered explicitly by a
user action (a button in the `VoiceRecap.tsx` surface, see D5). This decision is load-bearing:

1. Keiko has no single "voice session close" event. STT dictation is per-message; full-realtime
   WebSocket disconnects on idle or on page navigation. An automatic trigger tied to disconnection
   would fire on transient reconnects and browser tab-switches, producing unwanted candidate proposals.
2. User agency over what is retained is a core privacy principle (ADR-0100 privacy contract). The user
   must actively request the recap; passive accumulation violates the "no raw audio or unreviewed
   transcript stored as durable truth" guarantee.
3. A user-triggered action is synchronous with the user's intent: the committed transcript state at the
   moment of button press is the authoritative input. An automatic trigger on disconnect would be
   asynchronous and could race against corrections still in flight.

The UI hook (Artifact C) holds the committed transcript locally (via `selectCommittedVoiceTranscript`)
and presents a "Review session" button when `voiceRecapAllowed(profile) === true` and
`projection.segmentCount > 0`. Pressing the button sends the projection to the server endpoint
(Artifact B). The text of the projection is transmitted to the server once, for extraction, and is
never persisted by the server as a raw transcript.

### D3 — Candidate derivation reuses `extractCandidatesFromUserText`; no new extraction mechanism (AC3 / AC6)

Memory candidates are derived by calling
`extractCandidatesFromUserText(committedText, captureContext, policy)` from
`@oscharko-dev/keiko-memory-capture` (`packages/keiko-memory-capture/src/capture.js`). This is
THE existing governed entry point for user-text-derived candidates. It automatically applies:

- `scanForSecrets`: credential / provider-URL rejection. Candidate text containing secrets is rejected
  before it reaches the vault (AC6).
- Scope inference: fail-closed scope assignment (unknown scope → rejected).
- Sensitivity classification: classifies the candidate text.
- `buildProposal`: produces a `MemoryProposal` with `initialStatus: "proposed"`.

That extractor status is the governance input, not necessarily the persisted result: the shared
mode-aware promotion predicate may change an eligible record to `accepted` before insertion.

The recap server function does not implement a new extractor, a new policy interpreter, or a new
secret-scanner. It calls the existing API **once per committed span** and collects the union of the
resulting `CaptureOutcome[]`. This per-span call mirrors the per-turn chat path (one
`extractCandidatesFromUserText` call per user utterance) so a session can yield several candidates and
the governance behaviour is identical to typed chat. Only outcomes of kind `"candidate"` that pass the
existing `isPersistableMemoryCandidate` filter are written to the vault. The same product-wide mode
and canonical promotion predicate as chat capture determines whether each inserted record is
`"accepted"` or `"proposed"`. Every other outcome (`"rejected"`, non-persistable candidates, and the
governance-action kinds `"update"`, `"forget"`, `"supersession"`) is counted but never written; these
are surfaced as `candidatesRejected` in the content-free audit.

**Boundary distinction from per-turn capture:** `collectMemoryActions` (chat-handlers.ts) runs
`extractCandidatesFromUserText` on `request.content` — the user's typed message or the STT
dictation-derived text submitted with the chat request. The recap calls the same function on the
committed spans of the full voice session (`selectCommittedVoiceTranscript(segments).segments`) — a
different input derived from the transcript store, not from `request.content`. For STT dictation, both
inputs may overlap (the dictated text becomes `request.content`). See D6 for the deduplication resolution.

The `captureContext` passed to `extractCandidatesFromUserText` at recap time uses the same
project/workspace/user scope resolution the chat handler uses (`buildCaptureContext`) and the unchanged
policy (`memoryCapturePolicyForDeps(deps)`). It does **not** introduce a new provenance surface
identifier: `CaptureContext` has no `initiatorSurface` field and `MemoryAuditInitiatorSurface` is a
closed union that does not include `"voice-recap"`. Recap candidates are therefore governed and
provenance-classified identically to per-turn candidates; differentiation relies on the existing vault
dedup and review-queue visibility (D6), not on a new provenance tag.

### D4 — Proposed candidates use the existing review queue; no new mutation surface (AC3)

Recap candidates are inserted through the existing `vault.insertMemory` path. A record that remains
`proposed` appears in `GET /api/memory/review-queue` automatically because that endpoint queries
`status: ["proposed", "conflicted", "expired"]`. A mode-eligible record persisted as `accepted` is
immediately retrievable and does not masquerade as a review-queue proposal.

The user reviews, approves, edits, or rejects candidates using existing review UI:
- Accept: `POST /api/memory/proposals/:id/accept` (`handleAcceptMemoryProposal`)
- Reject: `POST /api/memory/proposals/:id/reject` (`handleRejectMemoryProposal`)
- Edit body: `PATCH /api/memory/:id` (`handleEditMemory`)
- Forget: `POST /api/memory/:id/forget` (`handleForgetMemory`)

**No new governance endpoints, no new mutation surface.** The `VoiceRecap.tsx` component's review
actions call these existing `memory-api.ts` functions: `acceptMemoryProposal`, `rejectMemoryProposal`,
`editMemory`, `forgetMemory`. The UI client has no direct vault access.

The recap endpoint is an additive route (see D5) that produces governed capture outcomes. It does
not accept, reject, or modify existing memories — its only memory write is `vault.insertMemory` for
new candidates, with status selected by the shared capture policy.

### D5 — Additive server route; shared capture policy governs every capture surface (AC5)

The server ships one new capability-gated route: `POST /api/voice/recap/build`. All existing routes
retain their request and response contracts. The recap route and per-turn chat capture intentionally
reuse the same mode-aware persistence policy; a policy correction therefore applies consistently to
both surfaces rather than preserving divergent behavior for the sake of textual identity.

**Handler logic (authoritative spec for implementers):**

1. Capability check **against the deployment profile** via `serverTrustedVoiceProfile(deps)`
   (`isVoiceRealtimeCapable` / `isVoiceDictationCapable`), not the client-claimed profile (the #503
   lesson). If `voiceRecapAllowed(profile)` is false: return `503 VOICE_UNAVAILABLE` (content-free,
   redacted), matching the dictation route posture. The route never reads a `profile` field from the body.
2. Body: the client sends `{ committedSpans: string[], transcript: VoiceTranscriptEvidenceSummary }`.
   `committedSpans` is the per-utterance committed text (each committed, non-superseded segment's text);
   `transcript` is the content-free `summarizeVoiceTranscript(segments)` roll-up (counts only). The raw
   byte size is capped (16 KB) with `413` before parsing; invalid JSON returns `400`. An empty
   `committedSpans` makes the route dormant (no extraction, no side effect — AC1).
3. For each span, call `extractCandidatesFromUserText(span, captureContext, policy)` and union the
   `CaptureOutcome[]`.
4. Persist only `"candidate"` outcomes that pass `isPersistableMemoryCandidate` (the existing
   chat-path filter). Resolve the same memory autonomy mode as the other capture surfaces and pass
   eligible records through `promoteEligibleMemoryRecord`. Count the final stored states separately
   as `candidatesProposed` and `candidatesAccepted`; count every non-persisted extraction outcome as
   `candidatesRejected` (see D3).
5. Build and persist the content-free `VoiceSessionRecapAuditRecord` via the evidence store. The
   transcript roll-up's segment-state counts (corrected/discarded/highest-seq) come from the client's
   content-free `transcript` summary; `segmentCount` and `committedChars` are recomputed server-side
   from `committedSpans` so the audit's character count matches exactly what was extracted.
6. Emit `memory:proposed` or `memory:accepted` per inserted record according to its stored status.
   Return `{ candidatesProposed, candidatesAccepted, candidatesRejected, proposalIds, acceptedIds }`
   — counts and vault ids only; no transcript text in the response. `proposalIds` contains only
   review-queue records and `acceptedIds` contains only accepted records.

**The text-chat request/response path remains independent.** The recap route is invoked only by
explicit user action. It does not intercept `collectMemoryActions` or change
`CONVERSATION_SYSTEM_PROMPT`; both capture surfaces converge only at the shared governed persistence
policy, including mode-aware promotion and suppression.

The assistant's response text (`assistantText` in `collectMemoryActions`) is used as context-only in
per-turn salience capture (`captureSalientFromTurn`); it is never stored as a user fact. The recap
must preserve this invariant: `extractCandidatesFromUserText` is called only on the user's committed
spoken text, never on the assistant's response text. The `VoiceRecapAssistantTurnDescriptor` (D1) is
a content-free descriptor that records assistant turns for auditing purposes only; it carries no
assistant response text.

### D6 — Double-candidate deduplication boundary (AC3)

For STT dictation, a voice session produces turns where the dictated text becomes `request.content`,
which `captureMemoryActions` processes per-turn. If the user then triggers a recap, the same committed
text would be submitted again to `extractCandidatesFromUserText`, potentially proposing the same
candidate a second time.

The deduplication mechanism relies on two existing layers (the recap adds no new dedup code and no new
provenance tag — see D3):

1. **Scope-and-body dedup in the vault**: the existing memory vault detects proposals with
   identical `scope + body` and produces `CaptureOutcome` of kind `"supersession"` or raises a
   conflict, rather than creating exact duplicates. This is the existing dedup boundary; the recap
   relies on it without new code.
2. **Review queue visibility and user judgment**: even if a near-duplicate candidate reaches the vault
   (slightly different normalization), it surfaces in the review queue for explicit user action. A
   user who already accepted a per-turn proposal for the same content will see the recap proposal and
   can reject it.

**Architecture note for implementers**: the recap is architecturally targeted at full-realtime
sessions where `request.content` is absent (audio over WebRTC, not in the HTTP body), so
double-proposal risk is low in the primary use case. For STT dictation sessions, the near-duplicate
path is covered by vault dedup and review-queue visibility.

### D7 — keiko-ui hook and visible component (AC1 / AC2)

The hook at
`packages/keiko-ui/src/app/components/desktop/hooks/voice-session-recap.ts` follows the pattern of
`discussion-voice.ts` and `voice-action-intent.ts`:

- Pure deterministic factory closure: `createVoiceSessionRecapBinding(options)`.
- Reads committed transcript from `selectCommittedVoiceTranscript(segments)` — the AC2 committed-only
  boundary. The hook holds the committed text in its closure; no text leaves via the observer.
- Dormant when `voiceRecapAllowed(profile) === false`: no observer fires, no network call is made,
  no state is mutated (AC1).
- `trigger()` method: sends the committed text to `POST /api/voice/recap/build` and returns the
  content-free proposed, accepted, and rejected counts plus their corresponding ids. Text is
  transmitted once for extraction and never cached in the hook after the response.
- Content-free observers carry counts and ids only, never transcript or memory bodies.

`VoiceRecap.tsx` is the visible component wired into `ChatWindow` behind a `voiceRecapVisible`
boolean (same pattern as `voiceDictationVisible`, `voiceRealtimeVisible`). `voiceRecapVisible` is
true when `voiceRecapAllowed(voiceCapability.profile) && voiceTranscriptSegmentCount > 0`. The
component renders:

- A "Review session" button (visible, capability-gated, inert until there is committed content).
- On trigger: a loading state, then a panel listing the proposed candidates fetched from the existing
  `GET /api/memory/review-queue`, where the user invokes the existing accept/reject/edit/forget actions.
- No new modal, no new confirmation flow, no new governance surface.

`design-system/globals.css` is untouched. The component reuses existing token classes.

### D8 — Content-free invariant everywhere (AC4)

No raw transcript text, raw audio buffer, session token, credential, provider URL, model ID, or
assistant response text is a field of any type defined in `voice-session-recap.ts`. Every boundary
value is a closed enum, a boolean, an integer count, a character count, a duration integer, or a
fixed schema version string.

- `VoiceSessionRecapAuditRecord`: counts, booleans, duration, profile enum — no text.
- `VoiceRecapCommittedSpanDescriptor`: `charCount`, `segmentCount` — no text.
- `VoiceRecapAssistantTurnDescriptor`: `turnIndex`, `"text-response"` enum — no text.
- Server response to `POST /api/voice/recap/build`: proposed, accepted, and rejected counts plus
  proposal/accepted ids — no text.

The contract module is scanned for forbidden substrings as a test invariant (same as
`voice-action-intent.ts`): apikey, secret, password, credential, bearer, baseurl, endpoint,
authorization, privatekey, accesskey, token, systemprompt, toolauthority, grantedtools, allowedtools,
canexecute. Any match in the module source fails the test.

### D9 — Deterministic evaluation suite (Artifact D)

Session-recap behavior is evaluated in a purpose-built
`packages/keiko-evaluations/src/voice-recap/` subpackage that mirrors the existing `voice-action/`
and `discussion/` structure. It is fully deterministic: no model, no clock, no randomness.

The scorer covers seven dimensions:

| Dimension                        | What it measures                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `dormant-no-voice`               | No side effects when profile is `none` or `speech-output` (AC1).                         |
| `corrections-excluded`           | Corrected/superseded segments excluded from recap input by construction (AC2).            |
| `raw-audio-never-stored`         | No audio, no text persisted beyond the extraction call (AC4).                             |
| `secrets-redacted`               | Candidates containing secrets rejected by `scanForSecrets` before vault insert (AC6).    |
| `candidate-governed`             | Candidate status matches shared mode-aware governance; proposals use the review queue (AC3). |
| `assistant-claims-not-user-fact` | Assistant response text never submitted to `extractCandidatesFromUserText` (AC5).        |
| `content-free-audit`             | Audit record carries only counts/enums/bools; no transcript text (AC4).                  |

Fixtures:

| Fixture                    | Profile              | Scenario                                                           |
| -------------------------- | -------------------- | ------------------------------------------------------------------ |
| `no-voice-capable`         | `none`               | Recap hook is dormant; no trigger, no network call.                |
| `stt-dictation-recap`      | `speech-to-text`     | Committed projection from dictation session → candidates proposed. |
| `realtime-full-recap`      | `full-realtime`      | Committed projection from full-realtime session → candidates proposed. |
| `secret-in-transcript`     | `speech-to-text`     | Committed text contains a credential string → candidate rejected.  |
| `corrections-excluded`     | `full-realtime`      | Superseded segments absent from projection; recap uses clean text. |
| `assistant-text-excluded`  | `speech-to-text`     | Only user committed text submitted; assistant text absent.         |
| `content-free-audit`       | `speech-to-text`     | Audit record carries no transcript text.                           |

The suite produces a GO/NO-GO scorecard.

### D10 — Deferred: visible session transcript display

The render path that would display the raw committed transcript text to the user before they decide
to trigger recap is **deferred**. This mirrors the deferral posture of ADR-0103 D10, ADR-0104 D10,
ADR-0107 D10, and ADR-0108 D9.

The `VoiceRecap.tsx` panel lists the proposed candidate bodies (the same reviewable memory text the
existing MemoriaViva review queue already shows) with the accept/edit/reject/forget actions. What it
does **not** show is the raw committed transcript preview — the verbatim record of everything said
during the session before the user triggers recap. A future issue may add that preview; the hook seam
is `binding.committedSegmentCount` (a count, not text), sufficient to render "you have N committed
voice turns to review" without surfacing the raw transcript in the component.

## Consequences

### Positive

- Full-realtime voice sessions gain memory capture: spoken content that never entered `request.content`
  can now produce governed, reviewable memory candidates (AC3).
- Governance is reused, not reinvented: the existing `extractCandidatesFromUserText` secret scanner,
  scope inference, and sensitivity classification all apply (AC6).
- No new mutation surface: recap proposals enter the existing review queue; all user-facing accept,
  reject, edit, and forget actions use existing endpoints (AC3).
- AC1 dormancy is structural: the hook short-circuits at the predicate before reading the transcript
  store; no observer fires; no network call is made in `none` or `speech-output` profiles.
- The text-chat request/response path is unchanged, while shared capture persistence semantics stay
  consistent across chat and recap (AC5).
- Content-free invariant is verifiable by module scanning (AC4).
- The user retains control: recap never runs until explicitly triggered; any candidate not eligible
  for shared mode-aware acceptance remains in the existing review queue.

### Negative

- STT dictation sessions may produce near-duplicate proposals (recap + per-turn capture on the same
  text). The vault deduplication and review-queue visibility mitigate this, but do not eliminate UX
  friction of near-duplicate proposals in the queue.
- The committed text submitted to the recap endpoint may be large for long sessions. Implementers
  must enforce a body-size cap (recommended 16 KB) with 413 response.
- The visible session transcript summary (showing what was said before triggering recap) is deferred
  (D10), so the user triggers recap without a preview of what will be extracted.

### Neutral

- The recap is always user-triggered; there is no background extraction. This is a deliberate privacy
  choice (D2) but means sessions where the user forgets to trigger recap lose the ability to review
  committed voice content post-session.
- Recap candidates are governed and provenance-classified identically to per-turn proposals; there is
  no new `initiatorSurface` tag (see D3/D6). They are distinguishable only by the existing vault dedup
  and by user judgment in the review queue.

## Deferred / Out of Scope

- **Visible session transcript display**: the render path showing committed transcript text before
  recap trigger is deferred (D10).
- **Live committed-segment wiring into the composer**: `useVoiceSessionRecap` accepts the committed
  voice transcript segments via its `segments` prop, but the live realtime/dictation composer does not
  yet surface the `#500` `voice-transcript-segments` store to `ChatWindow`. Until that upstream store
  is consumed, the recap button renders (when capability allows) but stays inert
  (`committedSegmentCount === 0`); the `segments` prop is the documented seam for that future wiring.
  The recap mechanism (contract, server route, hook, review delegation) is complete and tested against
  injected segments. This mirrors the render-path deferral posture of ADR-0103/0104/0063.
- **Automatic recap on session close**: not triggered automatically; user-initiated only (D2).
- **Discussion mode integration with recap**: if a discussion turn produced a `decide`-mode
  recommendation, any spoken candidate extraction from that text is covered by the same
  `extractCandidatesFromUserText` call. The `DiscussionTurnSummary` is content-free and is not
  extracted as a memory candidate.
- **`design-system/globals.css` changes**: the recap button and candidate count reuse existing tokens;
  no CSS additions are permitted in this issue.
- **New runtime media packages**: none are introduced.
- **Per-assistant-turn extraction**: assistant response text is context-only and never submitted to
  `extractCandidatesFromUserText`, mirroring the `collectMemoryActions` invariant.

## Alternatives Considered

### Alternative 1: Automatic recap on voice session disconnect

Trigger `extractCandidatesFromUserText` automatically when the WebSocket or WebRTC session closes,
without requiring a user action.

- **Pros**: No user step required; full coverage even if the user forgets to trigger recap.
- **Cons**: Voice session disconnect is ambiguous (transient reconnects, browser tab-switch, idle
  timeout). Automatic extraction of user speech content as memory candidates without explicit consent
  violates the privacy principle (ADR-0100 privacy contract §1). It also conflicts with AC1 dormancy
  semantics: the trigger window is undefined and races against corrections still in flight.
- **Why rejected**: User-triggered is the only design consistent with the privacy contract and the
  "no unreviewed transcript claims as durable truth" requirement. Automatic triggers introduce an
  uncontrolled persistence path.

### Alternative 2: Accumulate per-turn `CaptureOutcome` results and replay at recap time

Instead of re-calling `extractCandidatesFromUserText` on the committed projection, have the server
accumulate `CaptureOutcome[]` per voice turn in a session-level buffer and replay them on user request.

- **Pros**: No double-extraction for STT dictation; perfectly consistent with per-turn results; no
  committed-text resend from client to server.
- **Cons**: Requires server-side session state (a per-session `CaptureOutcome[]` buffer) that does
  not exist today. The buffer must survive for the session duration; its lifecycle, eviction, and
  privacy handling add surface area. Full-realtime sessions produce no per-turn chat requests, so they
  would still have no accumulated outcomes.
- **Why rejected**: Introduces server-side session state against the stateless-BFF principle, adds
  lifecycle complexity, and still does not solve the full-realtime gap. The simpler approach — re-call
  `extractCandidatesFromUserText` on the committed projection with vault dedup — achieves the same
  goal without new state.

### Alternative 3: New extraction mechanism tailored to voice content

Implement a voice-specific extractor (e.g. phrase-boundary NER, turn-level entity detection) instead
of reusing `extractCandidatesFromUserText`.

- **Pros**: Could be more accurate for spoken language (colloquial phrasing, incomplete sentences).
- **Cons**: A new extraction mechanism doubles the capture surface requiring security review and
  policy maintenance. The `scanForSecrets` and scope-inference logic would need to be duplicated or
  threaded through a new codepath. The existing extractor already handles natural-language user text;
  spoken text is not categorically different after NFKC normalization.
- **Why rejected**: No three usages exist to justify extracting a new pattern (ADR hard rule: three
  similar usages before extracting). The existing extractor is the governed entry point; bypassing it
  weakens the security boundary.

### Alternative 4: Store the committed transcript directly as a `"voice-session"` memory record

Instead of extracting candidates, store the raw committed transcript as a special memory record type
for the user to review and tag manually.

- **Pros**: Simpler pipeline; the user sees exactly what was said and decides manually what to keep.
- **Cons**: Stores transcript text as a memory record — precisely the "unreviewed transcript claims as
  durable truth" antipattern the issue prohibits. The memory vault types (`preference`, `fact`,
  `correction`, etc.) do not map to raw session transcripts. This would require a new memory type and
  new vault semantics without any net simplification.
- **Why rejected**: Storing transcript text as a memory record violates the requirement that the recap
  must not "store raw audio or unreviewed transcript claims as durable truth." The extraction path
  (D3) is correct: the transcript is the extraction input, not the stored artifact.

## Acceptance Criteria — Mechanism Table

> **Historical #504 closure table:** this records the evidence claim at the original implementation
> point. It is not current-head evidence. In particular, ADR-0154 intentionally changed the canonical
> chat and per-turn memory path, and the historical UI hook no longer exists; current exact-head tests
> and gates are authoritative.

| AC   | Acceptance Criterion                                           | Concrete Mechanism                                                                                                           | Evidence                                                                      |
| ---- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| AC1  | Voice recap is fully dormant when voice is unavailable         | `voiceRecapAllowed(profile)` returns `false` for `none`/`speech-output`; hook short-circuits before any state read or call  | Contract test + eval `dormant-no-voice` fixture; no observer fires            |
| AC2  | Recap input is committed transcript only                       | `selectCommittedVoiceTranscript(segments)` is the sole input; partial/stable/discarded/redacted excluded by construction    | By construction in `voice-transcript.ts`; eval `corrections-excluded` fixture |
| AC3  | Candidates follow shared capture governance                    | Extraction builds proposals; the shared mode-aware promotion predicate selects accepted vs review-queue status             | Server tests on accepted and proposed recap outcomes                          |
| AC4  | No raw audio, no transcript text stored beyond extraction call | Contract types carry only counts/enums; server never persists `committedText`; audit record is content-free                 | Module forbidden-substring scan; eval `raw-audio-never-stored` fixture        |
| AC5  | Text-chat path and per-turn capture untouched at the #504 head | Historical new-route-only mechanism; ADR-0154 later changed canonical chat and per-turn capture intentionally               | Archived #504 evidence only; current exact-head canonical chat tests are authoritative |
| AC6  | Secrets in transcript are rejected before vault insert         | `extractCandidatesFromUserText` runs `scanForSecrets` internally; `"rejected"` outcomes counted but never stored as records | eval `secret-in-transcript` fixture; server test with credential string input |

## Related

- [ADR-0105](ADR-0105-voice-transcript-segment-semantics.md) — committed-only transcript boundary;
  `selectCommittedVoiceTranscript`; `summarizeVoiceTranscript`; `voiceTranscriptCaptureAllowed`.
  `VoiceTranscriptEvidenceSummary` is reused as the transcript roll-up in
  `VoiceSessionRecapEvidenceSummary`.
- [ADR-0108](ADR-0108-voice-spoken-action-governance.md) — voice is untrusted; proposal never
  authorization; `voiceCanProposeAction` pattern that `voiceRecapAllowed` mirrors.
- [ADR-0107](ADR-0107-discussion-intelligence.md) — assistant claims are informational only; no
  write path from discussion output; same invariant preserved in recap.
- [ADR-0104](ADR-0104-voice-turn-manager.md) — turn manager; `VoiceTurnSnapshot`; no-authority posture.
- [ADR-0100](ADR-0100-voice-digital-twin-capability-architecture.md) — voice architecture baseline;
  privacy contract; capability-gating principle.
- [ADR-0019](ADR-0019-modular-package-architecture.md) — leaf-package rule; dependency direction.
- [`docs/voice/session-recap.md`](../voice/session-recap.md) — the specification companion to this ADR.
- [`packages/keiko-contracts/src/voice-session-recap.ts`](../../packages/keiko-contracts/src/voice-session-recap.ts) —
  the contract types and functions (Artifact A).
- [`packages/keiko-server/src/voice-recap.ts`](../../packages/keiko-server/src/voice-recap.ts) —
  the server handler (Artifact B).
- The historical Artifact C UI hook and `VoiceRecap.tsx` component are not present in the current tree.
- [`packages/keiko-memory-capture/src/index.ts`](../../packages/keiko-memory-capture/src/index.ts) —
  `extractCandidatesFromUserText`; the governed capture entry point this feature reuses.
- [`packages/keiko-server/src/memory-handlers.ts`](../../packages/keiko-server/src/memory-handlers.ts) —
  existing review-queue and mutation endpoints recap review actions delegate to.
- [`packages/keiko-ui/src/lib/memory-api.ts`](../../packages/keiko-ui/src/lib/memory-api.ts) —
  existing UI client for memory review actions; it is not currently wired to the recap route.
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491), Issue
  [#504](https://github.com/oscharko-dev/Keiko/issues/504).

## Date

2026-06-25
