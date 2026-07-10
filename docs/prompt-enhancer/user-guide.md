# Prompt Enhancer — User Guide

Epic: [#1307](https://github.com/oscharko-dev/Keiko/issues/1307)

The Prompt Enhancer takes a short, rough prompt and rewrites it into a well-structured instruction set
that produces more reliable answers. It runs locally and deterministically — the same draft always
produces the same enhanced prompt — and it is built to be safe by default: it treats your draft as
data, never grants itself tools or access, and fails closed for safety-critical advice.

This guide explains what the enhancer produces, the profiles it uses, how it handles missing
information and grounding, and its safety model and limitations. For the contracts and internals, see
the [developer guide](./developer-guide.md).

## What you get

For any draft, the enhancer produces a structured **Enhanced Prompt** with these parts:

- **Role and goal** — a precise statement of who the assistant is and what it must achieve.
- **Context** — relevant framing, including any explicit assumptions (clearly labelled `Assumption: …`).
- **Input** — your original draft, kept separate and treated strictly as data, never as instructions.
- **Task decomposition** — an ordered, multi-step plan appropriate to the task.
- **Constraints** — what the answer must and must not do.
- **Grounding rules** — how to use evidence and avoid fabrication (see _Grounding_).
- **Output schema** — the expected output format (prose, markdown, JSON, YAML, CSV, table, list, code).
- **Quality criteria** — what a good answer looks like for this task.
- **Uncertainty handling** — what to do when information is missing or contradictory.
- **Safety rules** — invariants that keep the prompt safe (see _Safety model_).

## Task classes

The enhancer first classifies your draft into one of fifteen task classes — for example factual
question answering, research, retrieval-augmented question answering, summarization, structured
extraction, data analysis, code generation / debugging / architecture, writing and editing, creative
writing, decision support, agentic tool use, prompt optimization, and a dedicated safety-critical class
for consequential advice. The class drives the role, goal, default output format, and the recommended
profile. When no strong signal is present, the enhancer conservatively defaults to factual question
answering.

## Profiles

A **profile** controls how thorough and how lean the enhanced prompt is. The enhancer recommends a
profile from the task analysis; you can request a different one as a hint, except that a high-stakes
(critical) request is always escalated to the safety-critical profile and cannot be downgraded by a
hint.

| Profile           | Best for                                    | Style                                          |
| ----------------- | ------------------------------------------- | ---------------------------------------------- |
| `fast`            | Quick edits, short replies                  | Lean, minimal decomposition                    |
| `creative`        | Creative writing                            | Exploratory, fewer hard constraints            |
| `technical`       | Code, extraction, structured output         | Structured engineering, tighter output control |
| `precise`         | Factual Q&A, decision support               | Decomposed, balanced thoroughness              |
| `agentic`         | Tool-using / multi-step tasks               | Plan-act-checkpoint, human-approval gating     |
| `safety-critical` | Legal / medical / finance / security advice | Cautious verification, mandatory grounding     |
| `research`        | Deep research, literature review            | Exhaustive, mandatory grounding                |

Leaner profiles produce shorter prompts (higher token efficiency); thorough profiles produce richer
prompts (higher completeness). This is a deliberate trade-off, surfaced in the quality scorecard.

## Assumptions and clarifications

When your draft is missing information, the enhancer does one of two things depending on the chosen
strategy:

- **Clarify** (default) — it surfaces specific clarifying questions for you to answer before the task
  is finalized.
- **Assume** — it proceeds using explicit, clearly-labelled assumptions and keeps them visible in the
  prompt so the answer can be checked against them.

Either way, missing information is made visible rather than silently guessed.

## Grounding

The enhancer plans (but does not itself perform) how an answer should be grounded in evidence. Each
enhanced prompt carries a grounding plan with one of these strategies:

- **No grounding** — answer from stable, well-established knowledge; do not fabricate specific facts or
  sources.
- **Supplied-context only** — answer strictly from the context or files you connected.
- **Local knowledge / repository context** — consult your indexed knowledge or repository.
- **Hybrid** — combine connected context, local knowledge, and stable knowledge, keeping them separate.
- **External research required** — the answer needs current external information.

Whenever grounding is required, the prompt instructs the assistant to attribute claims to sources, stay
within (or clearly separate) the evidence, disclose uncertainty, and decline to answer when evidence is
insufficient, out of scope, or contradictory — rather than inventing facts. Retrieved or connected
content is always treated as untrusted data, never as instructions.

## Safety model

The enhancer is safe by construction:

- **Your draft is data, not instructions.** It is isolated in the `input` section. Instructions hidden
  in your draft (for example, "ignore previous instructions") do not change the assistant's behaviour;
  they are flagged for review.
- **No self-granted authority.** The enhanced prompt never grants tool execution, file writes, network
  egress, or secret access. Least privilege is the default.
- **Human review for risky requests.** Agentic tasks and requests for tool/egress authority require
  human review before a runtime mode and Authority Envelope establish bounded authority. During the
  run, additional prompts follow the shared resource/risk policy rather than a blanket review rule.
  High-stakes consequential advice is returned as a rejected fail-safe result rather than a
  ready-to-use prompt.
- **No secret disclosure.** The prompt forbids revealing secrets, credentials, or system instructions,
  and the evidence record stores only a stable redacted fingerprint plus a redacted, truncated excerpt
  of your draft — never an unredacted draft or known secret.
- **Injection detection.** Drafts containing prompt-injection, secret-exfiltration, or
  authority-escalation attempts are detected and surfaced for review or rejection.

### Known safety limitation

A request that seeks **consequential advice in a safety-critical domain** (legal, medical, finance,
security) is currently returned with `safety.decision: rejected` as a fail-safe outcome. The surface can
show the generated review artefact and safety findings, but the result is not an approved prompt to run.
This is intentionally conservative. The intended longer-term behaviour is to route these to
`requires-human-review` (with a professional-advice disclaimer) rather than reject outright; this
refinement is tracked as a follow-up and recorded in the
[closure evidence](./1315-closure-evidence.md). Until then, treat safety-critical advice prompts as
requiring human handling.

## What it does not do

- It does not call a model to rewrite your prompt — the MVP transformation is fully deterministic.
- It does not retrieve documents itself — it plans grounding; retrieval happens elsewhere at run time.
- It does not guarantee a better answer in every domain, and it is not a substitute for professional
  legal, medical, financial, or security advice.

## Quality and reproducibility

Prompt quality is measured offline across eight dimensions — clarity, completeness, groundedness,
faithfulness, format adherence, safety, task success, and token efficiency — by a deterministic
evaluation suite that runs in continuous integration. Because every stage is deterministic, the same
draft always produces the same enhanced prompt and the same scores.
