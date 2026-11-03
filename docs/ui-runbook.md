# Local UI Guide

This guide covers the local Keiko UI used by end users.

## Start and Stop

After installing Keiko in a project, run the project-local binary:

```bash
npm install -D @oscharko-dev/keiko
npx keiko init
npm run keiko:start
```

`npx keiko init` is valid only after `@oscharko-dev/keiko` has been installed
in the project. The npm package name is scoped; `keiko` is the binary exposed by
that package.

Prefer the local `npm run keiko:start` script or a package-manager equivalent in IDE run
configurations. Do not point WebStorm or Windows terminal shortcuts at a bare global `keiko`
binary when validating a freshly pulled checkout; an older global install on `PATH` can start a
stale UI build instead of the project-local package.

Open:

```text
http://127.0.0.1:1983
```

Stop:

```bash
npm run keiko:stop
```

The default port is `1983`. Override it with `KEIKO_UI_PORT` or `keiko start --port <port>`.

The UI runs on loopback only. The `--host` option can validate a loopback host value; the server always binds `127.0.0.1`.

Keiko sets the runtime process title and supported child-process launch metadata to `Keiko`.
On Windows, npm-based launches still execute through Node.js, so Task Manager surfaces that use
the executable image name can continue to show `node.exe` until Keiko ships a native Windows
launcher executable. Process-manager surfaces that read the process title or original argv label
should show `Keiko`.

## First-Run Setup

When Keiko has no model gateway configuration, Settings asks for:

- Base URL, for example `https://llm-gateway.example.com/v1`
- API token
- Optional API-key header, only when your gateway admin provides a custom header
- Deployment names, only when the gateway cannot expose a reliable model list

Supported credential headers are `authorization`, `x-litellm-key`, `x-api-key`, and `api-key`.

Keiko tests the credentials immediately. It lists available models from the gateway, uses LiteLLM-style model metadata when available, performs a small chat-completions smoke test, and saves only callable chat models in the local runtime configuration.

For OpenAI-compatible gateways such as LiteLLM, usually leave deployment names empty. For Azure AI Foundry, paste the deployment names you want Keiko to offer in the UI.

Environment variables are still supported for scripted starts. They are not a standalone UI configuration source when the UI needs to discover models for a first-time user.

If no provider is available, API responses use:

```json
{
  "code": "NO_MODEL",
  "message": "No model provider is configured."
}
```

## MCP tool servers

Open **Settings → MCP** to configure tool servers once for Chat and the Coding Workbench.
The overview shows each saved server, its connection state and its discovered tool count.
Use **Check connection** to reconnect or refresh discovery. An enabled entry is available to
new turns only after its connection and tools have been validated.

### Add a server

Choose **Add MCP server** and enter a unique name using lowercase letters, numbers, `-` or `_`.
Select the connection type provided by the server's operator:

- **HTTPS:** enter the actual MCP endpoint. An ordinary REST API URL is not an MCP endpoint.
  Enter a Bearer token or personal access token if that MCP endpoint requires it. For a server
  on the company network, select **Server on a private network**. Its TLS certificate must still
  be valid and trusted; the operator can provide the company CA through `KEIKO_CA_BUNDLE_PATH`
  before starting Keiko. Select **Legacy HTTP + SSE** only when the server provides that transport.
- **Local process:** enter the executable's absolute path and one argument per line. Import a
  `.env` file if the server needs provider credentials. The variable names must match that
  server's configuration. Keiko stores the imported secrets in its sealed local credential store
  and supplies them to that server; it does not execute the `.env` file as a shell script.

Choose **Save and connect**. **Connected** and a tool count confirm that Keiko completed discovery.
A token that the MCP server uses to reach a downstream service belongs in that server's own
configuration. It is separate from a Bearer token used to authenticate Keiko to an HTTPS MCP endpoint.

### Manage connections

| Action                                | Result                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Edit**                              | Change the saved connection. Leaving the token field empty retains its current token. Changing a credentialed endpoint or local command requires credentials for the new destination. |
| **Disable**                           | Keep the configuration while making its tools unavailable.                                                                                                                            |
| **Enable**, then **Check connection** | Revalidate the saved connection and discover its tools.                                                                                                                               |
| **Remove**                            | After confirmation, remove that connection and its stored credentials. Other servers remain configured.                                                                               |

