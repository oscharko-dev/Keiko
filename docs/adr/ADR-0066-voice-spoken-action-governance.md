# ADR-0066: Voice Spoken Action Governance — fail-closed deterministic classification with confirmation binding and content-free audit

## Status

Accepted (Issue #503, Epic #491, 2026-06-25)

## Version

0.2.0

## Context

[ADR-0065](ADR-0065-discussion-intelligence.md) establishes that a `decide`-mode recommendation is
informational text only — it does not trigger an action, and any "decide → act" intent that the user
accepts still flows through the existing `WorkflowHandoffRequest` + `userApprovalToken` governed path.

Issue #503 completes that flow: it adds a deterministic, fail-closed normalization + confirmation layer
that sits **in front of** the existing governance. This layer ensures that:

1. Voice is treated as an **untrusted input source**. A committed spoken transcript may **propose** an
   action, but it can never **execute** one or bypass any existing gate.
2. Mutating, destructive, or externally-visible actions require explicit confirmation. A correction or
   interruption invalidates prior confirmation.
3. Evidence is content-free: no raw text, no audio, no credentials. Only counts, enums, and a
   deterministic digest are persisted.
4. The classification is a **guardrail**, not a semantic engine. It is deterministic and local (no NLU,
   no model call). Its accuracy is not load-bearing for safety because the default is fail-closed and a
   proposal is never an authorization — the existing approval-token + handoff gates still independently
   apply downstream.

The decision sections recorded here cover:

1. How effect classification is defined as a pure, deterministic, fail-closed contract.
2. Why classification remains local and deterministic (no NLU / no model call).
3. How confirmation binding is keyed to a content digest that changes when intent changes.
4. How the voice governance integrates with the existing `WorkflowHandoffRequest` path.
5. How voice actions are capability-gated.
6. How evidence is kept content-free.
7. Lifecycle and cancellation semantics.
8. Evaluation.
9. The UI binding and its deferred visible confirmation surface.

[ADR-0065](ADR-0065-discussion-intelligence.md) records the discussion intelligence architecture and
establishes the foundational interrupt-recovery model that the voice binding reuses.

## Decision

### D1 — Leaf contract defining effect taxonomy and confirmation semantics (AC1 / AC3)

The spoken-action-intent contract lives in a new leaf module at
[`packages/keiko-contracts/src/voice-action-intent.ts`](../../packages/keiko-contracts/src/voice-action-intent.ts).
It is a pure-data module: no IO, no clock reads, no randomness, no audio processing. It defines the
five effect classes, the confirmation input, the state machine, the capability gating predicate, and
the validators.

The module follows the ADR-0019 leaf-package rule: no `@oscharko-dev/keiko-*` imports appear; siblings
in `keiko-contracts` are reached by relative path. It is server-importable (keiko-server, keiko-evaluations,
and any future consumer can import it from `@oscharko-dev/keiko-contracts` without coupling to the UI).

`VOICE_ACTION_INTENT_SCHEMA_VERSION = "1" as const` follows the same evolution rule as other contract
versions (ADR-0010 D2): a breaking change introduces a new literal, never a mutation of `"1"`. It is
independent of `DISCUSSION_INTELLIGENCE_SCHEMA_VERSION`, `VOICE_PROTOCOL_VERSION`,
`VOICE_TRANSCRIPT_SCHEMA_VERSION`, and `CONVERSATION_CAPABILITY_CONTRACT_VERSION`.

### D2 — Five deterministic effect classes with fail-closed default (AC3)

We define five classes as a closed discriminated union to classify committed transcript text:

| Class              | Meaning                                                                  | Requires confirmation |
| ------------------ | ------------------------------------------------------------------------ | --------------------- |
| `read-only`        | Observes state without changing it.                                      | **no**                |
| `mutating`         | Changes persistent state (edit / write / update).                        | yes                   |
| `destructive`      | Irreversibly removes state (delete / drop / purge).                      | yes                   |
| `external-effect`  | Reaches outside the host (send / deploy / pay / call external system).   | yes                   |
| `unknown`          | The fail-closed default: text did not match a recognized read-only shape. | yes                   |

Classification is deterministic and **local only**. `classifySpokenActionEffect(committedText)` is
implemented as a simple marker-based matcher (ordered precedence: destructive > external-effect > mutating
> read-only, with unknown as the fail-closed default). It does not invoke NLU, a model, or any external
service.

The marker lexicon is small and auditable — each class has a fixed set of lowercase English keywords.
The text is locally normalized via Unicode NFKC canonicalization followed by zero-width, bidirectional,
and control-character stripping (fail-closed posture against Trojan-source attacks). The normalized text
is searched via whole-word matching so `set` does not match inside `settlement`. The text is never stored
or echoed.

**Why deterministic, not learned?** A learned classifier would increase the attack surface, require
careful deployment synchronization, and (most critically) would make the classification accuracy itself
load-bearing for safety. Instead, we accept that the default is fail-closed: text the classifier does
not recognize as read-only-only resolves to `unknown`, which requires confirmation. This posture is
standard in high-assurance systems (banking, insurer) and keeps the host boundary and authority model
clear.

**Note on AC1:** The capability gate is enforced server-side against the **deployment's resolved voice
capability**, not the client-claimed profile. The deployment configuration determines whether voice is
enabled; a client cannot claim `speech-to-text` capability if the server does not support it.

### D3 — Confirmation binding via deterministic content digest (AC4)

A spoken action proposal carries a `confirmationInput` containing the committed text (transiently, for
digest derivation), the turn index, the effect class, the transcript source, and the segment count.

`canonicalizeSpokenActionConfirmation(input)` produces a stable, deterministic canonical string from
these fields. The server computes `createSpokenActionDigest(input)` as sha256hex of this string.

When a user confirms an action, the confirmation is bound to this digest. If the committed text
subsequently changes (via a provider correction), the turn advances, or an interruption occurs, the
projection and thus the digest changes. Any prior confirmation no longer matches the current digest →
the state transitions to `superseded` → re-confirmation is required. This is AC4: misrecognized or
corrected segments cannot silently execute stale intent.

The digest is computed **downstream** (Artifact 2) from a canonical representation, never client-side
only. The server always recomputes the expected digest and compares it to the client-provided value to
prevent bypass via tampering.

**Split-binding design:** The confirmation digest binds the committed transcript (words + turn + effect),
while the approval token (via `checkPatchAgainstScope`) binds the request shape. Together they bind both
transcript and action. A documented potential future enhancement is to bind `contextPackStableId` and
`workflowKind` into the confirmation digest itself, further tightening the coupling between committed
intent and routed request. This would prevent a user from confirming intent A and inadvertently routing
intent B due to a race or UI state mismatch. Currently, the server's sequential validation gates ensure
correctness; the enhancement would add an additional invariant at confirm time.

### D4 — Route through existing WorkflowHandoffRequest (AC6 / no new authority)

Spoken action governance extends, not replaces, the existing governed-workflow path. A spoken proposal
enters the server via an optional `voiceOrigin` block on the `ParsedGroundedHandoffBody` (the same
endpoint that text-originated requests already use). The server runs `evaluateSpokenActionGovernance`
**in addition to** the existing `validateWorkflowHandoffRequest` and approval-token check. All gates
must pass.

**Critical boundary:** The spoken effect classification keys off the spoken **words** in the committed
transcript, not the routed workflow's actual `workflowKind` or `patchScope` effect. The effect class is
a guardrail that determines confirmation requirements. The load-bearing authority remains the
server-built `userApprovalToken` and `checkPatchAgainstScope`, which gate a voice request identically to
a text request. Classification is defense-in-depth layering, not a second authority.

The order of enforcement is critical:
1. Capability check: `voiceCanProposeAction(profile)` (AC1).
2. Committed-transcript check: normalized proposal exists (AC2).
3. Effect classification and confirmation check (AC3 / AC4).
4. Existing handoff validation: `validateWorkflowHandoffRequest(request).ok`.
5. Existing approval-token validation: token matches derived hash.

Each failure produces a content-free deny reason (`no-voice-capability`, `no-committed-transcript`,
`confirmation-required`, `confirmation-stale`, `invalid-handoff-request`, `approval-token-mismatch`).

The CSRF gate (`rejectIfInvalidStateChange`) is untouched and runs first, before any of this.

This design ensures that voice cannot weaken governance: a user cannot propose an action via voice that
they could not propose via text using the exact same workflow.

### D5 — Capability gating via transcript-capture predicate (AC1 / AC2)

A spoken action can be proposed only when the active deployment allows voice transcript capture.
`voiceCanProposeAction(profile)` is derived from `voiceTranscriptCaptureAllowed(profile)`, meaning
spoken actions are possible in `speech-to-text` and `full-realtime` profiles only.

In `none` and `speech-output` profiles, the entire spoken-action layer is dormant: no classification,
no state management, no confirmation handling (AC1). The UI binding returns `undefined` for any proposal
attempt.

An empty or whitespace-only committed projection also gates out: `normalizeSpokenActionProposal` returns
`undefined` when there is no text to classify (AC2).

### D6 — Evidence-safe audit record with content-free invariant (AC5)

The `SpokenActionAuditRecord` carries:

- Enums: `effectClass`, `state`, `outcome`.
- Booleans: `confirmationRequired`, `confirmed`.
- Integers: `turnIndex`, `committedSegmentCount`, `committedChars`.
- A string: `bindingDigest` (sha256 hex or empty string).

It has **no** `committedText` field, **no** `audio` field, and **no** raw input of any kind.

`committedText` is a transient seed: it lives in memory to derive the digest, but the digest itself is
the only artifact persisted to evidence. The audit record never stores or echoes raw text.

Forbidden substrings (apikey, secret, password, credential, bearer, baseurl, endpoint, authorization,
privatekey, accesskey, token, etc.) are scanned across the contract module as a test invariant to ensure
no template or constant leaks credentials or provider details.

**On the grounded-handoff route:** The `userApprovalToken` is server-built from request details and the
deployment secret—it is not a user secret. The real enforcing gate is `validateWorkflowHandoffRequest`
and `checkPatchAgainstScope`, which independently gate a voice request identically to a text request.
The approval-token equality check is redundant defense-in-depth: it adds a verification layer but is
not the sole gating authority on the grounded-handoff path.

### D7 — State machine with terminal invalidation states (AC4)

The spoken action lifecycle defines nine states:

| State                  | Meaning                                                                    | Terminal |
| ---------------------- | -------------------------------------------------------------------------- | -------- |
| `proposed`             | Normalized; ready to route or await confirmation.                         | no       |
| `awaiting-confirmation`| Confirmation-requiring action is waiting for explicit confirm step.        | no       |
| `confirmed`            | User confirmed; bound to current digest.                                  | no       |
| `routed`               | Handed to existing governance.                                            | no       |
| `completed`            | The routed action finished.                                               | yes      |
| `cancelled`            | User cancelled.                                                           | yes      |
| `superseded`           | Committed content changed; prior intent is void.                          | yes      |
| `interrupted`          | Barge-in or disconnect interrupted the turn.                              | yes      |
| `expired`              | Turn advanced past the proposal.                                          | yes      |

Legal transitions:

- Read-only path: `proposed → routed → completed`.
- Confirmation path: `proposed → awaiting-confirmation → confirmed → routed → completed`.
- Any non-terminal: → `cancelled` \| `superseded` \| `interrupted` \| `expired`.

Terminal states have no outgoing edges. A caller cannot transition from `completed` to any other state.

Cancellation can be triggered by user action (`cancel()`) or structural events (correction, interruption,
turn advance). A correction of the committed transcript transitions the state to `superseded` and
requires re-confirmation.

### D8 — Deterministic evaluation (Artifact 4)

Spoken action governance is evaluated in a purpose-built `packages/keiko-evaluations/src/voice-action/`
subpackage that mirrors the existing `discussion/` structure. It is fully deterministic: no model, no
clock, no randomness.

The scorer covers six dimensions:

| Dimension                   | What it measures                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `capability-gating`         | Voice actions are dormant in `none`/`speech-output` profiles (AC1).                  |
| `committed-only-input`      | Partial/stable/discarded transcript cannot propose an action (AC2).                   |
| `confirmation-discipline`   | Mutating+ actions require confirmation; read-only does not (AC3).                     |
| `stale-intent-prevention`   | Correction changes digest; prior confirmation is invalid; state → `superseded` (AC4). |
| `injection-resistance`      | Injected effect-class text still requires confirmation.                               |
| `evidence-safety`           | Audit record carries no text/audio; bindingDigest is content-free (AC5).              |

Fixtures cover capability-gated profiles:

| Fixture             | Profile              | Scenario                                                      |
| ------------------- | -------------------- | ------------------------------------------------------------- |
| `no-voice-capable`  | `none`               | Spoken action layer is dormant.                               |
| `partial-transcript`| `speech-to-text`     | Partial text cannot propose; committed-only input enforced.   |
| `read-only-action`  | `speech-to-text`     | Read-only action routes directly without confirmation.        |
| `mutating-action`   | `speech-to-text`     | Mutating action requires confirmation.                        |
| `injection-text`    | `speech-to-text`     | Injected effect-class keywords require confirmation.          |
| `correction-handling`| `speech-to-text`     | Correction changes digest; prior confirmation invalid.        |
| `interrupted-turn`  | `full-realtime`      | Interruption transitions state to `interrupted`.              |
| `denied-capability` | `none`               | Action denied when capability is unavailable.                 |

The suite produces a GO/NO-GO scorecard.

### D9 — UI binding and deferred visible confirmation surface

The keiko-ui hook (`packages/keiko-ui/src/app/components/desktop/hooks/voice-action-intent.ts`) is a
pure deterministic binding that:

- Creates a state-machine holder for a single spoken action proposal per turn.
- Reads committed transcript via `selectCommittedVoiceTranscript` (AC2).
- Classifies the effect and produces a proposal (AC3).
- Manages confirmation state and digest binding (AC4).
- Observes turn-manager snapshots to apply interruption and turn-advance invalidation.
- Emits observer notifications (content-free: no text in payloads, only enums and counts).
- Produces no side effects, makes no network calls, and cannot execute workflows.

The binding mirrors `discussion-voice.ts` exactly in posture: deterministic factory closure, content-free
observer, dormancy in non-capable profiles. `globals.css` is untouched (mirror #502 D10).

The render path that surfaces a visible confirmation UI (a button, modal, or gesture that lets the user
confirm or cancel a proposed action) is **deferred**. This mirrors the deferral posture of:

- ADR-0061 D10 (render-path wiring for the timing engine).
- ADR-0062 D10 (fixture posture for turn manager render integration).
- ADR-0065 D10 (mode selector surface).

The integration seams are documented in the voice binding module and in
[`docs/voice/action-intent-governance.md`](../voice/action-intent-governance.md). The binding is fully
functional; only the visible surface is deferred. When the UI surface is added, it will read the
proposal and confirmation state from the binding, but no changes to the binding or server governance are
required.

## Consequences

### Positive

- Voice is treated as an untrusted input source: a proposal is never an authorization (AC3 / AC6).
- Classification is deterministic and fail-closed, making it auditable and safe to deploy on-host
  without synchronizing a learned model (AC3).
- Confirmation is bound to the current committed content via digest. A correction or interruption
  invalidates prior confirmation, preventing stale intent from executing (AC4).
- Evidence is content-free: audit records carry only counts, enums, and a deterministic digest (AC5).
- The existing governed-workflow path is the sole authority. Voice cannot weaken governance; all
  existing gates still apply independently (AC6).
- The UI binding is fully functional and reusable for future confirmation surfaces; only the visible
  render is deferred.
- No new runtime dependency is introduced.

### Negative

- The visible confirmation UI surface is deferred, so users cannot yet explicitly confirm a spoken
  action from the UI. The binding and server path are ready; the picker surface is a future deliverable.
- Classification accuracy is intentionally limited to fail-closed defaults. A user who says "read the
  list" will get `unknown` and require confirmation even though the intent is read-only. This is
  deliberate: a false negative (deny when the action is read-only) is safer than a false positive
  (allow when the action is destructive).
- The marker lexicon requires deliberate extension if a new effect class is added; totality is enforced
  but raises the cost of extension.

### Neutral

- The confirmation binding uses sha256 digests, which are content-free but add a small computational
  cost per turn. This is negligible for the governed-action volume typical in conversational workflows.
- The `unknown` effect class is fail-closed by design, not a bug. It represents "unrecognized pattern"
  not "actually harmless." Treating it as mutating-level risk (requires confirmation) is the intended
  behavior.

## Deferred / Out of Scope

The following are explicitly not in scope for Issue #503:

- **Visible confirmation UI surface**: the UI render path (button, modal, or gesture) that displays the
  proposed action and confirmation state. The binding is fully functional; the visible surface is
  deferred to a future issue (D9).
- **Discussion turn integration**: discussion intelligence (#502) contributes only a content-free summary
  to the handoff evidence; routing discussion mode recommendations through this governance is #503's
  responsibility.
- **Recap and memory persistence**: persisting confirmed actions to a recap or memory store is #504's
  responsibility.
- **design-system/globals.css changes**: the confirmation surface, if any, reuses existing tokens; no
  CSS additions are permitted in this issue.

## Alternatives Considered

### Alternative 1: Learned effect classification

Use a small language model fine-tuned on effect types to classify the text.

- **Pros**: More accurate classification; fewer false `unknown` defaults.
- **Cons**: Increases the attack surface and host boundary complexity. Requires careful deployment
  synchronization so the classifier version matches the system. Most critically, would make
  classification accuracy itself load-bearing for safety — a misclassified destructive action as
  read-only becomes a real security issue, not just a UX inconvenience. The fail-closed guardrail
  posture would be lost.
- **Why rejected**: Deterministic classification keeps the host boundary clear and the safety model
  simple. The fail-closed default ensures that even misclassification (false `unknown`) is safe. For
  the banking / insurer audience, on-host deterministic control is a higher priority than
  accuracy.

### Alternative 2: Embed effect classification in the governed-workflow contract

Add effect-class definitions to `keiko-contracts/src/workflow-handoff.ts` alongside the request
definition.

- **Pros**: Keeps all governance in one module.
- **Cons**: Violates the separation of concerns. Workflow-handoff is about request validation and
  approval-token generation; effect classification is about transcript analysis and confirmation
  semantics. Mixing them would make the handoff contract responsible for both authoritatively.
- **Why rejected**: The voice-action-intent contract is a separate domain (spoken transcript →
  proposal) that consumes the handoff contract (proposal + request → governance). Keeping them separate
  maintains the dependency direction and makes each module's responsibility clear.

### Alternative 3: Store bindingDigest in the proposal, not the audit record

Persist the digest only while the proposal is active; discard it after routing.

- **Pros**: Slightly smaller audit record footprint.
- **Cons**: Loses the ability to audit which confirmation state was active when the action was routed.
  If a correction occurred, the audit record should reflect whether it happened before or after routing,
  and the digest is essential evidence for that.
- **Why rejected**: The digest is the only evidence that the right proposal was confirmed at the right
  time. Including it in the audit record closes the AC4 loop and enables future log analysis.

### Alternative 4: Require re-confirmation on every turn advance

Reset confirmation whenever the turn index changes, even if the committed text stays constant.

- **Pros**: Simplest implementation; maximally conservative.
- **Cons**: User experience cost: every minor turn adjustment (a correction off to the side of the
  proposed text) would require re-confirmation. Overly defensive for non-mutating content changes.
- **Why rejected**: Confirmation should be bound to the content intent, not the turn counter. If the
  user says "execute this action" and then later says "also execute this other action," they shouldn't
  have to re-confirm the first action. Binding to the digest (which changes only when commitment or
  effect class changes) is the right granularity.

## Related

- [ADR-0065](ADR-0065-discussion-intelligence.md) — discussion intelligence; decide-mode recommendation
  sourcing; no-authority guarantee; interrupt-recovery foundation.
- [ADR-0062](ADR-0062-voice-turn-manager.md) — turn manager; floor control; no-authority effect posture.
- [ADR-0063](ADR-0063-voice-transcript-segment-semantics.md) — committed-only transcript boundary;
  `selectCommittedVoiceTranscript`.
- [ADR-0019](ADR-0019-modular-package-architecture.md) — leaf-package rule; dependency direction.
- [ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md) — voice architecture baseline;
  text-first design principle.
- [`docs/voice/action-intent-governance.md`](../voice/action-intent-governance.md) — the specification
  companion to this ADR.
- [`packages/keiko-contracts/src/voice-action-intent.ts`](../../packages/keiko-contracts/src/voice-action-intent.ts) —
  the contract types and functions.
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491), Issue
  [#503](https://github.com/oscharko-dev/Keiko/issues/503).

## Date

2026-06-25
