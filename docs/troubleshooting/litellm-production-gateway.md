# LiteLLM Production Gateway

Production deployments front every model call through a LiteLLM proxy; direct Azure endpoints
are a development-only shape. The entries below cover the failure modes specific to that
combination. Setup, discovery, chat, embeddings, buffered speech (STT/TTS), and rerank all speak
LiteLLM's OpenAI-compatible surface; the entries assume that baseline works.

Realtime voice is not a failure mode here by design: Keiko offers realtime voice only when a
provider advertises a complete realtime capability, and a LiteLLM proxy does not serve the
OpenAI WebRTC negotiation surface (`/realtime/calls`), so the feature is simply not offered
against a LiteLLM-only configuration. Buffered dictation and read-aloud remain available.

---

## Context limits and token admission

Configure each LiteLLM route's actual deployed input/output limits in `model_info`. Discovery uses
the smallest positive whole-window declaration from `max_model_len`, `context_length` and
`context_window`, in the entry itself or its `model_info`, `litellm_params` or `capabilities` record.
`max_input_tokens` is a separate prompt-input ceiling; it supplies the legacy window fallback only
when no whole-window declaration exists. Keiko intersects
the limits of every backend sharing an alias; missing bounds use conservative defaults, and
conflicting task kinds are rejected. If every replica omits context/reasoning metadata, same-endpoint
rediscovery retains previously verified capability evidence. An explicitly empty reasoning list
clears stored reasoning choices; it is not treated as missing metadata. A mixture of declared and undeclared
context bounds remains conservative. One final event per selected alias records `deploymentCount`,
`modelIdDigest`, effective bounds, and persistent unknown-bound provenance. A catalog model name alone does not prove that the deployment
is callable or that a larger context window is available.

Usable input is the smaller of the declared input ceiling and the whole window minus response and
safety reserves. For example, `context_window: 128000` with `max_input_tokens: 32000` describes a
128,000-token window with at most 32,000 prompt tokens. The context meter retains the whole-window
label and shows the remaining input-ineligible share as unavailable for input. Raising an input
ceiling never enlarges an independently declared window.

Keiko reserves a bounded answer budget rather than the model's full output ceiling. Before a chat
request, the gateway checks the complete prompt, tool context, and response schema against the
remaining input budget on every attempt, including schema-correction retries. Without an explicit
caller allocation or spend guard, the output field stays absent and the provider's default remains
in effect. Images use a separate fallback allowance, never their base64 text length: one quarter
of the declared context window per image, capped at 8,192 tokens. A positive provider count replaces
the image allowance while the local text/tool/schema floor still applies. Zero counts retain the
fallback. These estimates do not prove a model's image-token cost; a larger provider count can
still refuse admission.
Discovery through `/model/info` enables `"tokenCounter": "litellm"` for
those providers. The count request goes to `/utils/token_counter` on the configured proxy (including
any reverse-proxy prefix), uses the same authorization and egress policy, and has a five-second
limit inside the attempt's time budget; an open circuit makes no counting request. A proxy key may be permitted to generate but forbidden to count; Keiko then uses its local
estimate and waits 60 seconds before probing that unavailable counter again. Response-schema cost
is added to the reported message/tool count before admission. Counter failures, malformed responses,
and admission refusals carry correlated closed error kinds and body-free stack/cause evidence.
This counter is an additional estimate, not a guarantee of the backend tokenizer.

Desktop chat reserves complete message framing and image capacity before choosing or compacting
history. Prompt assembly, compaction savings, and gateway local admission use the same accountant;
long conversations therefore do not fill a text-only budget that fails at the next gateway check.
Image bytes remain subject to the existing final authority check. A higher proxy-reported count can
still reject a locally fitting prompt; compare the local and reported counts when diagnosing that
case, rather than increasing the deployed window without evidence.

Gateway admission additionally records `imageCount`, the selected `imageAccounting` rule,
`imageReserveTokens`, `localPromptTokens`, `fallbackPromptTokens`, and, when present,
`reportedPromptTokens` plus schema-adjusted `providerPromptTokens`. A positive reported count
replaces the image reserve even when the local text/tool/schema floor determines the final total;
a zero count retains the reserve. The recorded candidates make those decisions distinguishable.

On retries, `reportedPromptTokens` always describes only the current counter response and is
absent when that response has no count. `providerPromptTokens` adds the current response-schema
cost to that raw count; `retainedPromptTokens` separately records the carried measurement floor
plus schema cost. Admission preserves the maximum of local, current-provider and retained
candidates. `counterSource` identifies a winning retained floor as `retained-measurement`, and
`imageAccounting` uses that disposition when only the retained positive measurement replaces the
image reserve. Neither retained value is presented as a new provider observation.

Inspect `gateway.prompt.admission` in the activity log for `counterStatus`, `counterSource`,
`tokenizer`, `promptTokens`, `inputBudget`, and `outputBudget`. No prompt or counter response body is
logged. For a counter that stays unavailable, inspect `gateway.prompt.counter-cooldown`: its
`state` distinguishes a new 60-second cooldown, suppression on the current call, and expiry;
`modelIdDigest` joins the affected model and `remainingMs` states when the next probe is allowed.
For a pre-generation timeout or cancellation, `gateway.prompt.admission-failed` records `phase`
(counter or validation), `budgetMs`, `elapsedMs`, and structured stack/cause evidence.
A local overflow ends before generation. If counting is unavailable, check the key's route
permissions and the proxy version; do not grant broader model access solely to enable counting.

