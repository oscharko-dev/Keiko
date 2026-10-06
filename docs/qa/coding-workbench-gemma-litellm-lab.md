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

| Run               | Task | Mode                               | Head        | Outcome                                                                                                        | Evidence                                                                                                                                      |
| ----------------- | ---- | ---------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-1485…124789` | T1   | Ask for approval                   | `b6bbe5a95` | Succeeded in 3 min; all planted defects plus two genuine extra defects found; no edits                         | 9 model turns, one tool call each (`finishReason=tool_calls`), `gateway.prompt.admission` with `counterStatus=available`                      |
| `run-1161…695883` | T2   | Supervised workspace (API-started) | `b6bbe5a95` | Cancelled after 12 min: every edit refused with `NO_ACTIVE_SESSION`; the model repeated the same edit 11 times | `coding-runtime.editor-review.decided disposition=allowed` followed by `coding-runtime.edit.refused reasonCode=NO_ACTIVE_SESSION` per attempt |

## Findings

Findings are recorded when a run exposes them and link to the child issue that owns the fix.

| Id  | Finding                                                                                                                                                                                                                                                                                 | Owner |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| F1  | The Workbench reports a repository below a denied read-surface path (for example `.claude/`) as "may not be a Git repository" although the Git window names the actual `DENIED` cause.                                                                                                  | #3873 |
| F2  | Answers are buffered end to end: the sidecar model profile does not stream, so a slow self-hosted model shows only "Working" until the whole answer exists.                                                                                                                             | #3873 |
| F3  | Model answers that use LaTeX notation (`$\rightarrow$`) are rendered verbatim in the Workbench timeline.                                                                                                                                                                                | #3874 |
| F4  | Workbench edits are applied through the live Workbench editor bridge in the browser. A run whose workspace has no connected Workbench (for example a run started over the API, or a closed Workbench window) refuses every edit with `NO_ACTIVE_SESSION` after an 11.75 s bounded wait. | #3873 |
| F5  | Repeated identical refusals are not escalated: the model re-issued the same refused edit 11 times (`coding-runtime.safe-activity reason=late-restatement`) until the operator stopped the run, instead of the run settling with a visible cause.                                        | #3873 |
