# A new model does not call tools

| Field             | Value                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity          | Medium                                                                                                                                                      |
| Surface           | Model gateway / Local UI                                                                                                                                    |
| Stable identifier | `toolCallingOutcome` on `gateway.readiness.completed`; the `reasoning-restore-repair` retry reason on `gateway.retry.scheduled`; Settings > Models evidence |

**Symptom**

A newly added chat or reasoning model answers in words and never uses Keiko's tools in Chat or the
Coding Workbench, or a tool turn ends after the first tool with an HTTP 400 from the provider, or
Settings > Models shows tool calling as not verified or unsupported.

**Root Cause**

Keiko's tool-calling check first offers a tool exactly as production does (the tool offered, no forced
`tool_choice`). Only a model that called no tool is asked a second time with the forced named call.
The check ends in one of six closed outcomes, shown in the evidence line of the tool-calling probe in
Settings > Models and recorded as `toolCallingOutcome` on the readiness completion line:

| Outcome              | What Settings says                                                                       | Verdict                   |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------- |
| `called-unforced`    | The model called the tool on its own, the way Keiko offers tools.                        | Verified                  |
| `called-only-forced` | The model called the tool only when the call was forced; it may not use tools by itself. | Verified, with a warning  |
| `forced-refused`     | The model did not call the tool on its own and the provider refused the forced call.     | Not a verdict: unverified |
| `no-call`            | The model answered without a tool call in both steps.                                    | Not supported             |
| `tools-refused`      | The endpoint refused the request that offers a tool.                                     | Not supported             |
| `inconclusive`       | The gateway timed out, was rate-limited or answered with an error; verify again later.   | No verdict, retried later |

A reasoning model in thinking mode often answers HTTP 400 to a forced `tool_choice`; that never marks
it unable to call tools (`forced-refused`). Some providers also demand the previous assistant
reasoning back on every tool round (`reasoning_content`) and answer the next round with HTTP 400 when
it is missing. Keiko detects that by itself: it answers such a rejection once with the current turn's
reasoning restored (the retry reason `reasoning-restore-repair`), remembers for that deployment that
the model wants its reasoning back, and shows "Returns its reasoning on tool turns: detected" for the
model in Settings > Models. The fact is held in memory only, bound to the configuration generation,
and never persisted; the reasoning text never enters logs, evidence, exports or the repository. An
explicit `reasoningHistory` or `reasoningContinuation` in the provider entry always wins and disables
the detection.

A function whose parameters carry `oneOf`, `anyOf`, `allOf`, `enum`, `const` or `not` at the top level
is refused by OpenAI-family providers with HTTP 400. Keiko projects every tool definition to a plain
object schema on its way to the provider and names the alternatives in the tool description; its own
validation of the call still uses the original schema.

**Diagnostic Steps**

1. In Settings > Models, run the readiness check of the model and read the tool-calling line and its
   evidence. A check of a slow model keeps running until it answers (a model that is slow to load can
   take several minutes); close the panel to cancel it.
2. Export the redacted support evidence and read the outcome without raw logs:

```bash
keiko support export   # prints the path of the private report it writes
keiko support analyze <report.json> --json
```

3. In the analysis, look for `toolCallingOutcome` on `gateway.readiness.completed` (or on
   `gateway.readiness.automatic.completed` for the Workbench's own check) and for
   `gateway.retry.scheduled` lines with `reason: reasoning-restore-repair`.

**Resolution**

- `called-unforced`: nothing to do.
- `called-only-forced`: the model may not use tools in Chat or the Workbench. Try a real tool task; if
  it answers in words, choose a model that calls tools on its own, or turn its thinking mode off.
- `forced-refused`: not a verdict. Pick the model in Chat or the Workbench and try a real tool task. If
  the provider has a thinking mode, check whether turning it off changes the result.
- `no-call` or `tools-refused`: the endpoint or model does not support tool calling. Choose a model or
  deployment that does, or enable the provider's tool-call support (for a vLLM model, its auto tool
  choice and tool parser).
- `inconclusive`: verify again once the gateway is idle; a busy or cold gateway gives no verdict.
- A tool turn that failed with HTTP 400 after the first tool: nothing to configure. Keiko answers the
  rejection once with the reasoning restored; the next rounds of that deployment carry it at once. If
  the 400 persists, read the evidence above and the provider's own error; do not add a blank
  `reasoning_content`.
- An explicit `reasoningHistory` or `reasoningContinuation` setting is only needed for a deployment that
  must not be detected (for the native Coding path, see
  [DeepSeek thinking with tool continuations](./litellm-production-gateway.md)). Preserve the
  redaction and containment boundaries when exporting evidence: it contains counts and closed outcomes
  only.
