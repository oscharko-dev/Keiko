# Editor inline completion (ghost text)

Issue [#1200](https://github.com/oscharko-dev/Keiko/issues/1200) · Parent epic
[#1189](https://github.com/oscharko-dev/Keiko/issues/1189) · Decision record
[ADR-0042 D5/D6](adr/ADR-0042-keiko-editor-package-and-boundaries.md).

Keiko inline completion delivers VS Code-style **ghost text** while typing: a single suffix-aware
continuation rendered inline, accepted only by an explicit editor gesture. It **complements**, never
replaces, the deterministic language-service completion ([#1198]) and the governed completion gateway
([#1199]); when no governed model is usable it simply produces nothing and the deterministic dropdown
remains available. This document describes the bridge, the route, the gating and degradation
contract, the content boundary, request pacing, and the policy switch.

[#1198]: https://github.com/oscharko-dev/Keiko/issues/1198
[#1199]: https://github.com/oscharko-dev/Keiko/issues/1199

## Architecture (browser renders, server governs)

```
KeikoCodeEditor (provideInlineCompletions prop)
  → Monaco InlineCompletionsProvider bridge   packages/keiko-editor/src/components/inline-completion-bridge.ts
  → host resolver (keiko-ui)                  packages/keiko-ui/src/app/components/desktop/widgets/cards/EditorWidget.tsx
  → POST /api/editor/inline-completion        packages/keiko-server/src/editor/inlineCompletionRoutes.ts
      → selectCompletionModel (#1210)         gated, aligned FIM only
      → assembleCodingContext purpose:inline  (#1211) repo-search only
      → Model Gateway (server-side only)      single FIM continuation
```

The browser-tier `@oscharko-dev/keiko-editor` package only **wires** the Monaco provider and renders
the returned ghost text. It computes nothing, calls no model, performs no I/O, and value-imports no
Node-domain package (ADR-0042 D2/D5). All retrieval, model routing, redaction, evidence, and the BFF
call live server-side.

## Capability gating and degradation (Acceptance Criteria 1, 4)

Inline completion is **model-only** and gated by the Model Gateway completion-model selection
([#1210], documented in [editor-completion-model-capability.md](editor-completion-model-capability.md)):

| Trigger                    | Required interaction mode                     | Otherwise                  |
| -------------------------- | --------------------------------------------- | -------------------------- |
| `automatic` (as-you-type)  | a **fast**, aligned FIM model (`as-you-type`) | zero items (no ghost text) |
| `explicit` (manual invoke) | a fast OR slower aligned FIM model (`manual`) | zero items                 |

When the gateway is unconfigured, no aligned FIM model is available, every candidate exceeds the cost
ceiling, the feature is disabled by policy, or the per-root rate limit is hit, the route returns
**zero items** with a content-free `modelMode`/`degradeReason` and the editor falls back to the
deterministic completion gateway ([#1199]). There is never a silent ungoverned model call. A raw
`base`-FIM endpoint is rejected upstream (prompt-injection guardrail, ADR-0042 D5).

## Content boundary (Acceptance Criteria 3, 5, 7)

- The **request** carries the in-editor buffer text (the overlay the model infills, prefix **and**
  suffix around the cursor) — the user's own buffer over the loopback BFF, never logged.
- The **response** is content-free apart from `insertText`, the reviewable ghost-text continuation
  the user explicitly accepts. Provenance carries only ids, hashes, enum literals, and counts
  (`modelId`, `latencyClass`, `gatewayPolicyVersion`, a SHA-256 `promptHash`, the contributing source
  kinds) — never the prompt, the buffer, or any retrieved excerpt (EU AI Act Reg. (EU) 2024/1689
  Art. 12).
- Acceptance is explicit: the bridge only renders ghost text; the user commits it solely through
  Monaco's inline-suggest accept gesture. A superseded (`shouldDiscardResponse`, [#1192]) or rejected
  suggestion never mutates the buffer.

[#1192]: https://github.com/oscharko-dev/Keiko/issues/1192

## Request pacing, bounds, and cancellation

- **Debounce** — Monaco's built-in `debounceDelayMs` (~75 ms) bounds per-keystroke request pacing.
- **Cancellation / stale discard** — each request rides a content-free `EditorRequestIdentity`; the
  bridge wires an `AbortSignal` to Monaco's cancellation token and discards any response that a later
  keystroke superseded.
- **Latency budget** — as-you-type model calls self-cancel after **750 ms** (`AbortSignal.timeout`),
  the documented p95 ceiling (ADR-0042 D5). The per-keystroke render/INP budget is owned separately by
  #1207.
- **Bounded prompt / output** — prefix ≤ 4 000 chars, suffix ≤ 2 000 chars, reference excerpts capped;
  generated ghost text is clamped to a hard 2 000-char ceiling (lowered further by the optional
  `maxOutputTokens` request field).
- **Cost ceiling** — the optional `maxCostClass` request field is enforced by `selectCompletionModel`
  (#1206 binds the deployment budget).
- **Server-side rate limit** — a per-root cooldown + sliding-window cap
  (`inlineCompletionRateLimiter.ts`) skips the model tier when exceeded, returning zero items. This is
  the browser-uncontrollable half of pacing; the client debounce is the cooperative half.
- **Result filtering** — empty, whitespace-only, and suffix-duplicating continuations are dropped (a
  prefix-only model duplicating closing context is the anti-pattern this guards against).

## Acceptance/rejection telemetry (Acceptance Criterion 6)

The bridge accumulates **content-free counts** from Monaco's lifecycle callbacks — `offered`,
`shown`, `accepted`, `rejected`, `ignored`, `partiallyAccepted` (the accept/reject/ignore split comes
from Monaco's `handleEndOfLifetime` reason). The host posts a cumulative snapshot to
`POST /api/editor/inline-completion/telemetry`, which records it as evidence keyed by a **hash** of
the workspace root. No buffer text, ghost text, or prompt is ever in the telemetry path. Acceptance
rate is the primary, content-free quality metric.

## Disabling the feature (Acceptance Criterion 7)

Inline completion is **enabled by default**. A deployment disables it by setting the environment
variable `KEIKO_EDITOR_INLINE_COMPLETION` to a falsy token (`0`, `false`, `off`, `no`, `disabled`,
case-insensitive). The gate is enforced **server-side** in the route, so the browser cannot bypass it;
when disabled the route returns zero items and the editor shows no ghost text. Client-side, the
provider is registered only for the governed TypeScript/JavaScript source languages.
