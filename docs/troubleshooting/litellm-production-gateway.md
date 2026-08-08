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
  read -rs -p 'Proxy host (not echoed): ' HOST; echo
  read -rs -p 'Paste gateway key (not echoed): ' KEY; echo
  printf 'url = "https://%s/v1/models"\nheader = "Authorization: Bearer %s"\n' "$HOST" "$KEY" \
    > "$KEIKO_CFG_STD"
  printf 'url = "https://%s/v1/models"\nheader = "x-litellm-key: Bearer %s"\n' "$HOST" "$KEY" \
    > "$KEIKO_CFG_LLK"
  unset KEY HOST
  # curl exit codes: 6 = DNS, 7 = connect, 35 = TLS handshake, 28 = timeout.
  probe() {
    curl -s -o /dev/null -w "%{http_code}\n" --config "$1" ||
      echo "transport failure (curl exit $?)"
  }
  # Standard header (expect 200):
  probe "$KEIKO_CFG_STD"
  # Custom header (expect 401/403 while litellm_key_header_name is unconfigured):
  probe "$KEIKO_CFG_LLK"
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
# rather than echoing upstream content. Self-contained subshell, as above.
(
  umask 077
  KEIKO_CFG="$(mktemp)"; KEIKO_BODY="$(mktemp)"
  trap 'rm -f "$KEIKO_CFG" "$KEIKO_BODY"' EXIT
  trap 'rm -f "$KEIKO_CFG" "$KEIKO_BODY"; exit 130' INT TERM
  read -rs -p 'Proxy host (not echoed): ' HOST; echo
  read -rs -p 'Paste gateway key (not echoed): ' KEY; echo
  printf 'url = "https://%s/v1/models"\nheader = "Authorization: Bearer %s"\n' "$HOST" "$KEY" \
    > "$KEIKO_CFG"
  unset KEY HOST
  # The body goes to a temp file so a TRANSPORT failure fails the command (category by exit
  # code, no hostname) instead of reaching node as empty input and being reported as a parse
  # failure.
  curl -s -o "$KEIKO_BODY" --config "$KEIKO_CFG" ||
    { echo "transport failure (curl exit $?)"; exit 1; }
  node -e 'const d=require("node:fs").readFileSync(process.argv[1],"utf8");let n;try{const p=JSON.parse(d);if(Array.isArray(p?.data))n=p.data.length;}catch{}console.log(n===undefined?"unreadable response (not a JSON model list)":n);' "$KEIKO_BODY"
)
```

The cap is KEIKO's own discovery bound (MAX_DISCOVERED_MODELS), applied AFTER the response
arrives — this direct call bypasses it, so a count ABOVE 100 is exactly the proof that Keiko
will truncate the list; a count of 100 or less means every alias the key can see fits.

**Resolution**

Enter the intended deployments explicitly in the setup form's deployment-names field — an
explicit list bypasses discovery and is probed as given. Alternatively, use a virtual key whose
model allowance is scoped to the models Keiko should use.
