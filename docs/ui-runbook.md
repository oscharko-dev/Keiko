# Local UI Guide

This guide covers the local Keiko UI used by end users.

## Start and Stop

After installing Keiko in a project, run:

```bash
npx keiko init
npm run keiko:start
```

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

## Using the UI

1. Add a local project path.
2. Select a configured chat model.
3. Use chat for repository questions.
4. Use workflows for generated tests, bug investigation, plan explanation, or verification.
5. Review proposed diffs before applying them.
6. Review evidence before using it in delivery material.

Keiko selects only configured chat models that pass the gateway smoke test. Non-chat models are not offered for chat or workflow execution.

## Local Files

| Path                   | Purpose                                                   |
| ---------------------- | --------------------------------------------------------- |
| `.keiko/ui.pid`        | Background UI process id.                                 |
| `.keiko/ui.log`        | Local UI process log.                                     |
| `.keiko/evidence/`     | Project-local evidence when configured for the workspace. |
| `~/.keiko/keiko-ui.db` | Local UI state database.                                  |

Keep `.keiko/`, runtime config files, and API tokens out of version control.

## Troubleshooting

| Symptom                | Check                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| UI is not reachable    | Run `keiko status` and inspect `.keiko/ui.log`.                                      |
| Port conflict          | Stop the conflicting process or start Keiko with another port.                       |
| No model appears       | Re-run Settings credential test and confirm the gateway exposes chat models.         |
| Credential test fails  | Confirm the base URL points to an OpenAI-compatible API and that the token is valid. |
| Custom proxy key fails | Confirm whether your gateway expects `Authorization` or a custom API-key header.     |
| Stop does not clean up | Ensure the process is gone, then remove `.keiko/ui.pid` and start again.             |
