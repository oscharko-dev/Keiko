# Keiko Wave 1 UI Pilot Operations Runbook

**Audience:** Development teams and pilot customers running Keiko's locally hosted UI.

**Status:** Wave 1 foundation. The UI is a first-class surface alongside the CLI and SDK. This runbook covers launch, runtime requirements, local-only security posture, and accessibility baseline. The full pilot operations runbook (issue #12) is not yet shipped; when it lands, this content will be cross-referenced.

## Overview

The Keiko UI is a locally hosted Next.js application served by a Node backend (BFF). It lets you launch workflows, observe runs live from the harness event stream, review and approve patches, browse evidence manifests, and inspect model configuration—without terminal interaction. The BFF consumes the same audited harness layer as the CLI and SDK, so the UI is subject to the same dry-run-first discipline and security controls.

The UI binds `127.0.0.1` only (never the public interface) and never contacts external services except the configured model endpoints (which only the harness reaches, never the browser). Secrets are redacted before reaching the browser, evidence is redacted on disk, and there is one gated write path for applying patches.

## Prerequisites

**Node.js:** version 22 or later (stated in `package.json#engines`).

**npm:** version 10 or later.

**Browser:** any modern Chromium, Firefox, or Safari (current version). The UI uses standard DOM APIs with no browser-specific dependencies.

**Model gateway configuration:** a configured model provider is required to run workflows. Without it:

- The UI loads and all read surfaces (config inspector, evidence browser, workflow descriptors) work.
- Launching a run returns a clear error: "No model configured."

Configure the gateway via:

- A JSON file passed with `keiko ui --config <path>`, or
- The `KEIKO_CONFIG_FILE` environment variable, or
- Per-model environment variables (`KEIKO_MODEL_<UPPER_ID>_API_KEY` and `_BASE_URL`), or
- Global fallback variables (`KEIKO_DEFAULT_API_KEY` and `_BASE_URL`).

See the [main README](../README.md#configuration-and-secrets) for the full precedence and variable names.

## Building UI assets

The npm-published package includes the built UI assets, so `keiko ui` works directly after install. If you're building from source:

```bash
npm run build    # Compile src/ -> dist/ (includes src/ui/**, the BFF)
npm run build:ui # Build the Next.js static export and copy into dist/ui/static/
```

Both commands run automatically during `npm pack` (via `prepack`). The result:

- `dist/ui/static/` — the static HTML/CSS/JS export
- `dist/ui/csp-hashes.json` — precomputed inline-script hashes for Content-Security-Policy

The `build:ui` script performs an offline `npm ci` in the nested `ui/` package, builds the static export, and verifies the CSP hashes are present before copying assets into the root package. No external network is contacted.

## Launching the UI

Start the server with one command:

```bash
keiko ui
```

The server binds to `127.0.0.1:4319` by default and prints:

```
Keiko UI listening on http://127.0.0.1:4319
```

Open that URL in your browser. Stop the server with Ctrl-C (SIGINT).

### Flags

All flags are optional:

- `--port <number>` — listen on a different port (default `4319`). Must be between 1 and 65535.
- `--host 127.0.0.1|localhost` — choose the loopback host (default `127.0.0.1`). Only loopback addresses are allowed; the server never binds `0.0.0.0`.
- `--config <path>` — path to a gateway config file (JSON). Takes precedence over environment variables.
- `--evidence-dir <path>` — custom directory for evidence manifests. Defaults to `$KEIKO_EVIDENCE_DIR` or a `.keiko/evidence` subdirectory in the detected workspace.

Example:

```bash
keiko ui --port 8080 --config ~/keiko.json --evidence-dir /tmp/runs
```

## Local-only operation and security posture

**Binding:** The server binds `127.0.0.1` exclusively and rejects all non-loopback requests. There is no `0.0.0.0`, no public interface, and no multi-user mode.

**Host/Origin check (DNS-rebinding defense):** Every request must have a `Host` header naming `127.0.0.1`, `localhost`, or `[::1]` on the bound port. Requests from other origins are rejected with a `403 Forbidden` response.

**Content-Security-Policy:** The server sets a strict CSP on every response:

- `script-src 'self'` — only scripts from the same origin, no inline scripts or `eval`.
- `style-src 'self' 'unsafe-inline'` — stylesheets from the same origin plus Tailwind's injected styles.
- Other sources (`img-src`, `font-src`, `connect-src`) are restricted to same-origin only.
- No external CDNs, no Google Fonts, no remote APIs.

**Secrets and redaction:**

- Config is presented through `toSafeObject`, which strips API keys. What you see in the config inspector is stripped; keys never reach the browser.
- Live payloads (run reports, workflow projections, error messages) are redacted using the same `redact()` function that scrubs configured secret patterns and environment variable values.
- Evidence manifests are redacted at rest (when persisted to disk) and served as-is; no further redaction is applied.
- Live events from the harness are redacted by the harness emitter before the BFF sees them. The BFF does not retain raw event content.

**Dry-run-first discipline:**

- Launching a workflow always runs in dry-run mode first. The run produces a proposed patch and a verification preview but does not write any files.
- To apply the patch, you must explicitly review the proposed diff and click the apply button. This is the only write path; it re-runs the workflow with `apply: true` through the existing gated pipeline.
- The BFF does not reimplement, relax, or bypass workflow guards (path traversal checks, patch limits); it invokes the same audited workflows the CLI uses.

## The six surfaces

**Workflow launch** — Forms for starting a workflow. You select a workflow type (unit-test generation, bug investigation), pick a model from the registry, provide a target (file path or directory), set optional limits, and review the dry-run preview. Model selection uses the same registry the CLI consumes; cost class and latency estimates are available.

**Live run view** — Real-time progress as the run executes. Shows model calls (with token usage and cost class), tool invocations (command, exit code, output), verification results (resource limits, pass/fail decisions), and reasoning traces. You can cancel an in-flight run by clicking the cancel button. Cancellation is asynchronous; the stream closes after the run reaches a terminal state.

**Patch review** — After a dry-run, a unified diff viewer shows the proposed changes, affected file paths, and validation outcomes (linting errors, boundary violations, etc.). An explicit apply action (with confirmation) applies the patch and re-runs verification. The result is shown inline; you can then review the evidence.

**Evidence browser** — Filterable list of all past runs (by workflow, model, outcome, date). Clicking a run loads the full evidence manifest: usage totals, config fingerprint, verification status, optional reasoning trace, and the git-readable diff (if generated). Evidence is redacted on disk and served as-is to the UI.

**Config and model inspector** — View the active gateway configuration (no API keys shown), the full model capability registry with cost class and latency bounds, and the configured limits for workflows. No secrets are displayed.

**Run cancellation (integrated into live view)** — A cancel button appears while a run is in progress. Click it to send a cancellation signal to the harness. The UI updates when the run reaches a terminal state.

## Evidence and audit

When you launch a workflow from the UI (even in dry-run mode), the BFF creates and persists a redacted evidence manifest to disk. The manifest includes:

- Workflow type and inputs
- Model ID and usage (tokens, cost)
- Verification results and resource limits
- The proposed diff (if applicable)
- Reasoning trace (if generated)
- Config fingerprint and timestamp

The manifest is redacted before persistent: API keys, literals matching configured secrets, and sensitive environment values are scrubbed.

**Wave 1 limitation (documented follow-up):** When you click apply in the UI, the proposed patch is re-run through the workflow engine and the result is returned to you in the browser. This result is not separately persisted as its own evidence manifest in Wave 1. Only the initial dry-run is recorded in evidence. Full apply-run evidence persistence is a documented issue #10 follow-up and will ship in a future wave.

You can always export the final report shown in the patch-review surface manually, or consult the evidence browser to see all persisted dry-runs.

## Accessibility status

The Wave 1 UI meets **WCAG 2.2 AA** guidelines:

- **Keyboard operation:** All primary actions (launch, subscribe to run updates, cancel, review, apply, browse evidence) are reachable and operable via Tab, Enter, Space, and Escape.
- **Semantic landmarks:** Pages use `<header>`, `<nav>`, `<main>`, and region landmarks with accessible names. A skip-to-main-content link is available on focus.
- **Focus management:** Focus moves predictably on route changes and when opening modals or detail views.
- **Contrast:** Text and meaningful UI elements meet AA contrast ratios. Design tokens ensure consistent sizing and spacing.
- **Live regions:** Status updates (e.g., "Run started", "Patch applied") are announced to screen readers via ARIA live regions.

The UI passed:

- An **axe-core CI gate** (zero critical violations reported by automated scanning).
- A **manual keyboard and screen-reader review** by an accessibility specialist.

Axe-core covers automatable accessibility rules (roughly 30–50% of WCAG). The manual review covers keyboard navigation, focus order, screen-reader compatibility, and edge cases. Full details of the manual review and any recommendations are documented in the pilot report (issue #12, when shipped).

## CI and verification

The UI is built and tested in a dedicated, offline `ui` job:

```
npm --prefix ui ci           # Install ui/ dependencies (offline, from ui/package-lock.json)
npm --prefix ui run lint     # ESLint + a11y rules
npm --prefix ui run typecheck # Type-check (DOM-aware TypeScript)
npm --prefix ui run build    # Static export
npm --prefix ui run test     # Component and smoke tests (jsdom, no browser download)
keiko ui (health smoke)      # Start the server and poll /api/health
```

All tests run offline with no external network. No browser is downloaded. Accessibility is verified via `jest-axe` and `axe-core` running in jsdom, plus a real HTTP startup test.

The `ui` job is a required branch-protection check (in addition to the seven existing checks). It must pass before any merge to `dev`.

## Troubleshooting

### UI assets not found

Error:

```
keiko ui: UI assets not found at .../dist/ui/static. Run `npm run build:ui` first.
```

**Fix:** Run:

```bash
npm run build && npm run build:ui
```

This compiles the BFF and builds the Next.js static export. Both must complete before launching.

### Blank page or CSP errors in console

The browser console shows:

```
Refused to load the script because it violates the Content-Security-Policy directive: "script-src 'self'".
```

**Cause:** The static export was not built correctly, or the CSP hashes file is missing.

**Fix:**

1. Verify `dist/ui/static/` exists and contains `index.html`.
2. Verify `dist/ui/csp-hashes.json` exists and is valid JSON.
3. If either is missing, run `npm run build:ui` again.

### Runs error with "No model configured"

You try to launch a workflow and see:

```json
{
  "error": {
    "code": "NO_MODEL_CONFIGURED",
    "message": "No model configured. Provide a gateway config via --config or environment variables."
  }
}
```

**Fix:** Configure the model gateway:

1. Create a `keiko.json` file with your model provider credentials:

   ```json
   {
     "providers": [
       {
         "modelId": "claude-opus",
         "apiKey": "sk-...",
         "baseUrl": "https://api.anthropic.com"
       }
     ]
   }
   ```

2. Start the UI with the config file:

   ```bash
   keiko ui --config ./keiko.json
   ```

   Or set the environment variable:

   ```bash
   export KEIKO_CONFIG_FILE=./keiko.json
   keiko ui
   ```

See the [main README](../README.md#configuration-and-secrets) for the full precedence and available environment variables.

### Server starts but browser cannot connect

**Cause:** A firewall or network policy is blocking `localhost:4319`.

**Fix:**

- On the local machine, `http://127.0.0.1:4319` should always work.
- If you see a "connection refused" error, ensure the port is not already in use.
- If you changed the port with `--port`, use the correct port in the browser URL.

### Timeout or very slow responses

The server has conservative timeouts (30 seconds for a full request, 10 seconds for headers). Long-running workflows may timeout. This is by design to prevent stuck connections from holding resources indefinitely on a shared system.

If a run times out, cancel it and try again. Evidence is persisted even on timeout, so you can inspect partial results in the evidence browser.

## Relationship to issue #12

Issue #12 is the **dedicated pilot customer runbook**, which will provide end-to-end guidance for running Wave 1 workflows in a pilot environment, including:

- Multi-day pilot setup and team coordination
- Incident response and escalation
- Evidence retention and audit controls
- Feedback collection and iteration

This document (**#13 runbook**) provides the **UI operations content** and should be folded into or cross-referenced by the #12 runbook when it ships. For now, use this guide to launch and operate the UI, and refer to the [main README](../README.md) for CLI/SDK usage and configuration.

## Further reading

- [ADR-0011: Wave-1 User Interface and Packaging](./adr/ADR-0011-wave-1-user-interface-and-packaging.md) — Architecture, design decisions, and the BFF API contract.
- [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/) — Accessibility standard.
- [Main README](../README.md) — CLI commands, SDK usage, gateway configuration.