Configuration or credential changes invalidate earlier tool authority and pending approvals.
If another window changed Settings, reload the overview before submitting again. A failed refresh
does not turn the form into a disabled page or count an old connection as currently verified.

### Use tools

Select a model with verified tool-calling support in the existing model gateway. In Chat, request
the action normally; the first MCP read asks for permission to send the returned data to the model
and retain it in that conversation. Writing follows the conversation's selected autonomy mode and
any narrower deployment policy. The Coding Workbench uses the same configured servers with its
own task authority and approval cards. Review and approve an action in the surface that requested it.

Tool results and approvals remain part of their conversation or coding task. If a write loses its
response, check the remote result before starting another action. A Coding Workbench task marked
**Recovery required** retains that state after reload; Keiko does not automatically retry the
uncertain mutation.

## Using the UI

1. Add a local project path.
2. Select a configured chat model.
3. For coding agents, select **Ask for approval**, **Supervised workspace**, or **Full access** and
   confirm the bounded task and Authority Envelope.
4. Use chat for repository questions.
5. Use workflows for generated tests, bug investigation, plan explanation, or verification.
6. Review proposed diffs when policy requires approval; inspect directly applied agent changes in
   the Changes and recent-agent-actions surfaces before delivery.
7. Review evidence before using it in delivery material.

**Ask for approval** allows reads and planning and asks before workspace edits, commands,
external-file, internet, or delivery actions. **Supervised workspace** allows routine
workspace-contained edits, vetted commands, and verification and asks before high/critical-risk
contained work and every external-file, internet, or delivery action. **Full access** allows file
and internet work inside the validated Authority Envelope without per-action approval. Delivery
remains separately human-approved in all three modes, and hard denials always win.

Keiko selects only configured chat models that pass the gateway smoke test. Non-chat models are not offered for chat or workflow execution.

## Local Files

| Path                   | Purpose                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `.keiko/ui.pid`        | Background UI process id.                                                                          |
| `.keiko/logs/`         | Redacted Activity Log segments. Read them with `keiko support export` and `keiko support analyze`. |
| `.keiko/evidence/`     | Project-local evidence when configured for the workspace.                                          |
| `~/.keiko/keiko-ui.db` | Local UI state database.                                                                           |

Keep `.keiko/`, runtime config files, and API tokens out of version control.

## Supported Project Paths

Keiko accepts existing local directories on Windows, macOS, and Linux as project roots. Native Windows drive paths such as `C:\Users\Example\Project` and POSIX absolute paths such as `/home/example/project` are both supported. The following forms are rejected with a stable `invalid_path` error:

- Windows UNC and network-share forms such as `\\server\share` or `//server/share`.
- Windows device paths such as `\\?\C:\…` or `\\.\PhysicalDrive0`.
- Path traversal segments (`..`) in any position.
- Remote URL forms such as `http://`, `ssh://`, or `file://`.
- Strings containing a null byte or exceeding 4096 characters.

Path validation is host-independent for these structural rules; the directory existence check is performed against the host filesystem.

## Troubleshooting

| Symptom                | Check                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| UI is not reachable    | Run `keiko status`, then `keiko support analyze` on a `keiko support export` report. |
| Port conflict          | Stop the conflicting process or start Keiko with another port.                       |
| No model appears       | Re-run Settings credential test and confirm the gateway exposes chat models.         |
| Credential test fails  | Confirm the base URL points to an OpenAI-compatible API and that the token is valid. |
| Custom proxy key fails | Confirm whether your gateway expects `Authorization` or a custom API-key header.     |
| Stop does not clean up | Ensure the process is gone, then remove `.keiko/ui.pid` and start again.             |

For a longer, categorised playbook covering TLS trust failures, first-run
gateway setup outcomes, the `NO_MODEL` response, workspace path
validation, and the run-engine command allowlist, see the
[Troubleshooting guide](troubleshooting/README.md).
