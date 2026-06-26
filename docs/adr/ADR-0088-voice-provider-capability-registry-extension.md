# ADR-0088: Voice provider capability registry extension — product voice personas, server-side voice-id mapping, kind-aware readiness classification

## Status

Proposed (Issue #1557, Epic #1556, 2026-06-26)

## Version

0.1.0

## Context

Epic #1556 builds a **colleague-like voice dialogue mode** on top of the completed Epic #491 voice foundation
(ADR-0058..0069, merged to `dev`). Issue #1557 is the first child: it extends the **provider capability
registry** so the gateway can (a) represent the deployment classes that back voice dialogue, (b) map a
**product-level voice persona** (male / female / neutral) to a provider-specific voice id **server-side**, and
(c) present already-configured voice providers in model lists as *available*, not as a chat-ineligibility
warning. It adds no dialogue-mode UI and no realtime transport (those are later children).

A read-first mapping of the current capability surface establishes the starting point. Everything below is
**already in `dev`** from Epic #491:

- **The voice modality is a first-class `ModelKind`.** `ModelKind` is `"chat" | "embedding" | "ocr-vision" |
  "voice"` ([`gateway.ts`](../../packages/keiko-contracts/src/gateway.ts) line 24); `"voice"` is never
  conversation-eligible, never workflow-eligible, and trips the fail-closed `INELIGIBILITY_REASON_BY_KIND`
  exhaustiveness gate (`voice → "voice-only"`, lines 400–406). `CONVERSATION_CAPABILITY_CONTRACT_VERSION = 3`
  (line 14) governs `ModelKind` and `ModelCapability`'s structural shape.
- **`ModelCapability` already carries the voice sub-capability flags and locality** —
  `supportsSpeechInput?`, `supportsSpeechOutput?`, `supportsRealtimeVoice?`, `voiceProviderLocality?`
  ([`gateway.ts`](../../packages/keiko-contracts/src/gateway.ts) lines 107–127) — plus the pure, total,
  fail-closed predicates `isVoiceCapability`, `modelSupportsSpeechInput/Output/RealtimeVoice` (lines 206–224).
  These predicates live in **contracts** so the browser-tier `keiko-ui` can value-import them without crossing
  ADR-0019 trust rule 3 (UI → `model-gateway/src` is forbidden at error severity).
- **The degradation ladder already exists.** `VoiceProfile = "none" | "speech-to-text" | "speech-output" |
  "full-realtime"` ([`gateway.ts`](../../packages/keiko-contracts/src/gateway.ts) line 234) is the *capability
  degradation ladder*; `resolveVoiceCapabilityFromCapabilities`
  ([`capabilities.ts`](../../packages/keiko-model-gateway/src/capabilities.ts) lines 340–376) maps advertised
  sub-capabilities to a profile, electing `full-realtime` only when `realtimeVoice OR (speechToText AND
  speechOutput)` among **configured + reachable** voice capabilities. The result type
  `VoiceCapabilityResolution` ([`gateway.ts`](../../packages/keiko-contracts/src/gateway.ts) lines 254–269) is
  content-free (enums + booleans only) and is returned by the BFF `GET /api/voice/capability`.
- **Selection helpers exist for STT and realtime, but not speech-output.**
  `selectSpeechToTextModel` and `selectRealtimeVoiceModel`
  ([`model-selection.ts`](../../packages/keiko-model-gateway/src/model-selection.ts) lines 134–164) elect a
  configured voice provider cheapest-first; there is no `selectSpeechOutputModel`, and no persona→voice-id
  resolver.
- **The credential tier is physically separate from the wire tier.** `ModelProviderConfig`
  ([`types.ts`](../../packages/keiko-model-gateway/src/types.ts) lines 49–58) holds `baseUrl`/`apiKey` and
  **stays in `keiko-model-gateway/src`** so contracts never carries an apiKey-shaped surface (ADR-0019
  direction 1, contracts-leaf). `toSafeObject` ([`config.ts`](../../packages/keiko-model-gateway/src/config.ts)
  lines 1136–1149) projects each provider to a **strict allowlist** (`SafeProviderConfig`: `modelId`,
  `credentialHeaderName`, `timeoutMs`, `maxRetries`, `retryBaseDelayMs`) — every provider field not on that
  allowlist is dropped by omission.
- **There are exactly three browser-facing serializations of capability/provider data**, all emitting raw
  `ModelCapability[]` and/or `SafeGatewayConfig`: `GET /api/models`
  ([`read-handlers.ts`](../../packages/keiko-server/src/read-handlers.ts) line 69), `GET /api/config` via
  `toSafeObject` (line 58), and the setup-success body
  ([`gateway-setup.ts`](../../packages/keiko-server/src/gateway-setup.ts) lines 1251–1252). `ModelCapability`
  carries **no secret today**.
- **The strict capability parser is a closed allowlist.** `MODEL_CAPABILITY_KNOWN_KEYS`
  ([`config.ts`](../../packages/keiko-model-gateway/src/config.ts) lines 737–761) rejects any unknown key so an
  adversarial config cannot smuggle a future-named field past the parser; voice fields are parsed
  present-only so a record round-trips exactly (`parseVoiceCapabilityFields`, lines 642–654).
- **Readiness is a live, chat-only probe.** `gateway-readiness.ts` runs a real network probe and rejects any
  non-chat model (`isConversationEligibleModel`,
  [`gateway-readiness.ts`](../../packages/keiko-server/src/gateway-readiness.ts) lines 193–209). ADR-0058 D1
  forbids voice capability probing from calling external endpoints during ordinary startup; voice resolution is
  deterministic and probe-free by construction.
- **Brand-new scope.** Male / female / neutral **product voice profiles** are absent from every ADR, every
  type, and every doc — they are introduced here for the first time.
- **The AC4 defect.** `SettingsPanel.tsx`'s `ConversationEligibilityBadge` renders voice providers RED as
  "Not selectable — not a chat model" via `explainConversationIneligibility → "voice-only"`. That is *correct*
  for the chat dropdown (voice is genuinely chat-ineligible) but a *presentation* defect for an operator who
  has correctly configured a working voice provider.

These facts force a single sharp design question: **the persona→provider-voice-id mapping is provider-sensitive
and must never reach the browser, yet the existence of personas must reach the browser so the UI can offer
selection.** The decisions below split that one fact across the two tiers.

## Decision

We extend the existing capability registry **additively**, reusing the proven contracts-leaf split and the
closed-allowlist parser. No new credential store, no new dependency, no live network probe, no contract version
bump, no change to existing gating logic.

### D1 — `VoicePersona` is a PRODUCT profile, deliberately distinct from the `VoiceProfile` capability ladder (AC3)

We add `VoicePersona = "male" | "female" | "neutral"` to **contracts**, with `VOICE_PERSONAS` as the canonical
ordered tuple. A `VoicePersona` is a **product-level voice identity** the operator offers to the end user —
"what the assistant sounds like." It is **not** the existing `VoiceProfile` (`none` / `speech-to-text` /
`speech-output` / `full-realtime`), which is the **capability degradation ladder** — "how much voice the
deployment can do." The two are orthogonal: a `full-realtime` deployment may offer all three personas, one, or
none; a `speech-to-text`-only deployment offers **no** personas because personas are *output* voices.

The distinct nouns are load-bearing, not cosmetic: a future reader who conflates them would, e.g., wrongly
assume persona availability follows the ladder. We keep `VoiceProfile` unchanged and name the new concept
`VoicePersona` precisely so the two never collide in code, in review, or in the operator's mental model. (See
the adversarial review note in §Alternatives for why `VoicePersona` is preferred over `VoiceStyle` /
`VoiceCharacter`.)

