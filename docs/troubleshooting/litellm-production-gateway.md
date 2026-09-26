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

## Coding Workbench turn has no assistant reply

For a Workbench run that accepted a message but has no assistant reply, note the run id and export a
body-free bundle with `keiko support export --out keiko-bundle.jsonl`. Analyze that bundle with
`keiko support analyze keiko-bundle.jsonl --correlation-id <runId>`. The run timeline includes
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

A coding run's prompt needs a window of at least 32,000 prompt tokens, the minimum the default
model's readiness already requires. A LiteLLM route that declares no token limits leaves the
4,096-token setup placeholder until Keiko's automatic long-context probe proves a larger window.
Before 1.1.8 such a model was admitted; the gateway then refused the run's first request, and the
run failed after the two-minute start timeout without a reason.

**Diagnostic Steps**

Export a bundle and analyze the run with
`keiko support analyze keiko-bundle.jsonl --correlation-id <runId>`. The `coding-runtime.start`
diagnostic reads
`stage=start:reason=launch-resolution:model-unavailable:model-context-window-insufficient`, or
`...:model-verification-pending` while the probe runs. `gateway.readiness.automatic.completed`
shows whether the long-context probe ran and which window it verified.

**Resolution**

While the probe runs, wait and start again. If Keiko cannot confirm 32,000 tokens, the model is too
small for coding runs as the gateway describes it: choose a larger model, or declare the model's
real `max_input_tokens` in the LiteLLM model configuration.

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

Clicking "Generate with Keiko" in the Git window fails. Before 1.1.7 every cause surfaced as the
same generic "Keiko generated a commit draft that did not pass validation." regardless of whether
the gateway never answered or answered with something unusable, so the message gave no signal on
what to try next.

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
`keiko support analyze <bundle> --correlation-id <id>` reconstruct the `git.commit.draft.completed`
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
`keiko support analyze <bundle> --correlation-id <id>` reconstruct the `gateway.stream.started` /
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
