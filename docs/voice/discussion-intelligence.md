# Discussion Intelligence — text-first colleague-like discussion behavior

Specification for Epic #491, the deliverable of Issue
[#502](https://github.com/oscharko-dev/Keiko/issues/502) and the authoritative companion to
[ADR-0065](../adr/ADR-0065-discussion-intelligence.md). It **defines** the five discussion modes, the
disagreement structure, the interruption-recovery model, the no-authority and committed-only guarantees,
and the deferred visible-selector seam. The contract lives in
[`packages/keiko-contracts/src/discussion-intelligence.ts`](../../packages/keiko-contracts/src/discussion-intelligence.ts);
the voice binding lives in
[`packages/keiko-ui/src/app/components/desktop/hooks/discussion-voice.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/discussion-voice.ts);
server orchestration lives in
[`packages/keiko-server/src/discussion-prompt.ts`](../../packages/keiko-server/src/discussion-prompt.ts).

## 0. Discussion intelligence is TEXT-FIRST

> **Text is the primary input path.** Discussion intelligence is available in every deployment,
> including those with no voice model, because it operates on text. No voice capability is required to
> use any of the five discussion modes.
>
> Voice adds a spoken input path only when the active deployment advertises it. When voice is
> present, the same `DISCUSSION_MODE_PLANS` contract and the same directive templates govern the
> response — there is no parallel voice-only behavior stack. Discussion intelligence is not gated on
> voice; voice is an optional additive path to discussion intelligence.

## 1. Scope and versioning

- **In scope:** the five discussion modes and their per-mode behavioral plans; the ten discussion
  directives and their fixed content-free templates; the three disagreement facets; the confidence
  level bridge to the design-system `.ai-conf[data-level]` token; the capability gating predicate for
  voice; the interruption-recovery turn model; the content-free turn summary; the validators; server
  prompt orchestration (additive directive block, system-prompt immutability); the voice integration
  hook with committed-only transcript input; the no-authority guarantee.
- **Out of scope (deferred to later issues):** the visible composer mode selector (the render path that
  lets the user pick a mode in the UI — see §8); routing a `decide`-mode recommendation through the
  `WorkflowHandoffRequest` governed path (#503); persisting discussion turns to recap or memory (#504).
- **Versioning:** `DISCUSSION_INTELLIGENCE_SCHEMA_VERSION = "1"`. A breaking change introduces a new
  literal rather than mutating `"1"`. It is independent of `VOICE_PROTOCOL_VERSION`,
  `VOICE_TRANSCRIPT_SCHEMA_VERSION`, `VOICE_PLAYBACK_SCHEMA_VERSION`, and
  `CONVERSATION_CAPABILITY_CONTRACT_VERSION`.

## 2. The five discussion modes

Each mode is a named colleague-like behavior that shapes how Keiko frames its response. Mode selection
is turn-local: it is sent as an optional field on the chat request and has no effect on other turns or
on compacted history.

| Mode             | Core behavior                                                                                | `challengesAssumptions` | `producesDecisionRecommendation` | Citation discipline                      |
| ---------------- | -------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------- | ---------------------------------------- |
| `challenge`      | States a position with evidence; identifies assumptions the stated position rests on; surfaces counter-evidence. | yes | no | `require-citations-or-state-no-evidence` |
| `review`         | Verifies every claim against available evidence; lists explicit assumptions; identifies gaps. | yes                     | no                               | `require-citations-or-state-no-evidence` |
| `decide`         | Lists assumptions; offers a recommended next action with trade-offs; discloses confidence; defers to the user when a contradiction cannot be resolved. | yes | **yes** | `require-citations-or-state-no-evidence` |
| `brainstorm`     | Expands the range of options before converging; labels assumptions; uses best-effort citation. | no                     | no                               | `best-effort`                            |
| `evidence-check` | Strictly cites evidence for each claim or states that none is available; flags unsupported claims; does not fabricate sources. | yes | no | `require-citations`              |

### When each mode is appropriate

- **`challenge`** — when a stated position needs examination: the user or a prior model response has
  made a claim and Keiko should probe its assumptions and surface opposing evidence.
- **`review`** — when accuracy and evidentiary completeness matter more than assumption probing: the
  goal is to verify what is claimed, not to argue against it.
- **`decide`** — when the conversation has converged to a choice point: Keiko frames the decision
  explicitly, lists the options with trade-offs, and offers a recommendation while acknowledging what
  it does not know. The recommendation is always informational; it does not trigger any action.
- **`brainstorm`** — when the space of options is underspecified: Keiko broadens the set of
  possibilities before any convergence or evaluation. It labels its assumptions but does not mandate
  full uncertainty disclosure, because generating options is more useful than arguing about residual
  confidence at the expansion stage.
- **`evidence-check`** — when a claim must be validated against sources with no tolerance for
  unsupported inference: every claim is either cited or explicitly marked as having no available
  evidence. This is the strictest citation discipline in the set.

### What the text-first path looks like

When a chat request carries `discussionMode: "challenge"` (for example), the BFF composes a labeled
additive directive block from the mode's `DISCUSSION_MODE_PLANS` entry and inserts it before the
user-message block. The model receives the directives and responds accordingly.
`CONVERSATION_SYSTEM_PROMPT` is not modified. When no mode is specified, the prompt is byte-identical
to the current behavior.

## 3. The disagreement structure

The four disagreement-capable modes (`challenge`, `review`, `decide`, `evidence-check`) mandate that
every professional disagreement covers all three facets:

| Facet           | What it covers                                                                                |
| --------------- | --------------------------------------------------------------------------------------------- |
| `evidence`      | The observable facts, sources, or measurements that support or challenge the position.        |
| `assumptions`   | The premises the position rests on, stated explicitly so they can be evaluated independently. |
| `uncertainty`   | The residual confidence and the unresolved unknowns, disclosed openly.                        |

These three facets are encoded as `DISAGREEMENT_FACETS` — a closed constant array — and the
`DiscussionModePlan.mandatedFacets` field declares which facets the mode requires. The contract test
suite asserts that every disagreement-capable mode mandates all three; this assertion will fail if a
future plan revision removes a facet.

`brainstorm` mandates `evidence` and `assumptions` but not `uncertainty`, because expanding option
space before converging does not require full uncertainty disclosure on each option. This relaxation is
intentional and tested.

### Confidence level bridge

`ConfidenceLevel = "high" | "medium" | "low"` maps model-reported confidence scores to the
design-system `.ai-conf[data-level]` token (three segments: `high` fills all three, `medium` fills two,
`low` fills one). `confidenceLevelFromScore(score)` applies the following rules:

- A non-finite input or a value outside `[0, 1]` guards to `low` — confidence is never overstated on
  bad input.
- `score < 1/3` yields `low`; `score < 2/3` yields `medium`; `score >= 2/3` yields `high`.
- The boundaries `1/3` and `2/3` themselves are inclusive of the higher level (exactly `1/3` is
  `medium`; exactly `2/3` is `high`).

These cut points match the three-segment design-system widget and are documented and tested at
boundary values (including `NaN`, values below `0`, `0`, values just below and at `1/3`, values just
below and at `2/3`, `1`, and values above `1`).

## 4. Directives and content-free templates

The server renders the mode's directive set as a labeled block by looking up each directive in
`DISCUSSION_DIRECTIVE_TEMPLATES`, a frozen record keyed by `DiscussionDirective`. There are ten
directives in the closed vocabulary:

| Directive                                   | Purpose                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `state-position-then-evidence`              | State the position first, then the evidence that supports it.                                |
| `challenge-stated-assumptions`              | Identify and challenge the assumptions the stated position depends on.                       |
| `surface-counter-evidence`                  | Surface evidence that weighs against the position, not only evidence for it.                 |
| `list-explicit-assumptions`                 | List the explicit assumptions made before drawing a conclusion.                              |
| `disclose-uncertainty-and-confidence`       | Disclose remaining uncertainty and the confidence level for each claim.                      |
| `cite-evidence-or-state-none`               | Cite the evidence for each claim, or state plainly that none is available.                   |
| `offer-decision-with-tradeoffs`             | Offer a recommended next action and lay out the trade-offs of each option.                   |
| `expand-option-space-before-converging`     | Expand the range of options before converging on a single recommendation.                    |
| `verify-claims-against-evidence`            | Verify each claim against the available evidence before accepting it.                        |
| `defer-to-user-on-unresolved-contradiction` | When a contradiction cannot be resolved from evidence, defer the decision to the user.       |

Every template is a bounded, fixed string. No template echoes raw input, encodes a credential, names a
provider URL, or grants tool authority. The evaluation suite verifies this by scanning each template
for a set of forbidden substrings.

## 5. Interruption recovery

Discussion intelligence extends the voice turn manager's interruption model to the discussion context.
An interrupted spoken discussion turn must not lose the active question or decision context —
specifically: the `mode`, `topicId`, and `turnIndex` from before the interruption.

### Turn context

`DiscussionTurnContext` is the content-free turn identity:

| Field           | Type                          | Meaning                                                                            |
| --------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `schemaVersion` | `"1"`                         | Schema version for this context record.                                            |
| `mode`          | `DiscussionMode`              | The active discussion mode.                                                        |
| `topicId`       | `string` (opaque, <=256 chars) | Opaque identity of the open question or decision. Never raw text.                 |
| `turnIndex`     | `number` (non-negative int)   | Monotonic turn position; used for deduplication.                                   |
| `status`        | `DiscussionTurnStatus`        | Current lifecycle status of the turn.                                              |

`topicId` is validated as a non-empty, trimmed, NFKC-normalized, control-character-free, path-fragment-free
string of at most 256 characters. It is an opaque identifier — the discussion context knows that a
topic exists and can be matched, but never what the topic text says.

### Turn status lifecycle

Four statuses form the recovery lifecycle:

| Status        | Meaning                                                                                        | Legal transitions              |
| ------------- | ---------------------------------------------------------------------------------------------- | ------------------------------ |
| `active`      | The discussion turn is in progress.                                                            | `interrupted`, `resolved`      |
| `interrupted` | A barge-in or disconnect interrupted the spoken turn; context is preserved.                    | `recovered`, `resolved`        |
| `recovered`   | Recovery restored the same `mode`/`topicId`/`turnIndex` — the no-context-loss proof.          | `interrupted`, `resolved`      |
| `resolved`    | The turn reached its end. Terminal.                                                            | _(none)_                       |

`recovered` may transition back to `interrupted` to handle repeated barge-ins, which is the normal
pattern in full-duplex voice conversation. `resolved` is terminal.

### Pure recovery helpers

The pure transition helpers (`applyDiscussionInterruption`, `applyDiscussionRecovery`,
`resolveDiscussionTurn`) follow the ADR-0063 voice-transcript posture: illegal transitions return the
input context unchanged rather than throwing. A caller that calls `applyDiscussionRecovery` on a
`resolved` context receives the same context back.

**No-context-loss proof**: `applyDiscussionRecovery(ctx)` returns a new context object with
`status: "recovered"` and all other fields spread from the interrupted context unchanged. The `mode`,
`topicId`, and `turnIndex` fields are therefore identical to their pre-interruption values. A test
verifies this identity for the full `active -> interrupted -> recovered` path.

### How the voice binding drives recovery

The voice binding observes the `VoiceTurnSnapshot` from the ADR-0062 turn manager:

- When `snapshot.state === "interrupted"` **or** `snapshot.recovering === true`:
  call `applyDiscussionInterruption(currentCtx)` — the discussion context transitions to `interrupted`,
  preserving `mode`, `topicId`, and `turnIndex`.
- When the snapshot leaves the recovering state:
  call `applyDiscussionRecovery(currentCtx)` — the context returns to `recovered` with the identical
  `mode`, `topicId`, and `turnIndex`. The active question or decision is intact.
- The binding does not fabricate a new context, does not reset `turnIndex`, and does not change `mode`
  during a recovery cycle.

## 6. No-authority guarantee

Discussion intelligence has no write path and grants no action authority, regardless of whether the
input arrives by text or voice.

- **Text path**: The additive directive block shapes the model's response; it does not create a
  workflow event, modify memory, or call a tool.
- **Voice path**: The voice binding (`discussion-voice.ts`) is a synchronous, content-free observer. It
  reads committed voice transcript; it manages interruption-recovery context; it emits no side effects.
  It cannot produce a `WorkflowHandoffRequest` and cannot advance compacted history.
- **`decide` mode**: A `decide`-mode recommendation is informational text in the assistant's reply. The
  user reads it and decides whether to act. If the user wants Keiko to execute the recommendation, they
  trigger it through the standard send flow, which routes through the existing `WorkflowHandoffRequest`
  + `userApprovalToken` governed path (Issue #503). There is no voice shortcut past that gate.

This no-authority guarantee is identical to the one documented for ADR-0062 D7 (the turn manager's
media-floor-only effect vocabulary).

## 7. Committed-only voice input

When voice drives a discussion turn, the only admissible input is the committed voice transcript
projection from ADR-0063:

```typescript
selectCommittedVoiceTranscript(segments).text
```

This projection contains only `committed` and `corrected` segments — segments the user explicitly
confirmed or that the provider finalized and the turn manager accepted. The following segment states
are **structurally excluded** from this projection and can never become discussion input:

| Excluded state   | Reason                                                                |
| ---------------- | --------------------------------------------------------------------- |
| `partial`        | In-flight; provider is still refining; user has not confirmed.        |
| `stable`         | Provider marked final; user has not yet committed.                    |
| `discarded`      | User or turn manager explicitly discarded this text.                  |
| `redacted`       | Reviewable text was redacted for privacy reasons.                     |
| `provider-error` | Provider failed to transcribe; no reliable text is available.         |

This means:

- Uncommitted dictation preview text is never discussion input or durable memory.
- Text the user discarded or that failed transcription cannot reappear as a discussion basis.
- A partial transcript at the time of a barge-in is not used; only the text committed before the
  interruption is available for context.

The capability gate (`voiceCanDriveDiscussion(profile)`) is derived from `voiceTranscriptCaptureAllowed`,
which means voice-driven discussion is available precisely in the same profiles where committed
transcript capture is allowed: `speech-to-text` and `full-realtime`. It is unavailable in `none` and
`speech-output`. In unavailable profiles, the voice binding is dormant: no clock read, no mutation,
no observer call.

## 8. Deferred visible mode selector (integration seam)

The render path that surfaces a composer-level mode selector — a user-facing picker that lets the user
select `challenge`, `review`, `decide`, `brainstorm`, or `evidence-check` before sending a message —
is **deferred**. This is consistent with the runtime-mechanics deferral pattern established in:

- ADR-0061 D10: render-path wiring for the timing engine deferred.
- ADR-0062 D10: fixture-based posture for turn manager render integration, with seams documented.
- ADR-0063: committed-only selector shipped and tested; voice-driven commit wiring documented as a seam.

The `discussionMode` field on `SendDesktopChatRequest` is already wired through the BFF into
`composeConversationPrompt`. A future issue adds only the UI surface that populates it. The current
behavior, with no mode selected, is byte-identical to the pre-#502 behavior.

The seam requires no changes to `design-system/globals.css` when the selector is added, because mode
selection reuses existing interaction patterns and tokens. No new CSS class or SHA-pinned proof is
required by this issue.

## 9. Evaluation

Discussion behavior is evaluated in `packages/keiko-evaluations/src/discussion/`, a dedicated
deterministic subpackage mirroring `promptEnhancer/`. It is fully deterministic — no model, no clock,
no randomness.

The scorer covers seven dimensions:

| Dimension                      | What it measures                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `mode-appropriateness`         | The mode selected is appropriate for the declared scenario.                            |
| `disagreement-completeness`    | For disagreement-capable modes, all three facets are present in the mode's directives. |
| `uncertainty-discipline`       | Uncertainty is disclosed when the mode requires it.                                    |
| `evidence-citation-discipline` | Citations or explicit no-evidence statements match the mode's citation discipline.     |
| `correction-handling`          | Provider corrections do not introduce duplicate or stale text.                         |
| `interruption-recovery`        | A barge-in followed by recovery leaves `mode`/`topicId`/`turnIndex` unchanged.        |
| `capability-gating`            | Voice-driven discussion is dormant in `none`/`speech-output` profiles.                |

Fixtures cover both no-voice and voice-capable deployment profiles:

| Fixture                            | Profile              | Scenario                                                    |
| ---------------------------------- | -------------------- | ----------------------------------------------------------- |
| `no-voice-challenge`               | `none`               | Text-only challenge-mode turn.                              |
| `no-voice-decide`                  | `none`               | Text-only decide-mode turn producing a recommendation.      |
| `voice-stt-review`                 | `speech-to-text`     | STT-driven review-mode turn using committed transcript.     |
| `voice-realtime-barge-in-recovery` | `full-realtime`      | Barge-in mid-decide-mode; recovery restores context.        |
| `evidence-check-correction`        | `speech-to-text`     | Provider correction handled without duplication.            |

The suite produces a GO/NO-GO scorecard mirroring `PromptEnhancerScorecard`.

## 10. Related systems

### Integration with the turn manager (#499)

The turn manager ([ADR-0062](../adr/ADR-0062-voice-turn-manager.md)) owns floor control. When the turn
manager enters `interrupted` or `recovering` state, the discussion voice binding calls
`applyDiscussionInterruption`; when recovery clears, it calls `applyDiscussionRecovery`. The discussion
binding observes the turn manager snapshot; it does not modify turn manager state.

### Integration with the transcript segment store (#500)

The transcript store ([ADR-0063](../adr/ADR-0063-voice-transcript-segment-semantics.md)) enforces the
committed-only boundary. Discussion input from voice is read from `selectCommittedVoiceTranscript`,
never directly from the segment array.

### Integration with assistant speech output (#501)

The playback controller ([ADR-0064](../adr/ADR-0064-voice-assistant-speech-output-playback.md)) handles
the spoken assistant response. When the playback phase transitions to `interrupted`, the turn manager
records it. The discussion binding observes the turn manager, not the playback controller directly. The
content-free `DiscussionTurnSummary` is available to later consumers (#503, #504) from
`@oscharko-dev/keiko-contracts` without importing the UI.

### Governed spoken action handoff (#503)

When a `decide`-mode turn produces a recommendation that the user wishes to act on, that intent routes
through the existing `WorkflowHandoffRequest` + `userApprovalToken` governed path in Issue #503.
Discussion intelligence contributes a content-free `DiscussionTurnSummary` (mode, status, turn index,
mandated facet count, optional confidence) to inform the handoff; it does not produce the handoff.

### Recap and memory (#504)

The recap layer will import the content-free `DiscussionTurnSummary` from `@oscharko-dev/keiko-contracts`
to persist discussion metadata without retaining reviewable text. The structural guarantee — committed
transcript only via `selectCommittedVoiceTranscript` — ensures recap never accidentally stores
uncommitted, discarded, or failed text.

## 11. Acceptance criteria summary

| AC                                                               | Satisfied by                                                                                                                 | Evidence                                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| AC1 Text-only discussion works with no voice model               | `voiceCanDriveDiscussion("none") === false`; discussion contract and server path require no voice capability.                | No-voice evaluation fixtures + server tests                                                        |
| AC2 Voice reuses the same intelligence (no parallel stack)       | `discussion-voice.ts` reads `DISCUSSION_MODE_PLANS` from the shared contract; no mode re-encoding in `keiko-ui`.            | Test: voice binding uses the same plan table as the text path                                      |
| AC3 Disagree with evidence + assumptions + uncertainty           | `mandatedFacets` invariant in `DISCUSSION_MODE_PLANS` for all disagreement-capable modes; `DISAGREEMENT_FACETS` closed.     | Contract test: every disagreement-capable mode mandates all three facets                           |
| AC4 Interrupted spoken discussion recovers without context loss  | `applyDiscussionInterruption`/`applyDiscussionRecovery` preserve `mode`/`topicId`/`turnIndex`; voice binding wires it.      | Test: barge-in then recover produces identical `mode`, `topicId`, `turnIndex`; eval fixture        |
| AC5 No uncommitted transcript as durable memory or authority     | Committed-only input via `selectCommittedVoiceTranscript`; no write path in the binding; `WorkflowHandoffRequest` untouched. | Test: binding never reads raw segments; content-free invariant; no handoff emitted                |
| AC6 Evaluation covers no-voice and voice-capable profiles        | Five evaluation fixtures parameterized by `VoiceProfile` covering `none`, `speech-to-text`, and `full-realtime`.            | `keiko-evaluations/src/discussion/` suite; GO scorecard                                            |

## Related

- [ADR-0065](../adr/ADR-0065-discussion-intelligence.md): the authoritative decision record.
- [ADR-0063](../adr/ADR-0063-voice-transcript-segment-semantics.md): committed-only transcript boundary.
- [ADR-0062](../adr/ADR-0062-voice-turn-manager.md): turn manager; `VoiceTurnSnapshot`; no-authority effect posture.
- [ADR-0064](../adr/ADR-0064-voice-assistant-speech-output-playback.md): playback lifecycle; interruption forwarding.
- [ADR-0044](../adr/ADR-0044-prompt-enhancer-architecture.md): Prompt Enhancer; `CitationDiscipline`/`ContradictionPolicy`/`GroundingDirective` vocabulary.
- [ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md): voice architecture baseline; text-first principle.
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue [#502](https://github.com/oscharko-dev/Keiko/issues/502).
- [`packages/keiko-contracts/src/discussion-intelligence.ts`](../../packages/keiko-contracts/src/discussion-intelligence.ts): the contract types and functions.
- [`packages/keiko-ui/src/app/components/desktop/hooks/discussion-voice.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/discussion-voice.ts): the voice integration binding.
- [`packages/keiko-server/src/discussion-prompt.ts`](../../packages/keiko-server/src/discussion-prompt.ts): server-side directive block composition.
- [`docs/voice/transcript-semantics.md`](transcript-semantics.md): the committed-only projection and segment lifecycle.
- [`docs/voice/implementation-sequencing.md`](implementation-sequencing.md): Issue #502 dependency order and write-ownership.
