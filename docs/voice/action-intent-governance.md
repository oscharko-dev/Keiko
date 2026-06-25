# Spoken Action Intent Governance — fail-closed intent classification, confirmation binding, and content-free audit

Specification for Epic #491, the deliverable of Issue
[#503](https://github.com/oscharko-dev/Keiko/issues/503) and the authoritative companion to
[ADR-0066](../adr/ADR-0066-voice-spoken-action-governance.md). It **defines** the five effect classes,
confirmation semantics, state machine, content-free audit requirements, and threat model. The contract
lives in [`packages/keiko-contracts/src/voice-action-intent.ts`](../../packages/keiko-contracts/src/voice-action-intent.ts);
the server governance lives in [`packages/keiko-server/src/voice-action-governance.ts`](../../packages/keiko-server/src/voice-action-governance.ts);
the UI binding lives in [`packages/keiko-ui/src/app/components/desktop/hooks/voice-action-intent.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-action-intent.ts).

## 0. Core security principle: Voice is UNTRUSTED

> A committed spoken transcript may **propose** an action, but it can never **execute** one or bypass
> any existing gate. The spoken-action layer **adds** preconditions; it removes none.
>
> Classification is a **guardrail**, not a semantic engine. Its accuracy is not load-bearing for
> safety because (a) the default is fail-closed (`unknown` → confirmation required), and (b) a
> proposal is never an authorization — the existing approval-token + handoff gates still
> independently apply downstream.
>
> This principle is standard in high-assurance systems (banking, insurance): on-host deterministic
> control, fail-closed defaults, and clear separation of proposal from authorization.

## 1. Scope and versioning

- **In scope:** the five effect classes and their fail-closed classification algorithm; the
  confirmation-input canonicalization and digest binding (AC4); the state machine with terminal
  invalidation states; the content-free audit record; server governance enforcement (`evaluateSpokenActionGovernance`);
  the UI binding with observer pattern; capability gating (AC1 / AC2); the threat model and injection
  resistance; deferred visible confirmation surface.
- **Out of scope (deferred to later issues):** the visible confirmation UI (render path that displays
  and prompts the user to confirm). The binding is functional; the surface is deferred (D9).
- **Versioning:** `VOICE_ACTION_INTENT_SCHEMA_VERSION = "1"`. A breaking change introduces a new
  literal rather than mutating `"1"`. It is independent of `DISCUSSION_INTELLIGENCE_SCHEMA_VERSION`,
  `VOICE_PROTOCOL_VERSION`, `VOICE_TRANSCRIPT_SCHEMA_VERSION`, and
  `CONVERSATION_CAPABILITY_CONTRACT_VERSION`.

## 2. Effect classification (AC3)

### The five classes

Classification categorizes the committed transcript text into one of five effect classes, ordered by
risk and confirmation requirement:

| Class             | Meaning                                                                          | Examples                                    | Requires confirmation |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------- | --------------------- |
| `read-only`       | Observes state without altering it.                                              | "show", "list", "read", "view", "find"      | **no**                |
| `mutating`        | Changes persistent state but does not remove it.                                 | "create", "add", "edit", "update", "set"    | yes                   |
| `destructive`     | Irreversibly removes state.                                                      | "delete", "remove", "drop", "purge", "wipe" | yes                   |
| `external-effect` | Reaches outside the host: sends, deploys, or calls an external service.          | "send", "deploy", "email", "pay", "post"    | yes                   |
| `unknown`         | **Fail-closed default:** text did not match a recognized read-only-only pattern. | "handle this", "do it", unrecognized verbs  | yes                   |

### Classification algorithm

`classifySpokenActionEffect(committedText: string): SpokenActionEffectClass` is deterministic and
local-only:

1. Normalize the committed text: apply Unicode NFKC canonicalization, strip zero-width/bidirectional/control characters (Trojan-source defense), lowercase, trim, and collapse internal whitespace runs.
2. Apply ordered precedence: if any marker from the `destructive` lexicon appears (whole-word match),
   return `destructive`. Otherwise, check `externalEffect`, then `mutating`, then `readOnly` in order.
3. If no marker matches, return `unknown` (fail-closed).

**Marker lexicons** (auditable, fixed):

| Class            | Markers                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `destructive`    | delete, remove, drop, purge, erase, destroy, wipe, truncate         |
| `externalEffect` | send, deploy, publish, email, pay, transfer, call, post, merge      |
| `mutating`       | create, add, update, edit, rename, move, write, set, change, modify |
| `readOnly`       | show, list, read, view, display, find, search, open, get, describe  |

Whole-word matching prevents `set` from matching inside `settlement` or `setting`. Markers are ASCII
only; the classification normalization includes defenses against Trojan-source attacks.

### Why deterministic, not learned?

Avoids:

- **Attack surface expansion**: no external model, no deployment synchronization required.
- **Load-bearing accuracy**: a learned classifier misclassifying destructive as read-only becomes a
  real security issue. Deterministic classification guarantees that the worst case is fail-closed
  (`unknown`), not unsafe.
- **Host boundary complexity**: keeps the authority model simple and auditable.

The tradeoff is accept false `unknown`: a user who says "read the list" may get `unknown` and require
confirmation. This is safer than false-negatives (allow when destructive). For banking / insurer
deployments, on-host deterministic control is non-negotiable.

## 3. Confirmation semantics and digest binding (AC4)

### Why confirmation is bound to content

When a user says "execute this action" and then says "correct that last bit," the action the user
intended changes. The confirmation was for the original intent, not the corrected one. Binding
confirmation to the committed content ensures that corrections invalidate prior confirmation.

### Confirmation input and canonicalization

A `SpokenActionConfirmationInput` captures:

```typescript
{
  schemaVersion: "1",
  committedText: string,        // transient seed; never persisted
  turnIndex: number,
  effectClass: SpokenActionEffectClass,
  source: VoiceTranscriptSource,
  committedSegmentCount: number,
}
```

`canonicalizeSpokenActionConfirmation(input)` produces a stable, deterministic string via
length-prefixed field ordering:

```
v=1
turn=5
effect=mutating
source=speech-to-text
segments=2
textlen=25
text=create a new project
```

This canonical form is the seed for the digest.

### Digest computation and binding

The server computes `createSpokenActionDigest(input): string` as:

```
sha256hex(canonicalizeSpokenActionConfirmation(confirmationInput))
```

When a user confirms, the UI captures this digest. When the user later tries to route the action, the
server:

1. Recomputes the expected digest from the current committed text and turn state.
2. Compares the client-provided digest to the expected digest.
3. If they match: confirmation is valid, proceed.
4. If they differ: state transitions to `superseded`, re-confirmation required (AC4).

The server **always recomputes the digest** and never trusts a client-provided value. This prevents
bypass via tampering.

### What invalidates confirmation

Confirmation becomes invalid (state → `superseded`) when:

- The committed transcript text changes (via provider correction or user edit).
- The effect class changes (e.g., user added "delete" to the original text).
- The turn index advances.
- An interruption or disconnect occurs.

In all cases, the digest differs from the current state. Re-confirmation is required.

### Split-binding design

The confirmation digest binds the committed transcript (words + turn + effect), while the approval
token (via `checkPatchAgainstScope`) binds the request shape. Together they bind both transcript and
action. A documented potential future enhancement is to bind `contextPackStableId` and `workflowKind`
into the confirmation digest itself, further tightening the coupling between committed intent and
routed request. This would prevent a user from confirming intent A and inadvertently routing intent B
due to a race or UI state mismatch. Currently, the server's sequential validation gates ensure
correctness; the enhancement would add an additional invariant at confirm time.

## 4. State machine and lifecycle (AC4 / AC7)

### Nine states, five terminal

```
proposed ──→ awaiting-confirmation ──→ confirmed ──→ routed ──→ completed
  ↓                  ↓                     ↓            ↓         (terminal)
  cancelled      cancelled           cancelled     cancelled
  superseded     superseded          superseded    superseded
  interrupted    interrupted         interrupted   interrupted
  expired        expired             expired       expired
```

**Paths:**

- Read-only: `proposed → routed → completed` (no confirmation).
- Confirmation-required: `proposed → awaiting-confirmation → confirmed → routed → completed`.
- Cancellation: any non-terminal → `cancelled` (user cancels).
- Invalidation: any non-terminal → `superseded` (content changes), `interrupted` (barge-in), or
  `expired` (turn advances).

**Terminal states** (no outgoing transitions): `completed`, `cancelled`, `superseded`, `interrupted`,
`expired`.

### State transitions

Illegal transitions (e.g., `awaiting-confirmation → routed` without confirming) are blocked. The UI
binding's `confirm()` method checks that the current state is `awaiting-confirmation` before
transitioning to `confirmed`.

The turn manager's interrupt notification triggers a transition to `interrupted`. A correction
transcript triggers a transition to `superseded` with a new proposal awaiting confirmation.

## 5. Content-free audit and evidence (AC5)

### Audit record structure

The `SpokenActionAuditRecord` persists:

```typescript
{
  schemaVersion: "1",
  effectClass: SpokenActionEffectClass,
  state: SpokenActionState,
  confirmationRequired: boolean,
  confirmed: boolean,
  outcome: SpokenActionOutcome,          // routed, denied, cancelled, superseded, not-applicable
  source: VoiceTranscriptSource,
  turnIndex: number,
  committedSegmentCount: number,
  committedChars: number,
  bindingDigest: string,                 // sha256 hex or ""
}
```

**No text field. No audio field. No credentials.** Only counts, enums, and a content-free digest.

### Commitment to content-free

The contract module is scanned for forbidden substrings as a test invariant:

- Credentials: apikey, secret, password, credential, token, privatekey, accesskey, bearer.
- Provider details: baseurl, endpoint, authorization, providerconfig.
- System control: systemprompt, toolauthority, grantedtools, allowedtools, canexecute.

Any match in the module source (not just templates) fails the test. This ensures no credential or
provider URL can accidentally leak into the contract definition.

## 6. Threat model and injection resistance

### Threat 1: Injection of effect-class keywords

**Scenario:** User is attacked to say "show my balance, then delete all accounts."

**Defense:** The committed transcript contains both "show" (read-only) and "delete" (destructive).
Precedence is destructive > read-only, so the effect class is `destructive` and confirmation is
required. The injected keywords do not bypass the confirmation gate; they just shift the classification
correctly to higher risk.

**Outcome:** Injection detected and handled fail-closed (requires confirmation). ✓

### Threat 2: Misrecognition into a dangerous phrase

**Scenario:** User says "read the file" but STT misrecognizes it as "delete the file."

**Defense:** The proposal is classified as `destructive`. Confirmation is required. When the user goes
to confirm, they see the committed text "delete the file" and can immediately correct it. The turn
manager records the correction, the digest changes, and the prior confirmation (if the user had
pre-confirmed) becomes invalid.

**Outcome:** False-positive destructive classification is safe (just annoying). User can correct and
re-confirm. ✓

### Threat 3: Correction timing attack

**Scenario:** User confirms an action, then a correction from the STT provider arrives.

**Defense:** The correction changes the committed projection. The binding detects this via the committed
text changing and calls `applyCommitted(segments)`. The digest now differs from the confirmation the
user gave. The server's `evaluateSpokenActionGovernance` will reject it with
`confirmation-stale` because the digests no longer match. Re-confirmation is required. The old
confirmation cannot be reused.

**Outcome:** Stale confirmation is rejected. ✓

### Threat 4: Forged approval token

**Scenario:** User gives voice confirmation; attacker tries to forge a `userApprovalToken` to bypass
the approval gate.

**Defense:** The server validates the approval token against the request via `createApprovalToken(
approvalTokenInputFor(request))`. The token is derived from the request details and the deployment
secret. An attacker without the secret cannot forge a valid token.

**Outcome:** Approval-token check remains in place and is not weakened by voice. ✓

### Threat 5: Partial transcript as a proposal

**Scenario:** User is still speaking. Attacker tries to route an incomplete / unstable transcript
before the user finishes.

**Defense:** The entry gate checks `voiceCanProposeAction(profile)` and normalizes against the
committed projection from `selectCommittedVoiceTranscript`. Partial, stable, and discarded segments
are structurally excluded. Only committed and corrected segments appear in the projection. An action
cannot be routed before the user commits the transcript.

**Outcome:** Partial input is blocked by construction. ✓

## 7. Capability gating (AC1 / AC2)

### When spoken actions are allowed

`voiceCanProposeAction(profile: VoiceProfile): boolean` returns `true` only when:

- The profile is `speech-to-text` or `full-realtime`.
- The deployment has the `voiceTranscriptCaptureAllowed` capability.

`none` and `speech-output` profiles return `false`. The entire spoken-action layer is dormant in those
profiles: no state machine, no observer calls, no classification.

**AC1 is enforced server-side** against the deployment's resolved voice capability, not the client's
claimed profile. The deployment configuration determines whether voice is enabled; a client cannot claim
a voice-capable profile if the server does not support it.

### Empty or whitespace text

`normalizeSpokenActionProposal` returns `undefined` when `projection.text.trim().length === 0`. There
is no text to classify, so there is no proposal.

## 8. Integration with existing governance (AC6)

### The handoff path

A spoken action proposal enters the server via an optional `voiceOrigin` block on the
`ParsedGroundedHandoffBody`:

```typescript
voiceOrigin?: {
  profile: VoiceProfile,
  turnIndex: number,
  source: VoiceTranscriptSource,
  committedSegmentCount: number,
  committedText: string,
  confirmationDigest?: string,
}
```

In `handleCreateRun` (`POST /api/runs`), after the existing `governedHandoff` request is parsed:

1. If `voiceOrigin` is absent: the path is unchanged. Text-originated requests proceed as before
   (byte-identical).
2. If `voiceOrigin` is present: run `evaluateSpokenActionGovernance(params)`.
   - If `allowed: true`: thread the audit record into evidence and proceed.
   - If `allowed: false`: return 403 with the deny reason.

### Routing boundary and defense-in-depth

The spoken effect classification keys off the **spoken words** in the committed transcript, not the
routed workflow's actual `workflowKind` or `patchScope` effect. The effect class is a guardrail that
determines confirmation requirements. The load-bearing authority remains `validateWorkflowHandoffRequest`
and `checkPatchAgainstScope`, which gate a voice request identically to a text request. Effect
classification is defense-in-depth layering: it adds a precondition but is not itself the authority
for approval. On the current run route, the `userApprovalToken` is verified against the canonical
request details; the token equality check is redundant defense-in-depth that adds verification but is
not the sole gating authority.

### Enforcement order

1. CSRF gate (`rejectIfInvalidStateChange` in server.ts) — runs first, untouched.
2. `voiceCanProposeAction(profile)` — AC1.
3. `normalizeSpokenActionProposal(projection, ...)` — AC2 (empty text gating).
4. Compute expected digest and check confirmation (AC3 / AC4).
5. `validateWorkflowHandoffRequest(request).ok` — existing handoff validation.
6. `request.userApprovalToken === createApprovalToken(...)` — existing token validation.

Each gate is independent. Failure at any step produces a deny reason and a content-free audit record.
Voice cannot weaken or bypass any existing control.

## 9. Observer pattern in the UI binding

The UI binding (`createVoiceActionIntentBinding(options)`) exposes:

```typescript
export interface VoiceActionIntentObserver {
  onProposed?(e: {
    effectClass: SpokenActionEffectClass;
    requiresConfirmation: boolean;
    committedChars: number;
  }): void;
  onStateChange?(e: { from: SpokenActionState; to: SpokenActionState; turnIndex: number }): void;
}
```

**Content-free:** No `committedText` in the event payloads. Only enums, booleans, and integers. A
consuming UI can render a confirmation prompt ("Confirm: Mutating action, 42 chars") without ever
seeing the actual transcript.

This matches the posture of `discussion-voice.ts` (issue #502) and ensures that the UI binding can be
tested, debugged, and audited without needing to inspect raw user input.

## 10. Deferred visible confirmation surface

The binding produces state and notification events. A future issue will add the UI components that
render the confirmation prompt and buttons. The binding itself is complete and testable today.

The seam is documented: a consuming UI will call `binding.propose()`, observe notifications, and call
`binding.confirm()` or `binding.cancel()` based on user gestures. No changes to the binding or server
path are needed when the surface is added.

## 11. Acceptance criteria summary

| AC                                                            | Satisfied by                                                                             | Evidence                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| AC1 No-voice profiles are dormant                             | `voiceCanProposeAction("none")===false`; binding returns undefined                       | Contract tests + server tests                                            |
| AC2 Partial/unstable/discarded transcript cannot propose      | `normalizeSpokenActionProposal` returns undefined for empty projection                   | Contract tests; `selectCommittedVoiceTranscript` structure               |
| AC3 Mutating+ requires confirmation; read-only does not       | `classifySpokenActionEffect` deterministic; `SPOKEN_ACTION_EFFECT_REQUIRES_CONFIRMATION` | Contract tests; effect-class table is exhaustive                         |
| AC4 Correction invalidates prior confirmation; digest binding | `canonicalizeSpokenActionConfirmation` differs on text change; state → `superseded`      | Contract tests; binding tests on correction; server digest recomputation |
| AC5 Audit record is content-free                              | No text/audio field; forbidden-substring scan; bindingDigest only                        | Contract tests + module scanning invariant                               |
| AC6 Voice cannot weaken existing governance                   | `evaluateSpokenActionGovernance` runs after `validateWorkflowHandoffRequest` and token   | Server tests; integration tests; security review                         |

## Related

- [ADR-0066](../adr/ADR-0066-voice-spoken-action-governance.md): the authoritative decision record.
- [ADR-0065](../adr/ADR-0065-discussion-intelligence.md): discussion intelligence; decide-mode
  recommendation sourcing.
- [ADR-0062](../adr/ADR-0062-voice-turn-manager.md): turn manager; `VoiceTurnSnapshot`.
- [ADR-0063](../adr/ADR-0063-voice-transcript-segment-semantics.md): committed-only transcript
  boundary; `selectCommittedVoiceTranscript`.
- [ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md): voice architecture
  baseline; text-first principle.
- [ADR-0019](../adr/ADR-0019-modular-package-architecture.md): leaf-package rule.
- [`packages/keiko-contracts/src/voice-action-intent.ts`](../../packages/keiko-contracts/src/voice-action-intent.ts):
  the contract module.
- [`packages/keiko-server/src/voice-action-governance.ts`](../../packages/keiko-server/src/voice-action-governance.ts):
  server governance enforcement.
- [`packages/keiko-ui/src/app/components/desktop/hooks/voice-action-intent.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-action-intent.ts):
  the UI binding.
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#503](https://github.com/oscharko-dev/Keiko/issues/503).