### D2 — Persona→voice-id mapping lives on the credential tier; only content-free persona enums cross to the browser (AC3, HIGHEST-STAKES)

This is the decision the whole issue turns on. We split the single "persona has a provider voice id" fact
across the two existing tiers, exactly along the existing apiKey boundary:

1. **The sensitive mapping lives on `ModelProviderConfig` (credential tier,
   [`types.ts`](../../packages/keiko-model-gateway/src/types.ts), never in contracts):**

   ```ts
   readonly voiceProfiles?: readonly VoicePersonaVoice[] | undefined;
   ```

   where `VoicePersonaVoice = { readonly persona: VoicePersona; readonly voiceId: string }`. `voiceId` is a
   **provider-sensitive** string (ADR-0058 D6 Engineering Notes treat provider voice identifiers as sensitive
   provider metadata). It sits beside `apiKey` and is governed by the same physical boundary.

2. **Only the content-free persona enums cross to the browser**, as a derived field on `ModelCapability`
   (contracts, browser-serialized):

   ```ts
   readonly supportedVoicePersonas?: readonly VoicePersona[] | undefined;
   ```

   This carries **only** the persona literals (`"male" | "female" | "neutral"`) — never a `voiceId`. It is
   **derived at parse time** from the provider's `voiceProfiles` (D-config below), never an operator input key.

