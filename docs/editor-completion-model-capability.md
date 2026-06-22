# Editor completion model capability and degradation contract

Issue [#1210](https://github.com/oscharko-dev/Keiko/issues/1210) · Parent epic
[#1189](https://github.com/oscharko-dev/Keiko/issues/1189) · Decision record
[ADR-0042 D5](adr/ADR-0042-keiko-editor-package-and-boundaries.md).

Keiko editor inline completion is an **infilling** task: the cursor almost always has code after it,
so a prefix-only model duplicates code and breaks closing context (Bavarian et al. 2022,
[arXiv:2207.14255](https://arxiv.org/abs/2207.14255)). This document describes the Model Gateway
capability that records whether a model can do suffix-aware completion, the completion-oriented model
selection that consumes it, and the degradation contract the completion ([#1199]) and inline
completion ([#1200]) features rely on.

[#1199]: https://github.com/oscharko-dev/Keiko/issues/1199
[#1200]: https://github.com/oscharko-dev/Keiko/issues/1200

## The capability fields

`ModelCapability` (`@oscharko-dev/keiko-contracts`, `gateway.ts`) gains two **additive, optional**
fields. They follow the Epic #761 precedent (`supportsSeeding` / `supportsResponseFormat`): optional
members never bump `CONVERSATION_CAPABILITY_CONTRACT_VERSION`, and a future flag (for example
`edit-prediction` for next-edit prediction) is another optional member, never a structural break.

| Field                | Type                                              | Meaning                                                                                                    |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `supportsInfilling`  | `boolean` (optional)                              | The model supports suffix-aware (fill-in-the-middle / FIM) completion.                                     |
| `infillingAlignment` | `"base" \| "instruct" \| "edit-tuned"` (optional) | The alignment posture of the model's infilling endpoint. Only meaningful when `supportsInfilling` is true. |

Both are **chat-only** and enforced by the config parser: `supportsInfilling: true` is rejected on a
non-chat kind, and `infillingAlignment` requires `supportsInfilling: true`.

### Alignment is a security boundary, not only a quality one

Editor ghost text is assembled from the buffer and retrieved context, which are **untrusted model
input** (ADR-0042 D6). A raw `base` FIM endpoint re-opens a documented prompt-injection surface — the
SAL benchmark reports base-FIM attack-success-rate ≈ 99% versus ≈ 13.8% for instruct/edit-tuned
infilling. Governed completion therefore admits only `instruct` and `edit-tuned` variants. An
**undeclared** alignment is treated as unsafe (fail-closed): it is never elected for completion.

## Effective-latency awareness

The selection reuses the existing `latencyClass` field. As-you-type ghost text requires **both** the
aligned FIM capability **and** `latencyClass: "fast"`, so a `standard`/`slow` model is never elected
for per-keystroke completion (ADR-0042 D5). A slower aligned model is still usable, but only on manual
invoke.

## Completion-model selection

`selectCompletionModel(config, { maxCostClass })`
(`@oscharko-dev/keiko-model-gateway`, `model-selection.ts`) resolves the configured capabilities and
applies the pure decision tree in `selectCompletionModelFromCapabilities`. Only configured providers
are eligible, so a capability that names no provider can never be elected. The single source of truth
for the predicates (`modelSupportsInfilling`, `isAlignedInfillingModel`, `isAsYouTypeCompletionModel`)
lives in contracts so the browser tier can value-import them without crossing ADR-0019.

Decision order:

1. **As-you-type** — the cheapest aligned, `fast`, in-budget FIM model. Debounced ghost text.
2. **Manual** — otherwise, the cheapest aligned, in-budget FIM model that is `standard`/`slow`.
   Manual-invoke inline suggestion.
3. **Deterministic** — otherwise, degrade to the deterministic language-service completion path
   ([#1198](https://github.com/oscharko-dev/Keiko/issues/1198), [editor-language-service.md](editor-language-service.md)).
   Never a silent ungoverned model.

Cost ties are broken by configuration order (first declared wins), matching `selectConfiguredModel`.

### Cost ceiling (#1206)

`maxCostClass` is the per-call cost ceiling the inline-completion feature is allowed to spend
([#1206](https://github.com/oscharko-dev/Keiko/issues/1206), OWASP LLM10). A candidate above the
ceiling is excluded; if excluding it leaves no eligible model, selection degrades deterministically
with reason `over-cost-ceiling`. An omitted ceiling means no limit — this layer invents no default
budget; the deployment policy (#1206) supplies it.

## The result is content-free and serialisable

`CompletionModelSelection` carries only enum literals plus a configured model id — never buffer text,
prompts, queries, or any customer content — so it is safe to serialise across the host/server
boundary.

| Field           | When present               | Values                                                                     |
| --------------- | -------------------------- | -------------------------------------------------------------------------- |
| `mode`          | always                     | `as-you-type` \| `manual` \| `deterministic`                               |
| `modelId`       | `mode !== "deterministic"` | the elected configured model id                                            |
| `latencyClass`  | a model is chosen          | `fast` \| `standard` \| `slow`                                             |
| `degradeReason` | `mode === "deterministic"` | `no-infilling-model` \| `only-base-infilling-model` \| `over-cost-ceiling` |

Degrade reasons are reported in strict precedence so the cause is the most specific true one:

- `over-cost-ceiling` — an aligned FIM model exists but every candidate exceeds the cost ceiling.
- `only-base-infilling-model` — infilling models exist but only as raw `base` / undeclared alignment
  (rejected by the injection guardrail).
- `no-infilling-model` — no configured model advertises suffix-aware completion.

## Declaring an infilling model

Inline provider capability (lenient; `supportsInfilling` defaults to `false`):

```jsonc
{
  "providers": [
    {
      "modelId": "example-fim-chat",
      "baseUrl": "https://endpoint.example/v1",
      "apiKey": "…",
      "capability": {
        "kind": "chat",
        "supportsInfilling": true,
        "infillingAlignment": "instruct",
        "latencyClass": "fast",
        "costClass": "low",
      },
    },
  ],
}
```

The strict top-level `capabilities` array is the authoritative override surface; it preserves field
absence exactly (an omitted flag reads back as `undefined`, not a coerced `false`).

## Boundaries

- **Server-side only.** The selection and predicates run in the keiko-server tier behind the Model
  Gateway. No browser code gains direct model access (ADR-0042 D5, ADR-0019). The editor package
  registers Monaco providers and renders results; it computes nothing and never calls a model.
- **Out of scope of #1210.** The Monaco completion bridge (#1199) and inline-completion UI, budgets,
  and acceptance telemetry (#1200); the deterministic language service (#1198); training/hosting
  models.
- **Forward-compatible.** Next-edit prediction is a deliberate, deferred non-goal; the optional-field
  contract reserves room for a later `edit-prediction` capability flag without a breaking change.
