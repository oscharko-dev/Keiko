# Troubleshooting Guide

This guide documents the most common runtime failures observed in Keiko's
local UI, CLI, and model-gateway surfaces. Each entry follows the same
structure so operators and support engineers can move from symptom to
resolution without reading source.

Keiko is a local-only tool: the UI binds to loopback, credentials stay on
the local machine, and verification is performed against the selected
project path. The diagnostic commands below operate on a single user's
local installation. They do not require server-side instrumentation or
external observability tooling.

## How to use this guide

1. Find the entry whose **Symptom** matches the observed behavior.
2. Confirm the **Root Cause** by running the listed **Diagnostic Steps**.
3. Apply the **Resolution** for that root cause.
4. If the symptom does not match any entry, capture redacted evidence
   following the rules in the [User-Finding report form](../user-finding-report.md)
   and open a finding.

For contributors adding new entries, use the
[troubleshooting entry template](./_template.md). Do not include API
keys, customer data, internal endpoints, or private logs in examples.

Portable launch/setup issues are covered in the dedicated
[Portable Launch And Setup Troubleshooting](portable-launch-setup.md) entry. Use that page for
Windows SmartScreen, macOS Gatekeeper, managed install root, proxy, firewall, local port, and
organization-managed rollout blockers.

## Severity scale

The severity field on each entry uses the following scale. It is a
documentation convention only; Keiko itself does not emit severity
levels.

| Severity | Meaning                                                                     |
| -------- | --------------------------------------------------------------------------- |
| Blocker  | Keiko cannot start, cannot serve the UI, or cannot reach any chat model.    |
| High     | A core workflow (chat, generate tests, investigate, verify) is unusable.    |
| Medium   | A specific surface or command fails while other workflows continue to work. |
| Low      | Usability or visual defect with a clear local workaround.                   |

## Log locations and debug mode

| Path                   | Purpose                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `.keiko/ui.log`        | Local UI process log. Written by `keiko start` for the background UI process.                     |
| `.keiko/ui.pid`        | Background UI process id. Removed by `keiko stop` and by `keiko start` when the pid is not alive. |
| `.keiko/evidence/`     | Redacted evidence written by surfaces that persist a manifest (for example `keiko verify`).       |
| `~/.keiko/keiko-ui.db` | Local UI state database. User-scoped, not project-scoped.                                         |

To capture verbose output for a single command run, invoke the CLI in the
foreground and redirect both streams to a file you control. For example:

```bash
npx keiko ui --port 1983 > keiko-foreground.log 2>&1
```

Run `npm run keiko:start` only for normal daily use; the foreground
invocation above is intended for short diagnostic sessions. Stop the
foreground process with `Ctrl+C` when finished and remove the log file
once it has been reviewed and redacted.

When a CLI verification or workflow command produces unexpected output,
attach the redacted command output and the relevant section of
`.keiko/ui.log`. Do not attach `~/.keiko/keiko-ui.db`, runtime config
files, or files under `.keiko/evidence/` without first reviewing them for
project content.

---

## Entries

### 1. UI process does not become healthy after `keiko start`

| Field             | Value                                    |
| ----------------- | ---------------------------------------- |
| Severity          | Blocker                                  |
| Surface           | CLI lifecycle, local UI                  |
| Stable identifier | `keiko start: UI did not become healthy` |

**Symptom**

`keiko start` (or `npm run keiko:start`) prints
`keiko start: UI did not become healthy. Logs: <path>/.keiko/ui.log` and
exits with code `1`. The pid file under `.keiko/ui.pid` is removed by the
lifecycle command before exit. Subsequent calls to `keiko status` report
that Keiko UI is not running.

**Root Cause**

The lifecycle command spawns the UI process and polls
`http://127.0.0.1:<port>/api/health` until either the configured start
timeout elapses or the child process exits. The error is emitted when the
child process started but never returned a healthy response inside the
configured timeout window (default 20 seconds via `KEIKO_START_TIMEOUT_SECS`).
The two common causes are an immediate process crash recorded in
`.keiko/ui.log` and a slow start on cold caches where the default timeout
is too tight.