**Why this is strictly stronger than projecting at the BFF.** The alternative — keep the full mapping in
contracts/capability and have each BFF route strip `voiceId` before responding — depends on *every present and
future* serialization remembering to strip. We have three serialization sites today (`/api/models`,
`/api/config`, setup-success) and the surface grows. Putting `voiceId` on the **credential tier** makes a leak
**structurally impossible**, not merely policy-enforced:

- `voiceId` lives on `ModelProviderConfig`, which **cannot** be imported into contracts (ADR-0019 direction 1
  forbids it; contracts is a leaf), so it can never appear on a contracts-defined wire type.
- `toSafeObject` projects providers through a **strict allowlist** (`SafeProviderConfig`), so `voiceProfiles`
  is dropped **by omission** — adding a new sensitive provider field cannot accidentally widen the safe
  projection, because the projection enumerates what it *keeps*, not what it *removes*.
- The other two serializations (`/api/models`, setup-success `models`) emit `ModelCapability[]`. The only voice
  field there is `supportedVoicePersonas`, which is content-free enums — so even a full, un-stripped capability
  dump leaks nothing sensitive.

**Adversarial validation — is there any other path that leaks `voiceId`?** We checked every browser-facing
serialization of `ModelCapability` or `ModelProviderConfig`:

| Path | Emits | Carries `voiceId`? |
| --- | --- | --- |
| `GET /api/models` (`read-handlers.ts:69`) | `ModelCapability[]` | No — capability never holds `voiceId` |
| `GET /api/config` (`read-handlers.ts:58`, `toSafeObject`) | `SafeGatewayConfig` (allowlisted providers + `capabilities`) | No — `voiceProfiles` dropped by allowlist; `capabilities` carry only persona enums |
| Setup-success body (`gateway-setup.ts:1251–1252`) | `ModelCapability[]` + `toSafeObject` | No — same as above |
| `GET /api/voice/capability` (`resolveVoiceCapability`) | `VoiceCapabilityResolution` | No — content-free by construction (D3) |

The leak-proof argument: **`voiceId` is confined to a type (`ModelProviderConfig`) that the contracts leaf
cannot reference and that every serialization either cannot reach or projects through a keep-only allowlist.**
No third path exists. A regression test must pin this by asserting that the JSON of `/api/models`, `/api/config`,
and the setup-success body never contains any configured `voiceId` substring.

### D3 — Kind-aware readiness classification is deterministic and probe-free (Deliverable 3, AC4)

Deliverable 3 ("readiness checks that distinguish working voice providers from merely non-chat providers") and
AC4 are satisfied by **deterministic, content-free capability predicates** in **contracts**, not by adding a
live network voice probe to `gateway-readiness.ts`:

```ts
export function isConfiguredVoiceProvider(capability: ModelCapability): boolean; // voice kind AND ≥1 sub-capability
export function describeVoiceProviderAvailability(capability: ModelCapability): VoiceProviderAvailability;
```

where `VoiceProviderAvailability` is a content-free descriptor `{ available, speechToText, speechOutput,
realtimeVoice, personas, providerLocality? }`. These are the "capability predicates, not deployment-name
branches" the Engineering Notes mandate.

We **explicitly reject** adding a live voice probe to readiness:

- It violates ADR-0058 D1 (voice capability probing must not call external endpoints during ordinary startup).
- It violates the deterministic-verification quality gate that the whole epic preserves — a network probe makes
  readiness non-deterministic and order/timing dependent.
- `gateway-readiness.ts` is **architecturally chat-only** (`isConversationEligibleModel` rejects non-chat at
  lines 203–208); a voice provider is correctly never elected there. Re-shaping that probe to accept voice
  would weaken its chat-only contract for no benefit.