The [LiteLLM Docker guide](https://docs.litellm.ai/docs/proxy/docker_quick_start) describes the
OpenAI-compatible generation endpoint and Bearer authentication. Azure development routes retain
either the configured deployment endpoint/API version or the
[Azure v1 endpoint](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle).
They use local token admission without calling the LiteLLM counter. An alias for a reasoning model
may still need the explicit output-token parameter described below.

---

## Coding Workbench turn has no assistant reply

For a Workbench run that accepted a message but has no assistant reply, note the run id and export a
body-free report with `keiko support export --correlation-id <runId>`. Analyze the report with
`keiko support analyze <report.json> --correlation-id <runId>`. The run timeline includes
`coding-sidecar.gateway.request-validated`, any closed `coding-sidecar.gateway.rejected` reason,
the provider dispatch, and a redacted diagnostic for a failed model call. The analyzer follows the
request's explicit parent link and includes its entire request timeline; the request ID still
selects that timeline directly. A gateway HTTP 400 or 422 after a
request carrying optional `stream_options` may indicate a strict OpenAI-compatible proxy; Keiko
retries once without that optional field and records `chat.request.compatibility-retry` when it
does. The Workbench displays a closed failure cause and next step if the turn still fails. Do not
send the raw provider response or model prompt to support.
A local control with LiteLLM 1.102.1 showed that it can add `stream_options` to its own
`hosted_vllm` upstream request even when Keiko omits it. When the second rejection again names
that field, Keiko sends one bounded `stream: false` request and records a second
`chat.request.compatibility-retry` with `omittedField: stream`. The turn then answers as one
buffered reply within the remaining request budget instead of streaming as it is generated, and
later requests with the same provider credentials to that endpoint use the buffered shape for 15
minutes. To restore streaming, fix the LiteLLM-to-vLLM configuration; Keiko cannot remove a field
that the proxy inserts after receiving the request. If the buffered request also fails, the turn
reports the provider failure with its closed cause.
If a proxy closes an SSE response after partial text without a recognized finish reason or
`data: [DONE]`, the turn reports `stream-incomplete` rather than accepting the partial reply.
Check the correlated `chat.response.streamed` and `coding-sidecar.gateway.turn-failed` lines for
the failed read and run event; they contain counts and closed reasons, not model text.
A provider that rejects the turn itself — HTTP 400 or another 4xx other than 408, 409 and 429, or
a refused credential — ends the turn once with `provider-failed` and `runtimeRetry: refused`; the
coding agent does not retry it (before 1.1.10 it retried the same rejected turn every few seconds
until the run was stopped). Fix the route or credential the rejection names in the gateway's own
log, then send the task again.

---

## Coding Workbench turn reasons until its output budget is exhausted

| Field             | Value                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Severity          | High                                                                                        |
| Surface           | Coding Workbench                                                                            |
| Stable identifier | `coding-sidecar.gateway.turn-failed failureCode=output-exhausted` under the run correlation |

**Symptom**

A run with a reasoning model (Gemma 4 31B with reasoning enabled behind LiteLLM in the live
qualification) reads a few files, then a turn shows "Working" for minutes and ends without a tool
call or an answer; the next turn does the same. Each attempt lasts about as long as the model needs
to emit its whole output allowance (seven minutes for 8k tokens at 20 tokens per second), and the
run burns its envelope duration without progress.

**Root Cause**

The model spent its whole output budget on reasoning before producing a tool call or a final
answer: the provider answered HTTP 200 with `finish_reason: "length"` and no content
(`chat.response.streamed outcome=failed outputExhausted=true`, `gateway.chat.failed` or
`gateway.stream.failed` with `outputExhausted=true`). Before #3873 (F17) the turn failed at once and
the coding runtime retried the identical turn, which ran away identically.

The gateway now steers one repaired attempt before the exhaustion surfaces: the same request plus a
fixed system message that tells the model its previous answer used the whole budget and asks for the
tool call or the final answer directly, with reasoning kept to a few sentences. The repair is
granted once per call, counts against neither the provider's attempt count nor the coding outage
window, and never against the circuit breaker. If the repaired attempt exhausts the budget again,
the turn is final for the runtime (`runtimeRetry: refused`), so the run settles with an honest cause
instead of looping. With the reasoning display on (the default), the first attempt's reasoning has
already reached the Workbench when the repair runs: the timeline then shows a second reasoning
passage, followed by the tool call or the answer. The forwarded reasoning of a turn is bounded by
two output allowances in bytes — one per model attempt — so the second passage is not cut as
`output-limit`; a turn that exhausted the budget twice shows both passages, then the final cause.

The output allowance a coding turn sends (`maxOutputTokens` on `coding-sidecar.gateway.request-validated`)
is the provider-declared output limit where the model declares one, otherwise 16k (before this change
the shared chat profile's 8k of a 128k window), both bounded to a quarter of the model's window and
shrunk per request to what the prompt leaves free (`admittedOutputTokens`, `coding-sidecar-gateway.ts`;
`codingOutputReserveTokens`, `model-selection.ts` in keiko-model-gateway).

**Diagnostic Steps**

`keiko support analyze <report.json> --correlation-id <runId>` shows, per exhausted turn, the first
read ending with `outputExhausted=true`, one `gateway.retry.scheduled reason=output-exhausted-repair
delayMs=0`, the repaired attempt's own read, and the turn's settlement: a recovered turn records
`coding-sidecar.gateway.outcome outcome=accepted repairAttempted=true repairOutcome=recovered`; a turn
that exhausted the budget again records `coding-sidecar.gateway.turn-failed
failureCode=output-exhausted runtimeRetry=refused repairAttempted=true repairOutcome=exhausted-again`
and the matching `outcome=failed` line. `repairAttempted=false` on an `output-exhausted` failure means
the call's budget could not hold a repair. None of these lines carries the model's reasoning.

**Resolution**

- A recovered turn needs nothing; the repair line is the evidence of what the model was told.
- A turn that exhausted the budget twice points at a model that reasons past any allowance on this
  task: lower the reasoning effort for the run, or pick a model that declares a larger output limit
  (the allowance follows the declared limit up to a quarter of the window).
- Where the provider declares no output limit and the model needs more than 16k, add the limit to the
  LiteLLM model info (`max_output_tokens`) so discovery carries it; the coding turn then reserves it.
- Check the time arithmetic before raising allowances further: a whole-body (non-streaming) attempt is
  bounded by the ten-minute buffered floor, so at 20 tokens per second about 12k tokens fit one
  attempt; a streamed read is bounded by the call budget instead. The reserve follows the transport,
  not the sidecar's own streaming switch. Only a model whose capability does not stream
  (`streaming: false`) meets the whole-body bound and keeps the shared 8k reserve rather than the
  16k coding reserve: a runaway answer then ends as an exhausted answer that gets the steered repair,
  not as a timeout the breaker counts. `codingStreaming: "off"` on a streaming-capable model only
  stops forwarding the answer live: Keiko still reads the provider's stream under the silence floor,
  so that turn keeps the 16k coding reserve. Declare `max_output_tokens` only as high as one
  buffered attempt of a non-streaming model can produce.

---

## Coding Workbench turn ends after reasoning without a tool call or text, again and again

| Field             | Value                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------- |
| Severity          | High                                                                                    |
| Surface           | Coding Workbench                                                                        |
| Stable identifier | `coding-sidecar.gateway.turn-failed failureCode=empty-answer` under the run correlation |

**Symptom**

A run with a reasoning model (Gemma 4 31B behind LiteLLM with streaming on in the live
qualification) streams its first turns correctly, then a turn shows its reasoning, ends, and the
timeline reports "The model finished this turn without any text or tool call". The same message
repeats for turn after turn, each attempt as long as the model needs to reason, until the run is
stopped; the prompt grows with every attempt.

**Root Cause**

Two defects made one empty answer a loop (#3873, F23). The model reasoned (about 4,500 tokens in the
live run), then generated a tool call that the upstream never delivered: the provider answered HTTP
200 with only a finish reason and usage, so the answer carried reasoning but no text and no tool
call (`chat.response.streamed outcome=failed outputExhausted=false` after thousands of
`reasoningEvents`, then `coding-sidecar.gateway.turn-failed failureCode=empty-answer`). Before the
fix that answer got no repair, so the turn stayed `runtimeRetry: allowed` and the coding runtime
retried the identical turn without end. And the failed turn's forwarded reasoning stayed in the
runtime's history, which resent it with every later request: the prompt estimate on
`coding-sidecar.gateway.request-validated` grew by about 6,200 tokens and two messages per attempt.

The gateway now gives an empty answer that carried reasoning the same one steered repair an
exhausted budget gets: the original request plus one fixed system message that tells the model its
previous answer ended after reasoning without a tool call or a final answer and asks it to call the
next tool or answer, keeping any reasoning to a few sentences. The repair is granted once per call,
counts against neither the provider's attempt count nor the coding outage window, and never against
the circuit breaker. If the repaired attempt ends empty again, the turn is final for the runtime
(`runtimeRetry: refused`), so the run settles with an honest cause instead of looping. With the
reasoning display on (the default) the first attempt's reasoning has already reached the Workbench
when the repair runs, so the timeline shows a second reasoning passage. An empty answer that carried
no reasoning at all is not repaired and stays the retryable failure it was. The coding sidecar also
never resends prior reasoning upstream: the reasoning fields of prior assistant messages and every
assistant message that carries nothing but reasoning are dropped before the gateway request is
built.

**Diagnostic Steps**

`keiko support analyze <report.json> --correlation-id <runId>`, then per empty turn:

- `chat.response.streamed outcome=failed` with `reasoningEvents` above 0 and `outputExhausted=false`:
  the read ended after reasoning without content (a finish reason other than `length`).
- One `gateway.retry.scheduled reason=empty-answer-repair delayMs=0`, then the repaired attempt's own
  read. A recovered turn records `coding-sidecar.gateway.outcome outcome=accepted repairAttempted=true
repairOutcome=recovered`; a turn whose repair ended empty again records
  `coding-sidecar.gateway.turn-failed failureCode=empty-answer runtimeRetry=refused repairAttempted=true
repairOutcome=empty-again` and the matching `outcome=failed` line. `repairAttempted=false` with
  `runtimeRetry=allowed` means the answer carried no reasoning, or the call's budget could not hold a
  repair.
- `coding-sidecar.gateway.request-validated` `droppedReasoningMessageCount` above 0 is the number of
  prior assistant messages that carried only reasoning and were not resent; its
  `estimatedPromptTokens` and `inputMessageCount` describe what is sent. None of these lines carries
  the model's reasoning or text.

**Resolution**

- A recovered turn needs nothing; the repair line is the evidence of what the model was told.
- A turn whose repair ended empty again points at a model or route that loses its tool call on this
  task: check the model server and the LiteLLM route for a tool-call parser that drops or truncates
  large calls (a direct probe with the same request shows whether the call arrives as one
  `delta.tool_calls` event), lower the reasoning effort for the run if the model offers it, or pick
  another model, then send the task again.
- Do not widen the output allowance for this symptom: `outputExhausted=false` says the model stopped
  by itself, not that it ran out of budget (compare "Coding Workbench turn reasons until its output
  budget is exhausted" above).

---

## Coding Workbench refuses to start a run with the selected model

| Field             | Value                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| Severity          | Medium                                                                      |
| Surface           | Coding Workbench                                                            |
| Stable identifier | `CODING_RUNTIME_MODEL_UNAVAILABLE` with `model-context-window-insufficient` |

**Symptom**

A Workbench run with a model chosen in the model picker is refused at once. The Workbench says the
selected model's context window is too small for a coding run, or that Keiko is still verifying it.

**Root Cause**

A coding run needs at least 32,000 admissible prompt tokens after the response and safety reserves
and any separate `max_input_tokens` ceiling. Exactly 32,000 admissible prompt tokens qualifies;
a whole-window declaration of 32,000 does not by itself prove that usable capacity. A LiteLLM route
that declares no token limits leaves the 4,096-token setup placeholder until Keiko's automatic long-context probe proves a larger window.
Before 1.1.8 such a model was admitted; the gateway then refused the run's first request, and the
run failed after the two-minute start timeout without a reason.

**Diagnostic Steps**

Export a report with `keiko support export --correlation-id <runId>` and analyze the run with
`keiko support analyze <report.json> --correlation-id <runId>`. The `coding-runtime.start`
diagnostic reads
`stage=start:reason=launch-resolution:model-unavailable:model-context-window-insufficient`, or
`...:model-verification-pending` while the probe runs. `gateway.readiness.automatic.completed`
shows whether the long-context probe ran and which window it verified.

**Resolution**

While the probe runs, wait and start again. Coding requires at least 32,000 admissible prompt tokens
after response and safety reserves and any independent input ceiling. If the deployed model cannot
provide that capacity, choose a larger model. If discovery metadata is incorrect, declare both the
actual whole window and any separate `max_input_tokens` ceiling in the LiteLLM configuration, then
refresh discovery. Do not increase either value beyond the deployment's real limits.

---

## Coding Workbench finds no coding model after a restart the day after setup

| Field             | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Severity          | High                                                                   |
| Surface           | Coding Workbench                                                       |
| Stable identifier | `coding-sidecar.gateway.readiness-insufficient` with `no-tool-calling` |

**Symptom**

Keiko was restarted more than a day after the gateway setup. The Coding Workbench then says the
automatic tool-calling check did not confirm a compatible coding model, and Settings → Models shows
the chat models as not verified, with tools "no". A check started from Settings makes the Workbench
usable again.

**Root Cause**

Keiko's forced tool-call proof expires after 24 hours, and Keiko loads an expired proof as
`toolCalling: false`. Before 1.1.9 the Workbench read that as a model without tool calling, so its
profile read renewed nothing and the Workbench stayed blocked. Only a process that kept running
past the 24 hours renewed the proof by itself.

**Diagnostic Steps**

In the activity log, the Workbench profile read logs `coding-sidecar.gateway.readiness-insufficient`
with `reason: "no-tool-calling"` and `probeMode: "passive"`, and no
`gateway.readiness.automatic.started` line precedes it. The model's last
`gateway.tool-calling.verification` line reads `verified` and is more than 24 hours old.

**Resolution**

Update to 1.1.9 or later: opening the Workbench renews the expired proof itself, and
`gateway.readiness.automatic.started` / `.completed` record the renewal. On an earlier version, run
the model's check in Settings → Models once.

---

## Authenticate x-litellm-key against a proxy that ignores it

| Field             | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| Severity          | High                                                           |
| Surface           | Model gateway                                                  |
| Stable identifier | `AUTHENTICATION` provider error / HTTP 401 on every model call |

**Symptom**

Every chat, embedding, and voice call fails with an authentication error although the key is
correct, and the same key works when `authorization` is selected as the API key header.

**Root Cause**

Keiko sends the `x-litellm-key` header with a `Bearer` prefix, which matches LiteLLM's custom
header contract — but LiteLLM only reads that header when the proxy is configured with
`general_settings.litellm_key_header_name: "x-litellm-key"`. An unconfigured proxy ignores the
header entirely, and Keiko deliberately sends no `authorization` fallback alongside a selected
custom header (one credential, one header — the gateway never broadcasts a key across headers).

**Diagnostic Steps**

The checks report ONLY the HTTP status: response bodies can carry provider details and model
aliases, and the key itself must never appear in a command line (shell history and process
lists record arguments). `read -rs` keeps the key off the screen, and `mktemp` creates each header file exclusively
under an unpredictable name, so no pre-created symlink at a guessable path can capture it:

```bash
# One SUBSHELL per diagnostic: the trap, the temp files and the exit status all stay inside it,
# so a signal handler may terminate without closing an interactive shell, no later block can
# clobber this cleanup, and the block reports its own status when pasted into a script.
# Neither the credential NOR the production hostname reaches shell history, a process listing,
# or the terminal: both are read without echo into a 0600 curl config file, curl's argv carries
# only --config, and curl runs with -s (never -S) so a failed lookup cannot print
# "Could not resolve host: <hostname>" — the exit CODE carries the category instead
# (review findings on #3042).
(
  umask 077
  KEIKO_CFG_STD="$(mktemp)"; KEIKO_CFG_LLK="$(mktemp)"
  trap 'rm -f "$KEIKO_CFG_STD" "$KEIKO_CFG_LLK"' EXIT
  trap 'rm -f "$KEIKO_CFG_STD" "$KEIKO_CFG_LLK"; exit 130' INT TERM
  # curl config values are double-quoted, so a backslash or quote inside a key or host would
  # change the generated header instead of being sent — escape both (the escaper keeps the
  # value out of any process argument list: printf is a builtin, sed reads stdin).
  esc() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
  read -rs -p 'Proxy host (not echoed): ' HOST; echo
  read -rs -p 'Paste gateway key (not echoed): ' KEY; echo
  HOST_ESC="$(esc "$HOST")"; KEY_ESC="$(esc "$KEY")"
  printf 'url = "https://%s/v1/models"\nheader = "Authorization: Bearer %s"\n' \
    "$HOST_ESC" "$KEY_ESC" > "$KEIKO_CFG_STD"
  printf 'url = "https://%s/v1/models"\nheader = "x-litellm-key: Bearer %s"\n' \
    "$HOST_ESC" "$KEY_ESC" > "$KEIKO_CFG_LLK"
  unset KEY HOST KEY_ESC HOST_ESC
  # curl exit codes: 6 = DNS, 7 = connect, 28 = timeout, 35 = TLS handshake. The status is
  # RETURNED, not swallowed by the echo, so a pasted script can tell a transport failure from a
  # completed diagnostic.
  probe() {
    curl -q -s -o /dev/null -w "%{http_code}\n" --max-time 30 --config "$1"
    probe_status=$?
    if [ "$probe_status" -ne 0 ]; then
      echo "transport failure (curl exit $probe_status)"
    fi
    return "$probe_status"
  }
  # Standard header (expect 200):
  probe "$KEIKO_CFG_STD"
  standard_status=$?
  # Custom header (expect 401/403 while litellm_key_header_name is unconfigured):
  probe "$KEIKO_CFG_LLK"
  custom_status=$?
  if [ "$standard_status" -ne 0 ]; then
    exit "$standard_status"
  fi
  exit "$custom_status"
)
```

If the first call returns 200 and the second an auth status, the proxy has no
`litellm_key_header_name` configured. The `trap` removes both header files when the shell
exits.

**Resolution**

1. Preferred: select `authorization` as the API key header in the gateway setup — it works on
   every stock LiteLLM proxy.
2. Alternative: have the proxy operator set
   `general_settings.litellm_key_header_name: "x-litellm-key"` in the LiteLLM config, then keep
   `x-litellm-key` in Keiko.

---

## Unblock a local LiteLLM behind a corporate proxy environment

| Field             | Value                     |
| ----------------- | ------------------------- |
| Severity          | High                      |
| Surface           | Model gateway             |
| Stable identifier | `PROXY_BLOCKED_BY_POLICY` |

**Symptom**

With LiteLLM running locally (for example `http://127.0.0.1:4000`), every model call fails with
`PROXY_BLOCKED_BY_POLICY` ("Refusing to forward credential headers to a plaintext HTTP target
through the configured proxy.") although the proxy is reachable in a browser.

**Root Cause**

The machine exports `HTTP_PROXY`/`HTTPS_PROXY` (common on corporate images). Keiko adopts the
egress proxy and, as a secret-protection rule, refuses to forward credential headers to a
plaintext HTTP target through a proxy. Loopback is the one plaintext shape the configuration
layer permits — and without an explicit `NO_PROXY` rule it is also routed through the corporate
proxy, which triggers the refusal. The refusal is the intended fail-closed behavior; the missing
piece is the loopback exemption.

**Diagnostic Steps**

```bash
# List WHICH proxy variables are set without printing their values — proxy URLs commonly embed
# credentials, and the raw value must not land in a terminal scrollback or a support log:
env | grep -io '^[a-z_]*_proxy' | sort -u
```

**Resolution**

1. Add the loopback exemption: `NO_PROXY=127.0.0.1,localhost` (and restart Keiko so the egress
   configuration re-resolves).
2. Do not disable the plaintext-credential refusal itself — it protects the key from transiting
   the corporate proxy unencrypted and must stay in place.

---

## Fix max_tokens rejections on reasoning-model aliases

| Field             | Value                                                               |
| ----------------- | ------------------------------------------------------------------- |
| Severity          | Medium                                                              |
| Surface           | Model gateway                                                       |
| Stable identifier | Provider HTTP 400 mentioning `max_tokens` / `max_completion_tokens` |

**Symptom**

Chat calls against a specific LiteLLM alias fail with an upstream 400 about `max_tokens` being
unsupported, while other aliases on the same proxy work.

**Root Cause**

Behind LiteLLM the configured model id is the proxy alias (for example `prod-reasoning`), so
Keiko's model-name heuristic for choosing `max_completion_tokens` cannot recognize the reasoning
backend and sends `max_tokens`. Current LiteLLM versions translate the parameter for reasoning
backends; older pins and pass-through routes forward it unchanged, and the upstream rejects it.

**Diagnostic Steps**

Confirm the alias maps to a reasoning-family backend (`gpt-5*`, `o1/o3/o4*`) in the proxy's
model list, and that the failing parameter in the upstream 400 is `max_tokens`.

**Resolution**

Set the explicit per-provider override in the gateway configuration for that alias:
`"outputTokenParameter": "max_completion_tokens"`. The override is the documented escape hatch
and takes precedence over the name heuristic.

---

## Recognize truncated discovery on large multi-team proxies

| Field             | Value                                          |
| ----------------- | ---------------------------------------------- |
| Severity          | Low                                            |
| Surface           | Model gateway / Local UI                       |
| Stable identifier | Setup succeeds but an expected model is absent |

**Symptom**

Gateway setup completes, but a model the proxy serves does not appear in the configured list.

**Root Cause**

Discovery caps the candidate set at 100 models. Multi-team LiteLLM proxies can expose more
aliases than that; entries beyond the cap are not probed and not configured.

**Diagnostic Steps**

Count the aliases the key can see:

```bash
# Count ENTRIES, not lines: /v1/models is usually a single compact JSON line, on which a line
# grep reports 1 regardless of how many aliases the key can actually see. Only the count is
# printed — the response body itself never reaches the terminal, and a data member that is not
# an ARRAY (a string, or an object carrying a length property) reports the same fixed message
# rather than echoing upstream content. The download is BOUNDED in bytes and time, so a
# misconfigured or hostile proxy cannot fill the disk or the reader's memory, mirroring the
# capped reader the production discovery path uses. Self-contained subshell, as above.
(
  umask 077
  KEIKO_CFG="$(mktemp)"; KEIKO_BODY="$(mktemp)"
  trap 'rm -f "$KEIKO_CFG" "$KEIKO_BODY"' EXIT
  trap 'rm -f "$KEIKO_CFG" "$KEIKO_BODY"; exit 130' INT TERM
  esc() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
  read -rs -p 'Proxy host (not echoed): ' HOST; echo
  # The proxy may be configured to read the custom header (see the header-selection entry
  # above); the count must work on both. The header NAME is not a secret, but it IS
  # allowlisted — a typo would otherwise produce a header no proxy reads and an unexplained
  # auth answer (review finding on #3042).
  read -r -p 'Key header [authorization|x-litellm-key]: ' HDR
  HDR="${HDR:-authorization}"
  case "$HDR" in
    authorization | x-litellm-key) ;;
    *)
      echo "unsupported key header: choose authorization or x-litellm-key"
      exit 2
      ;;
  esac
  read -rs -p 'Paste gateway key (not echoed): ' KEY; echo
  printf 'url = "https://%s/v1/models"\nheader = "%s: Bearer %s"\n' \
    "$(esc "$HOST")" "$HDR" "$(esc "$KEY")" > "$KEIKO_CFG"
  unset KEY HOST HDR
  # A TRANSPORT failure fails the command (category by exit code, no hostname) instead of
  # reaching node as empty input and being reported as a parse failure.
  # -q FIRST: curl reads ~/.curlrc even when --config is given, and a default `verbose` or
  # `trace` there would print the Authorization header this block works to keep hidden
  # (review finding on #3042).
  http_code=$(curl -q -s -o "$KEIKO_BODY" -w '%{http_code}' --max-time 30 --max-filesize 2000000 \
    --config "$KEIKO_CFG")
  curl_status=$?
  if [ "$curl_status" -ne 0 ]; then
    echo "transport failure (curl exit $curl_status)"
    exit "$curl_status"
  fi
  # The HTTP status accompanies an unreadable body: curl does not fail on 4xx, so a key sent on
  # the header this proxy ignores would otherwise look like a malformed model list rather than
  # an auth answer (review finding on #3042). The status is a number — still body-free.
  # Counts ids the way discovery reads them: from a 2xx body only, taking the first usable of
  # id / model_name / model / deployment_name / deploymentName, TRIMMED, bounded in length, and
  # deduplicated — modelIdFromKnownFields does exactly that before MAX_DISCOVERED_MODELS applies
  # (review findings on #3042).
  node -e 'const fs=require("node:fs");const MAX=2_000_000;const F=["id","model_name","model","deployment_name","deploymentName"];const [f,code]=process.argv.slice(1);const pick=(e)=>{for(const k of F){const v=e?.[k];if(typeof v==="string"){const t=v.trim();if(t.length>0&&t.length<=160)return t;}}return undefined;};let n;if(code.startsWith("2")&&fs.statSync(f).size<=MAX){try{const p=JSON.parse(fs.readFileSync(f,"utf8"));if(Array.isArray(p?.data))n=new Set(p.data.map(pick).filter((id)=>id!==undefined)).size;}catch{}}console.log(n===undefined?`unreadable response (HTTP ${code}, not a JSON model list)`:n);' "$KEIKO_BODY" "$http_code"
)
```

The cap is KEIKO's own discovery bound (MAX_DISCOVERED_MODELS), applied AFTER the response
arrives — this direct call bypasses it. The number is an UPPER BOUND on what Keiko keeps, in
the direction that matters: 100 or fewer means nothing is truncated, full stop. Above 100 it
is a strong indication, not a proof, because `parseModelDiscovery` still drops entries whose
declared mode the gateway does not accept for chat or embedding before the cap applies — so a
raw 120 can end up as 90 kept. Confirm truncation by comparing this number with the deployment
list Keiko itself shows after a successful save: exactly 100 there is the cap in action.

**Resolution**

Enter the intended deployments explicitly in the setup form's deployment-names field — an
explicit list bypasses discovery and is probed as given. Alternatively, use a virtual key whose
model allowance is scoped to the models Keiko should use.

---

## Commit draft fails under a slow gateway or a reasoning model

| Field             | Value                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Severity          | Medium                                                                                                      |
| Surface           | Git window (commit draft)                                                                                   |
| Stable identifier | `GIT_DELIVERY_COMMIT_DRAFT_TIMED_OUT` / `GIT_DELIVERY_COMMIT_DRAFT_OUTPUT_EXHAUSTED` / `..._INVALID_OUTPUT` |

**Symptom**

Clicking "Generate with Keiko" in the Git window fails. Before 1.1.7 a thrown gateway error
surfaced as "Keiko could not generate a commit draft from the staged diff." A returned unusable
answer, including truncated output, surfaced as "Keiko generated a commit draft that did not pass
validation." Neither message distinguished a slow provider from an exhausted output allowance.

**Root Cause**

A LiteLLM-fronted vLLM gateway (`gemma-*-it`, `gpt-oss-120b`) can take 30-120s or longer to answer
at peak load, and a reasoning model spends output tokens on its reasoning trace before its first
answer token. Two distinct upstream behaviors used to collapse into one code:

1. The gateway did not answer within the route's own bound.
2. The model answered but spent its whole output-token budget reasoning, ending with
   `finish_reason: "length"` and no usable content (or a partial, truncated fragment).

The route now tells these apart from a THIRD case — a complete answer that failed the commit
message policy/shape — and reports each with its own code and safe message:

- `GIT_DELIVERY_COMMIT_DRAFT_TIMED_OUT` (HTTP 504) — the gateway did not answer in time.
- `GIT_DELIVERY_COMMIT_DRAFT_OUTPUT_EXHAUSTED` (HTTP 502) — the model exhausted its output budget
  on reasoning.
- `GIT_DELIVERY_COMMIT_DRAFT_INVALID_OUTPUT` (HTTP 502) — a complete answer failed validation;
  unchanged from before.

**Diagnostic Steps**

`keiko support export --correlation-id <id>` (the id shown with the failure) and
`keiko support analyze <report.json> --correlation-id <id>` reconstruct the `git.commit.draft.completed`
line for that request: its `failureCode` field names exactly one of the three codes above, and
`errorKind` is `timeout` for the first, `validation-failed` for the other two. Neither the diff nor
the model's raw output ever appears in the log or in the export.

**Resolution**

- `GIT_DELIVERY_COMMIT_DRAFT_TIMED_OUT`: retry — the route now allows a generous backstop for the
  whole buffered call instead of a flat 30s cap, and marks the request `latencyProfile:
"coding-workbench"` so the gateway applies its own coding-workbench provider-timeout floor. If it
  keeps timing out, the configured provider `timeoutMs` for that model is still too low for the
  proxy's real latency at peak load; raise it in the gateway configuration.
- `GIT_DELIVERY_COMMIT_DRAFT_OUTPUT_EXHAUSTED`: retry, or write the commit message yourself. The
  route now requests a 4,000-token output budget (up from 700) specifically so a reasoning model has
  room to both think and answer; a model whose reasoning trace still exceeds that on every attempt
  needs a lower reasoning-effort setting on the proxy side.
- `GIT_DELIVERY_COMMIT_DRAFT_INVALID_OUTPUT`: unchanged — the drafted message did not meet the
  repository's commit-message policy; edit and commit manually.

---

### Development correction: large selections and repeatable drafts (2026-09-27)

A large staged lockfile could exhaust the ordinary 256 KiB Git command output allowance before
model generation, or consume the draft's entire 90,000-character prefix and hide subsequent code
and tests. The staged-diff reader now permits a bounded 4 MiB by default while preserving explicit
narrower policies. Prompt assembly accounts for the selected model's context window and gives
every file a share; omitted lines are marked. `GIT_DELIVERY_COMMIT_DRAFT_CONTEXT_TOO_LARGE` means
even that compact evidence cannot fit; no file is silently removed from the selection.

Repeated Generate actions with the same staged content, policy, instructions and model
configuration reuse the same validated draft in the current process (up to 32 retained results).
The output layout is normalized to one subject, one bullet list and one footer. Changed inputs
produce a new draft. Invalid output gets one corrective attempt; output exhaustion gets one larger
allowance when the model permits it, bounded by the original request deadline. Persistent invalid
answers still fail visibly. No error is cached and no placeholder commit text is reported as success.

The existing `git.commit.draft.completed` line carries `promptTokens`, `maxPromptTokens`,
`diffCompacted`, `generationAttempts` and `reused` when observed. The fields are counts and flags;
no customer paths, diff or generated text is recorded. For a formatting report, compare
`normalizationVersion`, `normalizationRule` and `normalizationChanged`, then `bodyBulletCount`,
`trailerLikeLineCount`, `trailerCount`, `trailerContinuationCount`, `trailerParagraphBreakCount`,
`referenceTrailerCount` and `breakingTrailerCount`. These separate footer retention from body-list
normalization, and carry the same values on cache reuse. Missing normalization fields mean that line's selected result did not reach the
formatter; zero means it ran and observed none. For a repair, read every
`git.commit.draft.attempt.completed` line with the same correlation in `attempt` order. Its
`failureCode` explains why repair ran or failed, while each attempt retains its own normalization
and prompt bounds. An attempted repair refused before the model call still has an attempt line;
`generationAttempts` counts actual model calls. Cache reuse has no new attempt lines. No footer label or reference value
is logged.

Chat startup now retries transient proxy failures and timeouts within the configured retry count
and one shared stream budget. It never restarts a stream after delivering text. Authentication
failures, cancellation and non-retryable refusals remain terminal. Each retry passes spend admission
again and records the existing `gateway.retry.*` evidence.

---

## Conversation Center reports "Model gateway did not answer in time" under load, or setup drops a slow model

| Field             | Value                                                              |
| ----------------- | ------------------------------------------------------------------ |
| Severity          | Medium                                                             |
| Surface           | Conversation Center chat stream; first-run Gateway Setup discovery |
| Stable identifier | `GATEWAY_TIMEOUT`                                                  |

**Symptom**

A chat reply in the Conversation Center fails with "The model gateway did not answer within the
wait limit..." even though the same model answers fine at low load. During first-run Gateway
Setup, a model that was slow to answer during discovery is silently missing from the configured
model list afterward.

**Root Cause**

Before #3591, `Gateway.chatStream()` (the Conversation Center's streaming path) called the
provider adapter with no read bounds at all, so a real adapter fell back to a flat 60s idle wait
and the provider's own configured `timeoutMs` (30s by default) for the ENTIRE read — a live
generation that kept producing tokens past that point was cut off and reported as a timeout, even
though the provider was still working. Separately, the first-run setup discovery smoke test used a
15s timeout and dropped any candidate whose probe did not answer in time, with no way to tell "the
gateway rejected this model" apart from "the gateway was just slow" in the result.

Every interactive gateway surface now floors its effective wait: at least 5 minutes before treating
silence as a failure on a stream, at least 30 minutes total for a streamed answer and 10 minutes
for a buffered one, which cannot observe progress and therefore gets the whole budget per attempt
(`GATEWAY_SILENCE_FLOOR_MS` / `GATEWAY_STREAM_BUDGET_FLOOR_MS` / `GATEWAY_BUFFERED_BUDGET_FLOOR_MS`,
`resilience.ts`) — a caller's own configuration may only raise these, never lower them. Readiness
probes the product starts on its own (the Coding Workbench's automatic probes and the on-demand chat
probe that gates a first chat) run with a 2-minute floor, the long-context probe with 5 minutes; a
probe the gateway never answered, could not be reached for, or answered with a transient status
(408, 429, 5xx except 501) is recorded as inconclusive and retried after one minute instead of
holding the six-hour cooldown. Setup discovery bounds each smoke candidate by its provider timeout,
never below 120s, and the whole chat round by 10 minutes; a candidate the probe never gets an answer
from, or that answers with a transient status, is kept in the configuration as unverified instead of
being dropped; only a candidate the gateway actually rejects (400/404/422/501, or a malformed
answer) is removed. A timeout still counts toward the model's circuit breaker — with these floors a
timeout is a multi-minute silence, an outage signal — while an exhausted output budget (an HTTP 200
answer with `finish_reason: length` and no content) does not.

**Diagnostic Steps**

For a chat failure: `keiko support export --correlation-id <id>` and
`keiko support analyze <report.json> --correlation-id <id>` reconstruct the `gateway.stream.started` /
`gateway.stream.failed` (or `gateway.chat.started` / `gateway.chat.failed`) pair for that request.
`gateway.stream.failed`'s `errorKind` is `timeout` only once the read has actually exceeded the
floored silence or budget bound reported on the paired `chat.response.streamed` line
(`silenceMs`, `readBudgetMs`) — never the raw configured `timeoutMs`. Neither line ever carries
provider content.

For a setup discovery drop: the response body's `unverifiedChatModelIds` names a candidate that was
kept despite a probe failure, and `droppedChatModelIds` names one the gateway actually rejected;
setup's `GatewayDiscoveryUnusableModels` diagnostic reports the counts of both, body-free.

**Resolution**

- A chat `GATEWAY_TIMEOUT` after the floored wait is a genuinely slow or unreachable gateway, not a
  configuration bug in Keiko: check the provider's own health and load, or raise the model's
  `timeoutMs` in Gateway Setup if it is legitimately slower than the floor.
- A setup candidate that lands in `unverifiedChatModelIds` is configured but not smoke-verified; it
  will be verified by the existing on-demand and automatic readiness probes the next time it is
  used. A candidate in `droppedChatModelIds` was genuinely rejected by the gateway (wrong model id,
  no chat capability, credential mismatch for that deployment) and must be corrected in the setup
  form.

---

## Coding Workbench run during a gateway overload or short outage

| Field             | Value                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| Severity          | High                                                                         |
| Surface           | Coding Workbench                                                             |
| Stable identifier | `gateway.retry.scheduled` / `gateway.circuit.wait` under the run correlation |

**Symptom**

At peak load the LiteLLM gateway or the model server behind it answers 429 or 503, or stops
answering, for a few minutes. A Workbench run keeps showing "Working" instead of failing.

**Root Cause**

Before #3873 a coding turn stopped after the provider's configured attempt count (by default three
attempts within about two seconds) and, once the circuit breaker opened, every further attempt was
refused at once. The coding runtime then gave up after about ten of its own retries, so a three-minute
overload failed the whole run although the gateway recovered.

A coding turn now keeps retrying a transiently unavailable provider for the outage window (ten
minutes by default) with capped, jittered backoff and any announced `Retry-After`, and waits
through an open breaker's cooldown instead of being refused. The coding sidecar route asks for this
with an explicit outage policy on each of its model calls, buffered and streamed alike, so a turn
behaves the same whether or not the model streams. On a streamed turn the window covers every
failure before the first answer text, also after the model's reasoning was already shown: the
retried attempt's reasoning is not shown a second time. Once answer text reached the Workbench, a
retry inside the gateway would duplicate it, so the turn ends with an error and the coding runtime
decides whether to retry it (`coding-sidecar.gateway.turn-failed runtimeRetry=allowed`). The breaker still admits only its half-open
probes, so waiting runs do not add load while the gateway recovers. Only an unavailable provider is
waited for: a model that keeps answering with an invalid tool-call shape gets the configured
attempt count and its schema-repair corrections, then the turn fails with the invalid-shape
rejection as before.

The window applies as configured: the turn's own budget is extended to the window plus one attempt,
so `maxRetries: 0`, which LiteLLM routes commonly use, no longer caps it at ten minutes. Each
attempt keeps its own bound. A silent attempt ends after at least five minutes without data when the
answer is read over a stream, otherwise after at least ten minutes, and is retried only while the
window still has room: with the default window a silent streamed attempt is retried once and a
silent whole-body attempt not at all.

A refused connection counts as transient on purpose: a restarting or overloaded gateway can refuse
connections for a while. Gateway Setup's probe catches a misconfigured route before any coding turn
runs, so a Workbench turn that faces an unreachable gateway waits up to the window before it fails.

The commit-message draft and interactive chat keep their fail-fast behavior: a person waits on them,
and they never carry the outage policy, although the draft borrows the coding timeout floors. While
the gateway answers 429 or 503 or refuses connections, the draft still fails after the provider's
attempt count, within seconds, with `GIT_DELIVERY_COMMIT_DRAFT_FAILED`.

**Diagnostic Steps**

`keiko support analyze <report.json> --correlation-id <runId>` shows each retry as
`gateway.retry.scheduled` (`httpStatus`, `delayMs`, `retryAfterHeader`), a breaker transition as
`gateway.circuit.opened` / `gateway.circuit.half-open`, and a wait as `gateway.circuit.wait`
(`reason`, `outcome`). A call that outlasted the window ends with `gateway.retry.exhausted reason=budget`, or, when the
window ran out while it waited on an open breaker or a saturated probe slot, with
`gateway.circuit.wait outcome=budget-refused`.

Each of these retry and wait lines names the policy it ran under in `retryPolicy`. `outage-window`
is a coding turn riding out the outage, so retries beyond the provider's `maxRetries` are expected.
`attempts` is a retry that keeps the provider's attempt count: a commit draft, interactive chat, a
coding turn with the window switched off, or a coding turn's retry of the model's own invalid
tool-call shape. Retries beyond `maxRetries` under `retryPolicy=attempts` point at a retry-loop
defect, not at the window.

**Resolution**

- A run that recovered needs nothing; the gap in its timeline is the outage.
- A turn that still failed after the window (ten minutes by default) points at a sustained outage:
  check the gateway's and model server's health and capacity before retrying the task.
- The window is `codingOutageWindowMs` in the gateway configuration (milliseconds; default
  `600000`, at most `3600000`). Raise it where peak-time overloads last longer or where a silent
  attempt should be retried, or set `0` to restore the fail-fast attempt count for coding turns as
  well. Gateway Setup keeps the value, `0` included, when it rewrites the configuration.
- A Workbench turn whose retries after a 429, a 5xx, a timeout or a refused connection carry
  `retryPolicy=attempts` ran with the window switched off (`codingOutageWindowMs: 0`).

---

## Coding Workbench shows no model reasoning, or the answer only once it is complete

| Field             | Value                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| Severity          | Low                                                                                                |
| Surface           | Coding Workbench                                                                                   |
| Stable identifier | `chat.response.streamed` (`reasoningEvents`) / `gateway.stream.completed` (`reasoningDisposition`) |

**Symptom**

A reasoning model (Gemma 4 behind vLLM with a reasoning parser, or an Anthropic model with
thinking) works through a Workbench run, but the timeline shows no "Model reasoning" block, or the
answer appears in one piece only once it is complete.

**Root Cause**

The model's reasoning reaches Keiko only through the field LiteLLM normalises it into:
`reasoning_content` on each streamed delta and on a buffered message (a server that names the
field `reasoning` is read the same way). The Workbench streams a turn live and shows its reasoning
by default; both are operator opt-outs in the gateway configuration. Nothing reaches the timeline
when the model server does not separate the reasoning (no reasoning parser for the model family, so
the reasoning stays inside the answer text or is not produced), when the LiteLLM route merges it
back into the answer (`merge_reasoning_content_in_choices: true`) or drops the request parameter
that switches it on (`drop_params` removing `reasoning_effort` on a model that needs it), or when
the configuration sets `codingReasoningDisplay: "off"`. The answer arrives in one piece when the
configuration sets `codingStreaming: "off"`, when the model's capability does not stream, when the
coding runtime sent its request without `stream: true`, or when a proxy between Keiko and the model
ignores `stream` and answers with one JSON body.

**Diagnostic Steps**

`keiko support analyze <report.json> --correlation-id <runId>`, then per model turn:

- `chat.response.streamed` with `reasoningEvents: 0` and `reasoningBytes: 0`: the provider sent no
  `reasoning_content`; check the model server and the LiteLLM route.
- `reasoningEvents` above 0 with `gateway.stream.completed` (or `gateway.chat.completed`)
  `reasoningDisposition: discarded`: the reasoning arrived and the display switch discarded it.
- `coding-sidecar.gateway.usage-settled` records the turn's share as counts: `contentBytes`,
  `reasoningBytes`, the provider's own `reasoningTokens` when it reports them, beside `outputBytes`;
  `coding-sidecar.gateway.outcome` `reasoningFrames` and `forwardedReasoningBytes` count the frames
  and bytes that carried reasoning to the coding runtime (`reasoningWithheld: true` on a buffered
  answer whose oversized reasoning was withheld), and `coding-runtime.history-projection`
  `reasoningSignalCount` the reasoning pieces a history read prepared for the timeline, before the
  timeline accepts them.
- A coding turn read with `gateway.stream.started` streams live, unless its
  `chat.response.streamed` line says `outcome: whole-body` (a proxy that ignored `stream` and
  answered with one JSON body). `gateway.chat.started` means the turn was buffered:
  `codingStreaming: "off"`, a capability without streaming, or a runtime request without
  `stream: true`.

**Resolution**

- Enable the model server's reasoning parser for the model family (vLLM `--reasoning-parser`).
- In the LiteLLM route, leave `merge_reasoning_content_in_choices` unset (or `false`) so the
  reasoning stays in `reasoning_content`, and make sure `drop_params` does not strip the reasoning
  parameter the model needs.
- Remove `codingReasoningDisplay: "off"` and `codingStreaming: "off"` from the gateway
  configuration to restore the defaults (both `"on"`; the only accepted values are `"on"` and
  `"off"`).
- Shown reasoning is unverified model output. It is never kept in Coding History, evidence, a
  support export or the Activity Log, which record only its counts.

---

## A discovered rerank model does not reach retrieval

| Field             | Value                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| Severity          | Medium                                                                  |
| Surface           | Gateway Setup discovery; grounded retrieval reranking                   |
| Stable identifier | `gateway.reranker.setup.resolved` / `GATEWAY_DISCOVERY_UNUSABLE_MODELS` |

**Symptom**

The proxy lists a rerank model (`mode: rerank`, or an id such as `bge-reranker-v2-m3`), but
retrieval answers show no model reranking and Gateway Setup lists the model as skipped with the
reason `rerank`.

**Root Cause**

Discovery gives a rerank model a lane of its own: it is never configured as a chat or embedding
model, whatever its family prefix says. After the chat and embedding probes, setup sends the same
two-document request gateway readiness sends to the discovered engine and wires it as the retrieval
reranker on the verified setup connection only when the provider answers and ranks the matching
document first; the matching document is sent second, so an engine that only returns the input
order fails. It is not wired when (a) the probe failed or ranked wrongly — at most three candidates
are probed, declared rerank models before name-inferred ones and then by id, within one shared
45-second probe budget per setup — or (b) a reranker already exists in the stored or current
configuration: a file- or operator-configured reranker is never replaced. One that shares the
gateway connection follows a credential rotation, and when the setup moves to a new endpoint it is
probed there again and dropped when the new gateway does not host it.

**Diagnostic Steps**

`keiko support analyze <report.json>` shows one `gateway.discovery.alias-intersection` line per
discovered alias whose `role` names its lane, and one `gateway.reranker.setup.resolved` line per
committed setup that found a rerank model: `outcome` is `wired`, `kept-existing` (an existing
reranker blocked the wiring; probed once only when it moved to a new endpoint) or `probe-failed`
(logged at `warn`, with a `GATEWAY_RERANKER_PROBE_FAILED` diagnostic), with the candidate and probe
counts. The probe itself leaves a `search.rerank.completed` line with the closed `failureKind`.
The setup response lists every model Keiko did not configure under `unsupportedModels`; a wired
reranker is absent from it and appears as `config.reranker.modelId`.

**Resolution**

- `probe-failed`: check that the proxy serves `POST <base URL>/rerank` for that model with the same
  key, then save the setup again; discovery repeats the probe. A reranker on a separate endpoint or
  key belongs in the configuration file's `reranker` block, which discovery never overrides.
- `kept-existing`: nothing to fix; remove the stored `reranker` block first if the discovered engine
  should replace it.
