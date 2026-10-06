# Coding Workbench live qualification: Gemma behind LiteLLM

Epic #3871 qualifies the Coding Workbench against the customer deployment shape with a live model.
It complements the hermetic release gate in
[`customer-shape-coding-workbench.md`](customer-shape-coding-workbench.md), which uses a scripted
LiteLLM/vLLM twin and never calls a model. This lab answers the question that gate cannot: does a
real open-weight model complete real coding tasks through the Workbench?

## Deployment shape

| Layer         | Lab                                                                          | Customer                          |
| ------------- | ---------------------------------------------------------------------------- | --------------------------------- |
| Gateway       | LiteLLM v1.104.0 (latest stable), loopback, `authorization` key header       | LiteLLM latest, one URL + one key |
| Model route   | `gemma-4-31b-it` via LiteLLM `hosted_vllm` (OpenAI-compatible model server)  | Self-hosted Gemma behind LiteLLM  |
| Model         | Gemma 4 31B instruct, 131,072-token served window, 16,384 output tokens      | Gemma (same family)               |
| Keiko binding | Gateway Setup discovery through `/model/info`, LiteLLM token counter enabled | Same                              |

Discovery declares the served window through LiteLLM `model_info` (`context_window`,
`max_output_tokens`, `supports_function_calling`). A customer route without those declarations
is a separate case: Keiko then starts from the setup placeholder until its long-context probe
proves a larger window (see
[`litellm-production-gateway.md`](../troubleshooting/litellm-production-gateway.md)).

## Lab repository

A dependency-free TypeScript library and CLI (`ledger-lab`) run directly by Node.js 24 type
stripping, with `node --test` tests, project rules in `AGENTS.md`, and a local bare remote for
delivery. It carries deliberate defects:

- `Ledger.monthlyTotals()` keys months with the zero-based `Date#getMonth()` and no padding
  (`2026-0` instead of `2026-01`) and does not return them in chronological order.
- `parseCsv()` splits on every comma, so the quoted field `"Books, magazines"` in
  `data/sample.csv` breaks the CLI.
- `parseAmount()` rejects thousands separators such as `1,234.56`.

## Task suite

| Id  | Task                                                                   | Mode(s)              | Expected outcome                                        |
| --- | ---------------------------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| T1  | Explain the architecture and list defects without editing              | Ask for approval     | Accurate read-only answer; no edit or command requested |
| T2  | Fix month bucketing and ordering, with a regression test               | Supervised workspace | Fix + test; `npm test` passes                           |
| T3  | Support quoted CSV fields (RFC 4180 quotes and escaped quotes) + tests | Supervised workspace | CLI summarizes `data/sample.csv`; tests pass            |
| T4  | Accept thousands separators in `parseAmount` and document the format   | Ask for approval     | Edits wait for approval; approved edits land            |
| T5  | Add a `--month YYYY-MM` filter to the CLI summary, README and tests    | Full access          | Multi-file change, verification run, no approvals       |
| T6  | Commit the work on a feature branch and push it to `origin`            | Full access          | Governed delivery to the local remote                   |

## Results

Results are recorded per run with the run correlation id and the Activity Log operations that
reconstruct it. Bodies (prompts, code, model output) are never recorded here.

| Run | Task | Mode | Head | Outcome | Evidence |
| --- | ---- | ---- | ---- | ------- | -------- |