The "working vs. merely-non-chat" distinction is a **capability** distinction (does this provider advertise a
usable voice sub-capability?), which the predicates answer deterministically from already-parsed config — no
network call.

### D4 — AC1 dialogue-capable gating is already enforced; #1557 adds regression tests, not new gating (AC1)

`resolveVoiceCapabilityFromCapabilities` already elects `full-realtime` **only** when a configured + reachable
provider advertises `realtimeVoice OR (speechToText AND speechOutput)` (lines 323–338, 359–367), and only
configured providers are eligible (the fail-closed rule shared with `selectConfiguredModel`). AC1 is therefore
**already satisfied by existing logic**. #1557 adds explicit regression tests over the resolver (no-voice,
STT-only, speech-output-only, STT+TTS, realtime) and introduces **no new gating field** — a redundant
"dialogueCapable" boolean would be a second source of truth and is rejected.

### D5 — AC4 is a positive-presentation fix; `isConversationEligibleModel` stays unchanged (AC4)

We do **not** make voice conversation-eligible — voice is genuinely not a chat model and must stay out of the
chat dropdown and the chat smoke-test loop. The AC4 fix is purely **presentation**: when
`isConfiguredVoiceProvider(capability)` is true, the UI renders a positive "Voice provider — STT / Speech output
/ Realtime" badge (reusing the existing neutral/embedding badge styling, with `role="status"` and an accessible
label) **instead of** the red chat-ineligibility warning. The new contracts predicate is the single source the
UI branches on; `isConversationEligibleModel` and `explainConversationIneligibility` are untouched.

### D6 — Speech-output and persona selection complete the selection family (AC2, AC3)

For symmetry with `selectSpeechToTextModel` / `selectRealtimeVoiceModel`, we add to **model-gateway**:

- `selectSpeechOutputModel(config): string | undefined` — cheapest-first configured provider advertising
  speech output, same fail-closed rule (only configured providers are eligible).
- `selectVoicePersonaVoice(config, persona): { readonly modelId: string; readonly voiceId: string } |
  undefined` — the **server-side** persona→voice-id resolver. It reads `provider.voiceProfiles` (credential
  tier) and is the seam Issue #1558 consumes. Its return value carries `voiceId` and therefore **stays
  server-side** — it is never a BFF response body shape.

The five deployment classes named in AC2 (`keiko-stt`, `keiko-tts`, `keiko-audio-output`, `keiko-realtime`,
`keiko-realtime-stt`) are **representable by `modelId` + capability flags + `voiceProfiles`** with **no
hard-coded deployment names** anywhere — confirmed: those names appear only in doc comments today, and
`CAPABILITY_DATA` ships empty. A config test must represent all five by id.

### D7 — Invariants carried forward from Epic #491

- **Content-free wire surface.** Every browser-serialized field added here (`supportedVoicePersonas`,
  `availableVoicePersonas`, `VoiceProviderAvailability.personas`) carries only persona/sub-capability enums —
  no `voiceId`, no base URL, no credential, no audio, no transcript.
- **No new credential store.** `voiceId` reuses the existing credential-tier provider record; no new vault,
  file, or encryption path is introduced.
- **Capability predicates, not deployment names.** All routing/presentation branches on advertised capability
  (`supportsSpeechOutput`, persona presence), never on a provider/deployment string.
- **Additive + optional + readonly.** Every new field is optional (`| undefined`, `exactOptionalPropertyTypes`
  is on) and `readonly`; no existing field changes shape, so no contract version bump (see §Consequences).

## Consequences

### Positive

- A single, structurally-enforced boundary keeps `voiceId` server-side: the contracts leaf cannot reference the
  type that holds it, and the safe projection keeps-only by allowlist. The browser learns *which personas
  exist* without ever learning *which provider voice id* backs them.
- The voice selection family becomes complete and symmetric (STT / speech-output / realtime / persona), so
  Issue #1558 builds on a stable, fail-closed seam.
- AC4's model-list defect is fixed without weakening any gate: voice stays chat-ineligible and out of the smoke
  loop; only its *presentation* changes.
- Readiness stays deterministic and probe-free; the chat-only readiness contract is preserved.

### Negative