**Diagnostic Steps**

```bash
# Confirm Keiko is not already running on the same port.
keiko status

# Read the most recent UI log lines for the immediate stack trace or error.
tail -n 200 .keiko/ui.log

# Run the UI in the foreground to surface startup errors interactively.
npx keiko ui --port 1983
```

If `.keiko/ui.log` shows a Node.js stack trace, the UI process crashed
during startup. If the foreground invocation returns
`Keiko UI listening on http://127.0.0.1:1983` and serves
`/api/health`, the previous failure was a startup-timeout race rather
than a process crash.

**Resolution**

- Stop and remove the stale pid file: `npm run keiko:stop`, then delete
  `.keiko/ui.pid` only if it is present and the process is no longer
  alive.
- If `.keiko/ui.log` contains a crash, address the underlying error
  reported in the log (typically a port conflict or a Node.js version
  older than 22; see the [Requirements](../../README.md#requirements)
  section).
- If the foreground UI starts cleanly, raise the start timeout for slow
  hosts by exporting `KEIKO_START_TIMEOUT_SECS=60` before invoking
  `keiko start` or `npm run keiko:start`.

---

### 2. Port is already in use

| Field             | Value                   |
| ----------------- | ----------------------- |
| Severity          | High                    |
| Surface           | CLI lifecycle, local UI |
| Stable identifier | `EADDRINUSE :1983`      |

**Symptom**

The UI fails to start. `.keiko/ui.log` (or the foreground command output)
contains `Error: listen EADDRINUSE: address already in use 127.0.0.1:1983`
or an equivalent message naming a different port. `keiko status` reports
that Keiko UI is not running, even though the bind error has been
emitted.

**Root Cause**

Another process — frequently an orphaned Keiko UI from a previous
session or an unrelated developer tool — is bound to the configured
port. Keiko uses `1983` by default and accepts an override via
`KEIKO_UI_PORT` or `--port`. The Node HTTP server emits `EADDRINUSE` as
soon as `listen()` is called against an occupied port.

**Diagnostic Steps**

```bash
# Identify the process holding the port on Linux or macOS.
lsof -nP -iTCP:1983 -sTCP:LISTEN

# On Windows PowerShell.
Get-NetTCPConnection -LocalPort 1983 -State Listen

# Confirm Keiko's own pid file, if any, no longer points at a live process.
cat .keiko/ui.pid 2>/dev/null && ps -p "$(cat .keiko/ui.pid)" || echo "no live keiko pid"
```

**Resolution**

- If the conflicting process is a previous Keiko UI, run `npm run keiko:stop`.
  Remove `.keiko/ui.pid` only if the file remains after `keiko stop`
  reports that nothing was running.
- If the conflicting process is unrelated and must keep its port, start
  Keiko on a different port: `KEIKO_UI_PORT=1984 npm run keiko:start` or
  `npx keiko start --port 1984`.
- Restart only after `keiko status` reports that Keiko UI is not
  running and the chosen port is free.

---

### 3. Gateway TLS trust failure (self-signed or corporate CA)

| Field             | Value                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Severity          | Blocker                                                                                               |
| Surface           | Model gateway, first-run setup                                                                        |
| Stable identifier | `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` / `SELF_SIGNED_CERT_IN_CHAIN` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` |

**Symptom**

First-run setup or any gateway request fails with one of the following
Node.js TLS error codes:

- `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`
- `SELF_SIGNED_CERT_IN_CHAIN`
- `DEPTH_ZERO_SELF_SIGNED_CERT`
- `UNABLE_TO_VERIFY_LEAF_SIGNATURE`

The browser UI shows a Gateway Setup error and the loopback BFF returns
`GATEWAY_SETUP_FAILED`. The base URL is correct and the API token has
not been rejected.

**Root Cause**

The gateway is served from a host whose certificate chain Node.js cannot
build using the default trust store. This is common for corporate
gateways protected by an internal certificate authority and for
on-premise installations using a self-signed leaf certificate. Keiko
performs a recoverable retry that combines Node.js's bundled roots, the
system trust store, and any certificates supplied via
`NODE_EXTRA_CA_CERTS`. When none of those sources contain the chain, the
TLS error is surfaced to the caller.

**Diagnostic Steps**

```bash
# Reproduce the failure outside Keiko to confirm the chain is the cause.
curl --verbose https://llm-gateway.example.com/v1/models

# Confirm whether NODE_EXTRA_CA_CERTS is set and points at a readable PEM bundle.
echo "$NODE_EXTRA_CA_CERTS"
test -r "$NODE_EXTRA_CA_CERTS" && head -n 1 "$NODE_EXTRA_CA_CERTS"
```

If `curl` reports `unable to get local issuer certificate` against the
same base URL, the host trust store is missing the chain.

**Resolution**

- Obtain the gateway's certificate authority bundle from the team that
  operates the gateway. Concatenate the required intermediates and the
  root into a single PEM file.
- Export the path before starting Keiko, then restart the UI:

  ```bash
  export NODE_EXTRA_CA_CERTS=/absolute/path/to/corporate-ca.pem
  npm run keiko:stop
  npm run keiko:start
  ```

- Confirm the gateway base URL ends with `/v1` for OpenAI-compatible
  gateways. For Azure AI Foundry endpoints the host suffix
  `.services.ai.azure.com` is detected automatically and the
  `/openai/v1` path is appended where required.
- Do not disable TLS verification globally with `NODE_TLS_REJECT_UNAUTHORIZED=0`.
  Keiko refuses to weaken TLS verification because it would defeat the
  audited transport posture documented in
  [Security boundaries](../security-and-audit-boundaries.md).

---

### 4. First-run gateway setup returns no usable models

| Field             | Value                                                   |
| ----------------- | ------------------------------------------------------- |
| Severity          | Blocker                                                 |
| Surface           | First-run gateway setup                                 |
| Stable identifier | `GATEWAY_DEPLOYMENTS_REQUIRED` / `GATEWAY_SETUP_FAILED` |

**Symptom**

The Settings dialog accepts the base URL and API token but reports that
no callable chat models were discovered. The loopback BFF returns one of:

- `GATEWAY_DEPLOYMENTS_REQUIRED` when the gateway cannot expose a model
  list.
- `GATEWAY_SETUP_FAILED` when every smoke call returned a non-success
  response.

**Root Cause**

After credentials are accepted, Keiko fetches the gateway model list,
filters non-chat models using LiteLLM-style metadata when available, and
runs a small chat-completions smoke call against each candidate. Only
models that successfully respond are persisted. The setup returns no
models when (a) the gateway requires deployment names rather than
exposing a list (most common with Azure AI Foundry), or (b) the gateway
list is reachable but every chat-completions call fails (often due to a
restricted token, regional rollout, or quota).

**Diagnostic Steps**

```bash
# Confirm the gateway exposes an OpenAI-compatible model list at the configured base URL.
curl --silent --show-error --header "Authorization: Bearer <REDACTED>" \
  https://llm-gateway.example.com/v1/models | head

# Probe one chat-completions endpoint directly with a minimal payload.
curl --silent --show-error --header "Authorization: Bearer <REDACTED>" \
  --header "content-type: application/json" \
  --data '{"model":"<deployment>","messages":[{"role":"user","content":"ping"}]}' \
  https://llm-gateway.example.com/v1/chat/completions
```

Replace `<REDACTED>` with the gateway API token only inside the local
shell. Do not paste the token into chat tools or commit it.

**Resolution**

- For Azure AI Foundry or any gateway that returns
  `GATEWAY_DEPLOYMENTS_REQUIRED`, reopen Settings, paste the deployment
  names provided by the gateway administrator, and re-run the credential
  test.
- For OpenAI-compatible gateways such as LiteLLM, leave deployment names
  empty and re-run the credential test after confirming the model list
  endpoint is reachable from the host.
- If the smoke call succeeds in `curl` but the UI still reports
  `GATEWAY_SETUP_FAILED`, confirm the credential header value. Supported
  header names are `authorization`, `x-litellm-key`, `x-api-key`, and
  `api-key`. Choose the value supplied by the gateway operator.
- Review the gateway-side authorisation policy for the token if a single
  model is consistently rejected; Keiko persists only models that pass
  the smoke call.

---

### 5. API responses return `NO_MODEL`

| Field             | Value                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| Severity          | High                                                                    |
| Surface           | Run engine, chat handlers                                               |
| Stable identifier | `{ "code": "NO_MODEL", "message": "No model provider is configured." }` |

**Symptom**

The UI shows a banner that no model is available, or CLI commands that
require model access fail with the JSON body
`{ "code": "NO_MODEL", "message": "No model provider is configured." }`.
Settings does not list any selectable chat model.

**Root Cause**

The runtime model registry is empty. This happens when first-run setup
has not been completed, when the runtime configuration file has been
removed or relocated, or when every configured model was filtered out by
the smoke check during the previous setup attempt. The runtime
configuration is the single source of truth at request time; environment
variables alone do not seed the in-memory registry for the UI surface.

**Diagnostic Steps**

```bash
# Confirm Keiko can see the configuration file.
ls -l "${KEIKO_CONFIG_FILE:-$HOME/.keiko/config.json}" 2>/dev/null

# For scripted environments, verify the fallback variables are populated.
env | grep -E '^KEIKO_(DEFAULT|MODEL_)' | sed 's/=.*/=<set>/'

# Re-run the credential validation from the CLI.
npx keiko models validate
```

**Resolution**

- Open the UI, reopen Settings, and complete first-run setup with a
  valid base URL and API token. The loopback BFF will rewrite the
  runtime configuration after a successful smoke call.
- For scripted use, provide a JSON config file via `KEIKO_CONFIG_FILE`
  or `--config` as documented in the [Configuration](../../README.md#configuration)
  section.
- After updating the configuration, restart the UI so the runtime
  registry reloads:

  ```bash
  npm run keiko:stop
  npm run keiko:start
  ```

---

### 6. Local project path rejected during workspace selection

| Field             | Value                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| Severity          | Medium                                                                   |
| Surface           | Project sidebar, workspace API                                           |
| Stable identifier | `invalid_path` / `path_not_directory` / `path_not_found` / `PATH_ESCAPE` |

**Symptom**

Adding a project path in the UI fails with one of the following
messages:

- "Path is not a valid absolute local directory." (`invalid_path`)
- "That path exists but is not a directory." (`path_not_directory`)
- "No directory exists at that path." (`path_not_found`)

CLI calls that operate on a workspace return `PATH_ESCAPE` or
`WORKSPACE_NOT_REGISTERED` for paths that fail the same checks.

**Root Cause**

Keiko enforces structural path rules independent of the host filesystem
to keep the workspace boundary deterministic. The validator rejects
Windows UNC and network-share forms (`\\server\share`, `//server/share`),
Windows device paths (`\\?\C:\…`, `\\.\PhysicalDrive0`), any segment
containing `..`, remote URL forms (`http://`, `ssh://`, `file://`),
strings containing a null byte, and strings longer than 4096 characters.
After structural validation succeeds, the directory existence check is
performed against the real filesystem. The supported forms are listed in
the [Local UI guide](../ui-runbook.md#supported-project-paths).

**Diagnostic Steps**

```bash
# Confirm the path exists, is a directory, and is readable by the current user.
ls -ld "/absolute/path/to/project"

# Confirm there are no UNC, device, or remote prefixes.
printf '%s\n' "/absolute/path/to/project"
```

On Windows, prefer a native drive path such as `C:\Users\Example\Project`
over a mapped network drive or share. For Windows Subsystem for Linux,
use either the WSL POSIX form (`/home/example/project`) or the host's
drive path consistently for the duration of the session.

**Resolution**

- Provide an absolute local path that points to an existing directory
  on the host filesystem.
- For network shares, mount the share at a local drive letter or
  mount point and use the mounted path instead of the UNC form.
- Remove path traversal segments (`..`) by canonicalising the path
  before pasting it into the UI.

---

### 7. Verification or terminal command is denied or times out

| Field             | Value                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| Severity          | Medium                                                                            |
| Surface           | Terminal widget, `keiko verify`, run engine                                       |
| Stable identifier | `COMMAND_DENIED` / `CWD_OUTSIDE_PROJECT` / `TIMEOUT` / `EXECUTION_LIMIT_EXCEEDED` |

**Symptom**

A command executed from the Terminal widget or from a workflow returns
one of:

- `COMMAND_DENIED` — the requested binary or argument shape is not in
  the allowlist for the current surface.
- `CWD_OUTSIDE_PROJECT` — the working directory is not inside the
  selected project path.
- `TIMEOUT` — the command exceeded the configured wall-clock limit.
- `EXECUTION_LIMIT_EXCEEDED` — the per-session execution budget has
  been reached.

**Root Cause**

Keiko runs verification and terminal commands through an allowlist
without invoking a shell. The allowlist exists so the workspace boundary
and audited transport posture cannot be subverted by piping or by
launching arbitrary binaries. `CWD_OUTSIDE_PROJECT` enforces that all
spawned processes resolve a working directory under the registered
project root. `TIMEOUT` and `EXECUTION_LIMIT_EXCEEDED` enforce the
deterministic verification contract: a single run cannot exceed the
documented time and call budgets.

**Diagnostic Steps**

```bash
# Confirm the command would resolve to the project path.
realpath .

# Re-run the command from the project root rather than from a subshell
# whose cwd has changed.
cd "/absolute/path/to/project" && <command>
```

For `COMMAND_DENIED`, capture the exact command and arguments the UI or
workflow attempted to run; the error names the command segment that was
rejected.

**Resolution**

- For `COMMAND_DENIED`, use one of the supported workflow commands
  (`gen-tests`, `investigate`, `verify`) or invoke the package script
  directly from outside Keiko. Do not attempt to bypass the allowlist;
  the boundary is required by the
  [security and audit boundaries](../security-and-audit-boundaries.md)
  contract.
- For `CWD_OUTSIDE_PROJECT`, return to the registered project root or
  re-register the workspace at the desired path.
- For `TIMEOUT` and `EXECUTION_LIMIT_EXCEEDED`, narrow the scope of the
  run (a single package or a single test file) and rerun. Keiko's
  determinism contract does not allow silently extending these limits at
  run time.

---

### 8. Windows PowerShell blocks `npm run dev:start`

| Field             | Value                                        |
| ----------------- | -------------------------------------------- |
| Severity          | Blocker                                      |
| Surface           | Development startup, npm command wrapper     |
| Stable identifier | `PSSecurityException` / `UnauthorizedAccess` |

**Symptom**

From Windows PowerShell, `npm run dev:start` exits before the Keiko
development launcher starts. PowerShell reports that `npm.ps1` cannot be
loaded because script execution is disabled on the system, and the
exception includes `PSSecurityException` or `UnauthorizedAccess`.

**Root Cause**

PowerShell resolves `npm` to the script shim `npm.ps1` before the native
`npm.cmd` shim. On hosts with a restrictive execution policy, PowerShell
blocks that `.ps1` file before npm can execute Keiko's `dev:start`
script. This failure happens in the shell command wrapper, not in the
Keiko development server, package graph, or local UI runtime.

**Diagnostic Steps**

```powershell
# Confirm PowerShell is resolving npm to the script shim.
Get-Command npm

# Confirm the native command shim is available.
Get-Command npm.cmd

# Re-run the development start through the native shim.
npm.cmd run dev:start
```

If `Get-Command npm` points at `npm.ps1` and the original failure names
`PSSecurityException`, this entry applies. If `npm.cmd run dev:start`
starts npm but fails later during dependency install, build, port bind,
or UI health checks, continue with the entry that matches that later
error. Keiko 0.2.8 on Windows could also fail inside the launcher with
`npm.cmd ci --no-audit --no-fund failed (null)`; that was a launcher
spawn-wrapper defect, not the PowerShell execution-policy defect
described here.

**Resolution**

- Use the native npm command shim from PowerShell:

  ```powershell
  npm.cmd run dev:start
  ```

- Stop the development UI the same way when working from PowerShell:

  ```powershell
  npm.cmd run dev:stop
  ```

- Do not weaken the machine-wide PowerShell execution policy just to
  start Keiko. The `.cmd` shim preserves the existing host policy and
  still runs the same npm lifecycle script.

---

### 9. Windows dev launcher reports `npm.cmd ci ... failed (null)`

| Field             | Value                                           |
| ----------------- | ----------------------------------------------- |
| Severity          | Blocker                                         |
| Surface           | Development startup, dependency install wrapper |
| Stable identifier | `npm.cmd ci --no-audit --no-fund failed (null)` |

**Symptom**

From Windows, `npm run dev:start` or `npm.cmd run dev:start` enters the
Keiko launcher, prints the dependency install command, and exits with a
message like:

```text
[dev:start] npm.cmd ci --no-audit --no-fund
npm.cmd ci --no-audit --no-fund failed (null)
```

**Root Cause**

The development launcher invoked the Windows `npm.cmd` shim through
Node's default direct spawn path. Modern Node releases harden `.cmd`
execution, so command shims need to be launched through the platform
shell. The launcher also failed to surface `spawnSync.error`, which
collapsed the actionable spawn failure into `failed (null)`.

**Resolution**

Upgrade to a Keiko build that routes Windows npm shims through the shell
inside `scripts/dev-start.mjs`. After the fix, the same command runs the
dependency install path normally:

```powershell
npm.cmd run dev:start
```

If the dependency install itself fails after npm starts, use npm's
reported package or network error as the stable identifier; the
`failed (null)` wrapper failure no longer applies.

---

### 10. A local SQLite store was quarantined (memory vault, UI DB, or Local Knowledge)

| Field             | Value                                                            |
| ----------------- | ---------------------------------------------------------------- |
| Severity          | High                                                             |
| Surface           | Memory vault, UI/relationship DB, Local Knowledge store          |
| Stable identifier | a `*.corrupt.<timestamp>` file with a `.diagnostic.json` sidecar |

**Symptom**

Previously remembered facts, chats/relationships, or an indexed Local
Knowledge corpus appear empty after a restart, and a sibling file named
`<db>.corrupt.<timestamp>` plus `<db>.corrupt.<timestamp>.diagnostic.json`
has appeared next to the database file (for example under `~/.keiko/`).

**Root Cause**

Each store opens its SQLite database behind a shared corruption classifier
and quarantines the file **only** on confirmed corruption
(`SQLITE_CORRUPT`/`SQLITE_NOTADB`, errcode 11/26, or a failed
integrity/quick check), then boots a fresh empty store so the app still
starts. A routine app **downgrade**, a schema-version guard, `SQLITE_BUSY`
lock contention, or a migration logic error is rethrown **without**
quarantine, so a healthy store is never wiped by a transient fault. Every
real quarantine now writes an observable diagnostic sidecar
(`{ incidentId, store, timestamp, dbPath, quarantinedPath, sidecarQuarantinePaths, cause }`)
— the previous behaviour was a silent, unattributable wipe.

**Diagnostic Steps**

```bash
# Find the quarantine sidecar and read the recorded cause (errcode + message).
ls -1 ~/.keiko/*.corrupt.* 2>/dev/null
cat ~/.keiko/<db>.corrupt.<timestamp>.diagnostic.json
```

The `store` field names which store was quarantined (`memory-vault`,
`ui-db`, or `local-knowledge`); `cause.errcode` `11` or `26` confirms
genuine on-disk corruption. If no `.diagnostic.json` sidecar exists, the
store was **not** quarantined and the empty state has a different cause
(for example first-run, or a relocated data directory).

**Resolution**

- Corruption confirmed (`errcode` 11/26): the quarantined
  `*.corrupt.<timestamp>` file is preserved for forensics; you may attempt
  recovery with `sqlite3 <quarantined> ".recover"` into a new file, then
  restore it in place. The freshly booted empty store is safe to keep
  using in the meantime.
- No sidecar / empty store without a quarantine file: confirm the data
  directory (`~/.keiko/`) has not moved and that the process has read/write
  access; do not delete the live database.
- Recurring quarantine of the same store: capture the `.diagnostic.json`
  (it is already redaction-safe) and open a finding — a repeated
  quarantine indicates a hardware or filesystem fault, not a Keiko defect.

---

### 11. A request failed with an opaque 500 and a correlation id

| Field             | Value                                                                     |
| ----------------- | ------------------------------------------------------------------------- |
| Severity          | Medium                                                                    |
| Surface           | Loopback BFF (any API route), chat streaming                              |
| Stable identifier | `{ "code": "INTERNAL", "correlationId": "…" }` + `X-Keiko-Correlation-Id` |

**Symptom**

An API call or a streamed chat turn fails. The UI surfaces a generic error
carrying a copyable support id; the JSON body is
`{ "error": { "code": "INTERNAL", "message": "An unexpected error occurred.", "correlationId": "<id>" } }`
and the response carries an `X-Keiko-Correlation-Id: <id>` header. A
mid-stream chat failure arrives as an SSE `error` frame whose data includes
the same `correlationId`.

**Root Cause**

An unexpected handler error reached the BFF's top-level catch. The response
body is intentionally opaque (no stack, class name, or raw provider message
is ever surfaced to the browser), but the underlying cause is **not**
discarded: it is written — redacted — to the server's diagnostic channel,
keyed by the correlation id. The same id is honoured when the UI supplies
it, so a single id ties the browser failure to exactly one server-side
record and, for a failed model call, to the gateway request id.

**Diagnostic Steps**

```bash
# Foreground the UI to capture the structured diagnostic line, then reproduce.
npx keiko ui --port 1983 2>&1 | tee keiko-foreground.log

# Locate the operator record for the failure by its correlation id.
grep '"correlationId":"<id>"' keiko-foreground.log
grep 'keiko-server:diagnostic' keiko-foreground.log | tail -n 20
```

The diagnostic record includes `correlationId`, `source`
(`server.top-level-catch` or `chat.stream`), `operation` (method + path),
`errorClass`, the redacted `message`, and — for a gateway failure — the
`gatewayRequestId`.

**Resolution**

- Use the `errorClass` and redacted `message` in the diagnostic record to
  identify the underlying fault (for example a store error, a gateway TLS
  failure — see entry 3 — or a filesystem error). Resolve that root cause.
- When filing a finding, include the correlation id and the redacted
  diagnostic line only; the diagnostic channel is already scrubbed of known
  secrets, but review paths before sharing. Do not attach raw request or
  response bodies.
- A single `INTERNAL` 500 does not take the server down: the process
  isolates the failure and keeps serving. A **repeated** `INTERNAL` on the
  same `operation` indicates a reproducible defect worth a finding.

---

## HTML Manual Knowledge Pod refresh

Common failures and operational guidance for explicit refresh of an indexed HTML manual
Knowledge Pod are documented separately. Refer to the
[HTML Manual Knowledge Pod refresh runbook](./html-manual-pod-refresh.md) for scenarios
including crawl limit exhaustion, embedding-model incompatibility, fail-closed refresh
behaviour, and empty-crawl handling.

---

## Related documentation

- [README](../../README.md) — installation, daily use, and configuration.
- [Local UI guide](../ui-runbook.md) — UI start and stop semantics, supported project paths.
- [Security boundaries](../security-and-audit-boundaries.md) — trust boundaries that constrain resolutions in this guide.
- [Local runtime state contract](../local-runtime-state-contract.md) — files written under `.keiko/` and `~/.keiko/`.
- [Keiko Editor troubleshooting](../keiko-editor/troubleshooting.md) — Monaco workers, CSP, unsupported files, completion, and verification failures.
- [HTML Manual Knowledge Pod refresh runbook](./html-manual-pod-refresh.md) — refresh-specific troubleshooting and operational guidance.
- [Native OS file/folder dialog runbook](./native-file-dialog.md) — unsupported platforms, macOS privacy (TCC) read limits, and Windows interactive-session requirements for Browse.

For new entries, follow the [troubleshooting entry template](./_template.md).
