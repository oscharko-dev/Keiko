# ADR-0065: Discussion Intelligence — text-first colleague-like discussion contract, additive prompt orchestration, and voice stack reuse

## Status

Accepted (Issue #502, Epic #491, 2026-06-25)

## Version

0.2.0

## Context

[ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md) through
[ADR-0064](ADR-0064-voice-assistant-speech-output-playback.md) established a complete, optional, and
capability-gated Voice Digital Twin stack: runtime timebase ([ADR-0061](ADR-0061-voice-timing-engine.md)),
floor-control turn manager ([ADR-0062](ADR-0062-voice-turn-manager.md)), committed-only transcript
lifecycle ([ADR-0063](ADR-0063-voice-transcript-segment-semantics.md)), and optional assistant
speech-output playback ([ADR-0064](ADR-0064-voice-assistant-speech-output-playback.md)).

What is **missing** is a layer that makes Keiko a reliable thinking partner: a set of distinguishable
colleague-like discussion behaviors that let it challenge assumptions, review evidence, brainstorm
alternatives, help reach a decision, and verify claims — all grounded in evidence, assumptions, and
residual uncertainty. These behaviors must be available immediately, in every deployment, without any
voice model. Voice-capable deployments must reuse the same intelligence rather than implement parallel
behavior stacks.

Issue #502 delivers this layer. The decisions recorded here cover:

1. How the five discussion modes are defined and encoded as a pure, text-first, provider-neutral contract.
2. How the existing prompt-enhancer citation / contradiction / grounding vocabulary is reused rather than
   replaced.
3. How the three disagreement facets (evidence / assumptions / uncertainty) are encoded and mandated per
   mode.
4. How the orchestration injects mode directives as an additive block without mutating
   `CONVERSATION_SYSTEM_PROMPT`.
5. How voice input drives the same contract rather than a parallel path.
6. How an interrupted spoken discussion turn recovers without losing the active question or decision
   context.
7. How the committed-only voice transcript boundary is enforced.
8. How the content-free invariant is maintained across every boundary.
9. What is explicitly deferred and what the integration seams are.

[ADR-0044](ADR-0044-prompt-enhancer-architecture.md) records the Prompt Enhancer architecture and
establishes the `CitationDiscipline`, `ContradictionPolicy`, and `GroundingDirective` vocabulary that
Discussion Intelligence reuses.

## Decision

### D1 — Text-first, pure-data leaf contract in `keiko-contracts` (AC1)

The discussion-intelligence contract lives in a new leaf module at
[`packages/keiko-contracts/src/discussion-intelligence.ts`](../../packages/keiko-contracts/src/discussion-intelligence.ts).
It is a pure-data module: no IO, no clock reads, no randomness, no audio processing. It defines the
five discussion modes, the ten directives, the per-mode plans, the capability gating predicate, the
interruption-recovery turn model, the content-free turn summary, and the validators.

The module follows the ADR-0019 leaf-package rule: no `@oscharko-dev/keiko-*` imports appear; siblings
in `keiko-contracts` are reached by relative path (`./prompt-enhancer.js`, `./gateway.js`,
`./voice-transcript.js`). It is server-importable (keiko-server, keiko-evaluations, and any future
consumer can import it from `@oscharko-dev/keiko-contracts` without coupling to the UI).

Discussion intelligence is **always available**. The text path requires no voice model. The capability
gate (`voiceCanDriveDiscussion`) governs only whether spoken turns may drive the module; it does not
gate the module itself.

`DISCUSSION_INTELLIGENCE_SCHEMA_VERSION = "1" as const` follows the same evolution rule as other
contract versions (ADR-0010 D2): a breaking change introduces a new literal, never a mutation of `"1"`.
It is independent of `VOICE_PROTOCOL_VERSION`, `VOICE_TRANSCRIPT_SCHEMA_VERSION`, and
`CONVERSATION_CAPABILITY_CONTRACT_VERSION`.

### D2 — Five discussion modes with frozen total behavioral plans (AC1 / AC3)

We define five modes as a closed discriminated union:

| Mode             | Core behavior                                        | Mandated facets                          | `producesDecisionRecommendation` |
| ---------------- | ---------------------------------------------------- | ---------------------------------------- | -------------------------------- |
| `challenge`      | Challenges assumptions; surfaces counter-evidence    | evidence, assumptions, uncertainty       | false                            |
| `review`         | Verifies claims against evidence; discloses gaps     | evidence, assumptions, uncertainty       | false                            |
| `decide`         | Offers a recommended action with trade-offs          | evidence, assumptions, uncertainty       | true                             |
| `brainstorm`     | Expands option space before converging; best-effort  | evidence, assumptions _(uncertainty relaxed)_ | false                       |
| `evidence-check` | Strict citation; flags unsupported claims            | evidence, assumptions, uncertainty       | false                            |

Each mode has exactly one entry in `DISCUSSION_MODE_PLANS`, a frozen total table keyed by `DiscussionMode`
so a new mode without a plan is a compile error. The four disagreement-capable modes (`challenge`,
`review`, `decide`, `evidence-check`) mandate all three `DISAGREEMENT_FACETS`; `brainstorm` relaxes
uncertainty because it expands the option space rather than arguing a position.

The plan reuses `CitationDiscipline`, `ContradictionPolicy`, and `GroundingDirective` from
`./prompt-enhancer.js` rather than inventing parallel types. This is AC2 — the same vocabulary governs
both the static prompt-enhancement path and the dynamic discussion path.

### D3 — Three disagreement facets as a closed vocabulary (AC3)

Professional disagreement is encoded as three mandatory facets:

- `evidence` — the observable facts or sources behind the position.
- `assumptions` — the premises the position rests on, stated explicitly.
- `uncertainty` — the residual confidence and unresolved unknowns.

`DISAGREEMENT_FACETS: readonly DisagreementFacet[]` is the closed catalog. A disagreement-capable mode
mandating fewer than all three is a contract violation caught by both `validateDiscussionModePlan` and
the contract test suite. `ConfidenceLevel = "high" | "medium" | "low"` bridges the design-system
`.ai-conf[data-level]` token (three segments: high fills all three, medium fills two, low fills one).
`confidenceLevelFromScore(score)` maps a model-reported 0–1 float to a level with documented,
tested cut points: a non-finite or out-of-range input guards to `low`; `< 1/3 → low`, `< 2/3 → medium`,
`≥ 2/3 → high`. The cut-point at `1/3` rounds up (i.e., exactly `1/3` is `medium`); the cut-point at
`2/3` rounds up (exactly `2/3` is `high`).

### D4 — Additive prompt block; `CONVERSATION_SYSTEM_PROMPT` is immutable (Artifact 2)

When the BFF receives a chat request with a `discussionMode`, the server renders the mode's directives
into an additive labeled block via `composeDiscussionDirectiveBlock(mode): string` in
`packages/keiko-server/src/discussion-prompt.ts`. This block is prepended as a labeled section **before**
the user-message block in `composeConversationPrompt`; `CONVERSATION_SYSTEM_PROMPT` is not modified.

The `SendDesktopChatRequest` body gains an optional `discussionMode?: DiscussionMode` field; the BFF
validates it via `isDiscussionMode` against the closed `DISCUSSION_MODES` set. An unknown or non-string
value is **not** a request error — `parseDiscussionMode` silently drops it to `undefined` (the field is
optional and turn-local), so the turn simply falls back to the default no-mode behavior. Absence means
the current behavior is byte-identical — fully backward-compatible. The mode is turn-local; it is not
persisted in compacted history and does not affect the model-gateway layer.

This additive design preserves the invariant that `CONVERSATION_SYSTEM_PROMPT` is the single governed
immutable contract, and that any future system-prompt expansion remains a deliberate, auditable change
rather than a mode injection.

### D5 — No new authority; action intent routes through the existing governed handoff (AC5)

Discussion intelligence has no write path. A `decide`-mode recommendation is informational: Keiko
describes the recommended action and its trade-offs in text. Any "decide → act" intent that the user
accepts still flows through the existing `WorkflowHandoffRequest` + `userApprovalToken` path (Issue
#503). This module never produces a `WorkflowHandoffRequest`, never calls a tool, and never advances
compacted history on behalf of an action.

The voice integration hook (`packages/keiko-ui/src/app/components/desktop/hooks/discussion-voice.ts`)
mirrors this: it is a content-free observer. It reads committed voice transcript; it maps voice signals
to a `DiscussionMode`; it manages interruption-recovery context. It emits no side effects, makes no
model calls, and produces no handoff. The same no-authority guarantee documented in ADR-0062 D7 applies
here.

### D6 — Voice reuse: committed-only transcript, existing turn manager, existing playback summary (AC2 / AC5)

When a voice-capable deployment uses discussion intelligence, the voice binding consumes the stack
assembled by Issues #499–#501 **without modification**:

- Discussion input from voice is read exclusively via `selectCommittedVoiceTranscript(segments).text`
  (ADR-0063 committed-only boundary). Partial, stable, discarded, redacted, and provider-error segments
  are structurally excluded from this projection and cannot become discussion input or memory.
- Interruption recovery observes the `VoiceTurnSnapshot` from the ADR-0062 turn manager. When
  `snapshot.state === "interrupted"` or `snapshot.recovering === true`, the binding calls
  `applyDiscussionInterruption(ctx)` to preserve the active `DiscussionTurnContext`; when recovery
  clears, `applyDiscussionRecovery(ctx)` restores the identical `mode`, `topicId`, and `turnIndex`.
- Capability gating is derived from `voiceTranscriptCaptureAllowed(profile)` (ADR-0063), delegated
  through `voiceCanDriveDiscussion(profile)` in the discussion contract. Voice-driven discussion is
  available in `speech-to-text` and `full-realtime`; it is unavailable in `none` and `speech-output`.
  The module is dormant (no clock read, no mutation, no observer call) in the `none` and
  `speech-output` profiles.
- The same `DISCUSSION_MODE_PLANS` contract and `DISCUSSION_DIRECTIVE_TEMPLATES` govern both the text
  path and the voice path. There is one behavioral definition; the voice binding reads it, not a
  parallel copy.

No new authority accrues to voice: there is no spoken shortcut past the `WorkflowHandoffRequest` gate.

### D7 — Interruption-recovery turn model with no-context-loss proof (AC4)

The discussion contract defines a four-status turn lifecycle: `active → interrupted → recovered →
resolved` (with `recovered` allowed to cycle through `interrupted` for repeated barge-ins). The pure
helpers `beginDiscussionTurn`, `applyDiscussionInterruption`, `applyDiscussionRecovery`, and
`resolveDiscussionTurn` follow the ADR-0063 voice-transcript posture: illegal transitions return the
input unchanged rather than throwing.

`applyDiscussionRecovery` preserves `mode`, `topicId`, and `turnIndex` with no mutation — this is the
no-context-loss proof for AC4. A test verifies the full `active → interrupted → recovered` path and
asserts that all three fields are identical to the initial values. The `topicId` is an opaque,
NFKC-normalized, path-fragment-free bounded identifier (≤256 chars, no control characters); it is never
raw text.

### D8 — Content-free invariant everywhere (AC5)

No raw user or assistant text, transcript excerpt, credential, provider URL, session token, tool grant,
or egress authority is ever a field of any type defined in this contract. Every value that crosses a
boundary is a closed enum, a boolean, a bounded 0–1 float, an integer, a timestamp, or a fixed
content-free instruction template string (bounded length, no raw input echo). The test suite asserts
this for directive templates by scanning for forbidden substrings (apikey, secret, password, credential,
bearer, baseurl, endpoint, providerconfig, systemprompt, authorization, privatekey, accesskey,
toolauthority, grantedtools, allowedtools, canexecute).

The `DiscussionTurnSummary` returned by `summarizeDiscussionTurn` carries only enums, an integer count,
and an optional `ConfidenceLevel`; it does not carry `topicId` or any reviewable text. Later consumers
(#503 governed handoff, #504 recap) read this summary without encountering text.

### D9 — Dedicated deterministic evaluation subpackage (Artifact 4)

Discussion behavior is evaluated in a purpose-built `packages/keiko-evaluations/src/discussion/`
subpackage that mirrors the existing `promptEnhancer/` structure. It is fully deterministic: no model,
no clock, no randomness. The scorer covers seven dimensions (`mode-appropriateness`,
`disagreement-completeness`, `uncertainty-discipline`, `evidence-citation-discipline`,
`correction-handling`, `interruption-recovery`, `capability-gating`) and the fixture set covers both
no-voice and voice-enabled profiles (AC6: `no-voice-challenge`, `no-voice-decide`, `voice-stt-review`,
`voice-realtime-barge-in-recovery`, `evidence-check-correction`). The suite produces a GO/NO-GO
scorecard mirroring `PromptEnhancerScorecard`.

### D10 — Visible composer mode selector is a documented, deferred seam

The render path that would surface a composer-level mode selector to the user (a picker letting the user
choose `challenge`, `review`, `decide`, `brainstorm`, or `evidence-check` before sending a message) is
**deferred**. This mirrors the deferral posture of ADR-0061 D10 (render-path wiring for the timing
engine) and ADR-0062 D10 (fixture posture for turn manager render integration).

The integration seams are documented in the voice binding module (`discussion-voice.ts`) and in
[`docs/voice/discussion-intelligence.md`](../voice/discussion-intelligence.md). The `discussionMode`
field on `SendDesktopChatRequest` is already wired; a future issue adds only the UI surface that
populates it. This keeps `design-system/globals.css` and its SHA-pinned proofs unchanged.

## Consequences

### Positive

- Keiko is fully usable with no voice model: discussion intelligence works in the `none` profile, proven
  by no-voice evaluation fixtures and server tests (AC1).
- The same behavioral definition (`DISCUSSION_MODE_PLANS`) governs both text and voice paths; there is
  no parallel stack to maintain (AC2).
- The three disagreement facets are a compile-enforced, tested invariant for all disagreement-capable
  modes (AC3).
- Interrupted spoken discussions recover without losing the active mode, topic identity, or turn index,
  proven by pure functional tests (AC4).
- Uncommitted, partial, or discarded transcript text cannot become discussion input by construction
  (AC5).
- Discussion evaluation covers both no-voice and voice-capable deployment profiles with deterministic
  fixtures (AC6).
- The additive prompt block keeps `CONVERSATION_SYSTEM_PROMPT` byte-identical for all existing calls;
  the no-mode path is a tested backward-compatibility invariant.
- No new runtime dependency is introduced.

### Negative

- The visible composer mode selector is deferred, so users cannot yet explicitly select a mode from the
  UI. The `discussionMode` wire is ready; the picker surface is a future deliverable.
- Mode is turn-local and not persisted in compacted history: a resumed session does not remember the
  mode the user had selected, requiring re-selection for long or compacted sessions.
- The ten-directive closed vocabulary requires deliberate extension if a new mode is added later; the
  total plan table enforces completeness but raises the cost of adding a mode.

### Neutral

- `brainstorm` intentionally relaxes the uncertainty facet mandate because it expands option space
  rather than arguing a position. This is an explicit design choice documented in tests; reviewers
  should expect `mandatedFacets` to cover only two facets for that mode.
- The `topicId` is opaque (never raw text), which means the discussion turn model has no first-party
  knowledge of what question is being discussed — that is by design for the content-free boundary.

## Deferred / Out of Scope

The following are explicitly not in scope for Issue #502:

- **Visible composer mode selector**: the UI surface (button, dropdown, or gesture) that lets the user
  pick a mode. The BFF field is wired; the UI render-path is deferred (D10).
- **Governed spoken action handoff**: routing a `decide`-mode voice recommendation through
  `WorkflowHandoffRequest` is Issue #503's responsibility. This module produces the recommendation
  as informational text only.
- **Recap and memory persistence**: persisting discussion turns to a recap or memory store is Issue
  #504's responsibility.
- **Live provider audio driving discussion**: driving discussion turn context from live
  `play-started`/`complete` events of a deployed speech-output provider is deferred to the issue that
  deploys speech output.
- **`design-system/globals.css` changes**: the mode selector, if any, reuses existing tokens; no CSS
  additions are permitted in this issue.
- **New runtime media packages**: none are introduced.

## Alternatives Considered

### Alternative 1: Embed discussion mode in the system prompt (static variant selection)

Instead of an additive per-turn block, maintain five distinct `CONVERSATION_SYSTEM_PROMPT` variants,
one per mode plus the default.

- **Pros**: No server-side composition step; the prompt is fully static per session.
- **Cons**: `CONVERSATION_SYSTEM_PROMPT` is the single governed immutable contract; forking it into
  five variants eliminates that governance property and doubles the surface requiring review. Mode
  becomes session-scoped rather than turn-local, preventing mid-conversation mode changes. The
  prompt-enhancer citation/grounding vocabulary would need to be duplicated per variant.
- **Why rejected**: Violates the immutability invariant and produces five maintenance surfaces where
  one additive injection suffices. The additive block design satisfies the same goal with no
  immutability cost.

### Alternative 2: Implement discussion intelligence as a parallel behavior stack in the voice module

Create a separate `discussion-voice-plans.ts` in `keiko-ui` that re-encodes citation disciplines,
contradiction policies, and grounding directives for the voice use case.

- **Pros**: Each package is fully self-contained; no shared contract for discussion mode.
- **Cons**: Directly contradicts AC2. Two stacks diverge over time; a bug fix in one does not fix the
  other. The prompt-enhancer vocabulary already exists in `keiko-contracts`; re-encoding it in `keiko-ui`
  violates the dependency-direction rule (UI depending on duplicated policy rather than the contracts
  leaf).
- **Why rejected**: The spec's AC2 makes this a hard requirement. The shared `DISCUSSION_MODE_PLANS`
  table is the single behavioral definition; the voice binding reads it.

### Alternative 3: Add a new `EvidenceTaskType` for discussion rather than a separate contract module

Extend `keiko-evidence` with a `"discussion"` task type and encode the five modes there.

- **Pros**: Reuses the existing evidence infrastructure; no new contract module.
- **Cons**: `EvidenceTaskType` governs evidence-capture runs, not runtime conversational behavior. The
  five modes are a live per-turn orchestration concern, not an offline evidence classification. Placing
  them in `keiko-evidence` would create a dependency from server orchestration to an evidence package
  for a purely behavioral classification. The leaf-package rule (ADR-0019) requires contracts to be the
  domain leaf; embedding behavioral plans in evidence would invert the dependency direction.
- **Why rejected**: Wrong layer. The contracts leaf is the correct location for a pure behavioral plan
  that both server (orchestration) and UI (voice binding) consume. The evaluation subpackage in
  `keiko-evaluations` covers the evidence-scoring concern separately (D9).

### Alternative 4: Encode the directives as free-form natural-language strings constructed at runtime

Instead of a closed `DiscussionDirective` vocabulary with fixed templates, let the server compose
directive text dynamically from the mode name and contextual parameters.

- **Pros**: More flexible; modes could be customized per deployment.
- **Cons**: Dynamic composition makes content-free invariant testing impossible. Any bug in the
  composition function could inject arbitrary text, including tokens that look like credentials or
  system-prompt overrides. The closed vocabulary with fixed templates (tested for forbidden substrings)
  is the only design that makes the content-free invariant verifiable.
- **Why rejected**: The content-free invariant (D8) requires a closed, tested vocabulary. Dynamic
  composition would require runtime content scanning at every invocation, which is both more expensive
  and less reliable than a compile-time closed set.

## Related

- [ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md) — capability-gated voice architecture;
  text-first design principle.
- [ADR-0059](ADR-0059-voice-control-media-capability-replay-protocol.md) — wire protocol; capability table.
- [ADR-0062](ADR-0062-voice-turn-manager.md) — turn manager; `VoiceTurnSnapshot`; no-authority effect posture.
- [ADR-0063](ADR-0063-voice-transcript-segment-semantics.md) — committed-only transcript boundary;
  `selectCommittedVoiceTranscript`; `voiceTranscriptCaptureAllowed`.
- [ADR-0064](ADR-0064-voice-assistant-speech-output-playback.md) — playback lifecycle; interruption
  forwarding to turn manager.
- [ADR-0044](ADR-0044-prompt-enhancer-architecture.md) — Prompt Enhancer architecture; `CitationDiscipline`,
  `ContradictionPolicy`, `GroundingDirective` vocabulary reused here.
- [ADR-0019](ADR-0019-modular-package-architecture.md) — leaf-package rule; dependency direction.
- [`docs/voice/discussion-intelligence.md`](../voice/discussion-intelligence.md) — the specification
  companion to this ADR.
- [`docs/voice/implementation-sequencing.md`](../voice/implementation-sequencing.md) — Issue #502
  sequencing, dependency graph, and write-ownership boundaries.
- [`packages/keiko-contracts/src/discussion-intelligence.ts`](../../packages/keiko-contracts/src/discussion-intelligence.ts) —
  the contract types and functions.
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491), Issue
  [#502](https://github.com/oscharko-dev/Keiko/issues/502).

## Date

2026-06-25