- The persona→voice-id mapping is **split across two tiers** (enums in contracts, ids on the provider), so an
  implementer must hold both halves in mind and the parser must *derive* one from the other. This is the price
  of structural leak-proofing; it is documented and test-pinned rather than hidden.
- `VoicePersona` and `VoiceProfile` are similar nouns; despite D1's explicit distinction, a careless reader
  could still confuse them. Mitigated by doc comments at both definitions and a cross-reference.

### Neutral

- **No `CONVERSATION_CAPABILITY_CONTRACT_VERSION` bump.** That constant governs `ModelKind` /
  `ModelCapability`'s *structural* shape; `supportedVoicePersonas` is an *additive optional* `ModelCapability`
  field (same precedent as the Epic #761 determinism flags and the #493 voice sub-capability flags, which also
  did not bump). `VoiceCapabilityResolution` is a **resolution result**, not governed by the capability
  contract version at all; adding the *required* field `availableVoicePersonas` to it is an in-place evolution
  of a server-produced result type (every producer is updated in the same change), not a wire-contract version
  event. The resolver is the single producer, so a missing field cannot reach a consumer.
- `availableVoicePersonas` is **required** (not optional) on `VoiceCapabilityResolution`: an empty array is the
  honest "no personas available" value, so optionality would add an ambiguous third state for no benefit.

## Alternatives Considered

### Alternative 1: Keep the full persona→voice-id mapping on `ModelCapability` and strip `voiceId` at each BFF route

- **Pros**: one tier; the resolver and parser see the whole mapping in one place.
- **Cons**: leak-safety becomes a *policy* every present and future serialization must remember; three sites
  today, growing; one forgotten `JSON.stringify` leaks provider voice ids to the browser.
- **Why rejected**: D2 — putting `voiceId` on the credential tier makes the leak *structurally impossible*,
  strictly stronger than per-route stripping.

### Alternative 2: Add a live voice readiness probe to `gateway-readiness.ts`

- **Pros**: "readiness" would reflect a real round-trip to the voice endpoint.
- **Cons**: violates ADR-0058 D1 (no startup probing of voice endpoints), makes readiness non-deterministic,
  and forces the chat-only readiness path to accept non-chat models.
- **Why rejected**: D3 — the "working vs. non-chat" distinction is a *capability* question answerable
  deterministically from parsed config; a probe adds nondeterminism and gate-weakening for no real signal.

### Alternative 3: Add a `dialogueCapable: boolean` field to `ModelCapability` or `VoiceCapabilityResolution`

- **Pros**: a single boolean the UI could read directly.
- **Cons**: duplicates a fact the resolver already computes (`profile === "full-realtime"`); two sources of
  truth can disagree; it is a derived value, not an input.
- **Why rejected**: D4 — AC1 is already enforced by the resolver; the fix is regression tests, not a redundant
  field.

### Alternative 4: Name the new concept `VoiceStyle` or `VoiceCharacter` instead of `VoicePersona`

- **Pros**: `VoiceStyle` is shorter; `VoiceCharacter` is vivid.
- **Cons**: `VoiceStyle` collides conceptually with provider "speaking style/emotion" parameters (a different
  axis we are not modeling) and would mislead; `VoiceCharacter` overloads "character" (string char / role-play
  persona). Neither reads as "the operator-offered voice identity."
- **Why rejected**: D1 — `VoicePersona` is the clearest name that (a) does not collide with `VoiceProfile` and
  (b) accurately denotes a product-level voice identity. Firm recommendation: keep `VoicePersona`.

## Related

- ADR-0058: Capability-gated Voice Digital Twin architecture (D1 probe-free, D5 `ModelKind: "voice"`, D6
  provider-credential/voice-id sensitivity, D7 locality) — this ADR extends it.
- ADR-0059..0069: Epic #491 voice transport, protocol, turn-manager, and governance ADRs.
- ADR-0019: package trust direction (contracts is a leaf; UI may value-import from contracts but not from
  `model-gateway/src`).
- `docs/voice/capability-configuration.md`, `docs/voice/deployment-profile-matrix.md` — extended with the
  persona / `voiceProfiles` config example.
- Issue [#1557](https://github.com/oscharko-dev/Keiko/issues/1557); Epic
  [#1556](https://github.com/oscharko-dev/Keiko/issues/1556).

## Date

2026-06-26
