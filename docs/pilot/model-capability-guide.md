# Model capability guide

Audience: pilot evaluators and operators who configure the Keiko gateway and decide which model handles which workflow.

This guide maps the customer's nine-model pilot portfolio to recommended Wave 1 roles. It states each model's declared capabilities and known limitations so you can route work deliberately.

---

## How to read the numbers

The qualitative and numeric figures below — cost class, latency class, and context window — are **documented assumptions** sourced from public model cards as of 2026-05-28. They live in the static capability registry as starting defaults, and several carry an explicit `[assumption]` marker in the source.

Gateway config may also declare provider-local `capability` metadata for private or customer-hosted model ids that are absent from the static registry. Treat both registry values and customer-declared values as routing metadata to validate against the target endpoint, not measured guarantees.

For how credentials resolve and how the gateway config is structured, see [Configuration and secrets](../../README.md#configuration-and-secrets).

---

## What to route to Wave 1 workflows

The two Wave 1 chat workflows — [unit-test generation](../adr/README.md#adr-0008) and [bug investigation](../adr/README.md#adr-0009) — produce structured diffs. Route those workflows to models that declare:

- `toolCalling` — the workflow drives the model through tool steps.
- `structuredOutput` — the workflow expects a reliably structured patch.

If a workflow command is run without `--model`, Keiko selects from configured chat providers that declare both `toolCalling` and `structuredOutput`, preferring the lowest cost class. A model with `structuredOutput: false` can still serve explicit chat or operator-selected runs, but it is not selected as the default for structured-diff workflows. Two portfolio entries are not chat models at all: their methods are Wave 2 and they are not callable by Wave 1 workflows.

---

## Portfolio at a glance

Context windows are the registry's documented-assumption values (tokens). `n/a` marks an entry whose registry context window is not a token budget.

| Model id                              | Kind       | Cost   | Latency  | Tool | Structured | Context | Recommended Wave 1 role                       |
| ------------------------------------- | ---------- | ------ | -------- | ---- | ---------- | ------- | --------------------------------------------- |
| `Qwen3-Coder-480B-A35B-Instruct-FP8`  | chat       | high   | slow     | yes  | yes        | 128,000 | Deep / large-codebase work                    |
| `Qwen/Qwen3-Coder-Next-FP8`           | chat       | high   | slow     | yes  | yes        | 128,000 | Deep / large-codebase work (upgrade path)     |
| `Devstral-2-123B-Instruct-2512`       | chat       | high   | standard | yes  | yes        | 128,000 | Agentic multi-step SWE                        |
| `gpt-oss-120b`                        | chat       | high   | standard | yes  | yes        | 128,000 | General coding, review, explanation           |
| `Mistral-Small-3.1-24B-Instruct-2503` | chat       | medium | fast     | yes  | yes        | 128,000 | Interactive / low-latency assist              |
| `Qwen2.5-Coder-7B-Instruct`           | chat       | low    | fast     | yes  | **no**     | 128,000 | Inline completion only — not structured diffs |
| `gemma-4-31b-it`                      | chat       | medium | standard | yes  | yes        | 128,000 | Summarisation, explanation, Q&A               |
| `dotsocr`                             | ocr-vision | medium | standard | no   | no         | n/a     | Wave 2 (OCR) — not callable in Wave 1         |
| `multilingual-e5-large Embedding`     | embedding  | low    | fast     | no   | no         | 512     | Wave 2 (embedding) — not callable in Wave 1   |

---

## Recommended roles for the Wave 1 workflows

### Deep or large-codebase work

`Qwen3-Coder-480B-A35B-Instruct-FP8`, `Qwen/Qwen3-Coder-Next-FP8`, `Devstral-2-123B-Instruct-2512`, `gpt-oss-120b`.

These carry a high cost class and slow or standard latency. Use them for large-codebase refactors, cross-file analysis, and multi-step investigation where reasoning depth matters more than turnaround.

### Interactive, low-latency assist

`Mistral-Small-3.1-24B-Instruct-2503`.

Medium cost, fast latency, full tool and structured-output support. A default choice for quick edits and low-latency agent steps. Being smaller, it may need more turns on complex reasoning.

### Summarisation, explanation, regulated-context Q&A

`gemma-4-31b-it`.

Medium cost, standard latency. Suited to documentation summarisation, code explanation, and regulated-context question answering. Verify function-calling against your endpoint before relying on it for tool-driven workflows.

### Not suited to the structured-diff workflows

`Qwen2.5-Coder-7B-Instruct` declares `structuredOutput: false`. It is low cost and fast and works well for inline completion, snippets, and high-throughput batch use. It is **not** a reliable choice for unit-test generation or bug investigation, which depend on a structured patch. It is not selected by the default workflow selector unless an operator passes it explicitly with `--model`.

---

## Per-model notes

Each note records the model's intended use and its known limitation, as declared in the capability registry. All numeric figures are documented assumptions from the static capability registry; validate them against your endpoints. For private hosted ids, declare local provider `capability` metadata in the gateway config rather than adding customer-specific ids to the public registry.

Note: `multilingual-e5-large Embedding` is the exact identifier in the capability registry, including the trailing word and the space. As a Wave 2 embedding model it is not referenced by Wave 1 chat workflows or their gateway configuration.

### `Qwen3-Coder-480B-A35B-Instruct-FP8`

- Chat · cost high · latency slow · tool + structured.
- Use: large-codebase refactor and cross-file analysis.
- Limit: very high VRAM; slow for interactive use.

### `Qwen/Qwen3-Coder-Next-FP8`

- Chat · cost high · latency slow · tool + structured.
- Use: deep code synthesis and maximum reasoning depth.
- Limit: same VRAM and latency profile as the 480B model; treat as a next-generation upgrade path.

### `Devstral-2-123B-Instruct-2512`

- Chat · cost high · latency standard · tool + structured.
- Use: agentic code completion and multi-step software engineering.
- Limit: 123B scale; needs a dedicated GPU; not for high-QPS workloads.

### `gpt-oss-120b`

- Chat · cost high · latency standard · tool + structured.
- Use: general coding, code review, and explanation.
- Limit: customer-hosted open-source weights; endpoint reliability depends on customer infrastructure.

### `Mistral-Small-3.1-24B-Instruct-2503`

- Chat · cost medium · latency fast · tool + structured.
- Use: interactive code assist, quick edits, low-latency agent steps.
- Limit: smaller model; may need multi-turn interaction for complex reasoning.

### `Qwen2.5-Coder-7B-Instruct`

- Chat · cost low · latency fast · tool calling yes · **structured output no**.
- Use: inline completion, snippets, high-throughput batch.
- Limit: limited structured-output reliability; context degradation beyond 64K tokens observed in benchmarks `[assumption]`. Not recommended for the structured-diff Wave 1 workflows.

### `gemma-4-31b-it`

- Chat · cost medium · latency standard · tool + structured.
- Use: documentation summarisation, code explanation, regulated-context Q&A.
- Limit: instruction-tuned variant; verify function-calling reliability against the customer endpoint before tool-driven use.

### `dotsocr`

- OCR-vision · cost medium · latency standard.
- Use: document OCR; scanned contract and form extraction.
- Limit: not a chat model; the chat-completions adapter does not apply. Its `callOcr` method is **Wave 2** and is not callable by Wave 1 workflows.

### `multilingual-e5-large Embedding`

- Embedding · cost low · latency fast.
- Use: semantic search, RAG retrieval, similarity ranking.
- Limit: maximum 512 tokens per input. Its `callEmbedding` method is **Wave 2** and is not callable by Wave 1 workflows.

---

## Related documents

- [Configuration and secrets](../../README.md#configuration-and-secrets) — gateway config and credential precedence
- [Go/No-Go criteria](./go-no-go.md) — the pilot decision, including model fit
- [Gateway model boundary (ADR-0003)](../adr/README.md#adr-0003)
- [Unit-test generation workflow (ADR-0008)](../adr/README.md#adr-0008)
- [Bug investigation workflow (ADR-0009)](../adr/README.md#adr-0009)
