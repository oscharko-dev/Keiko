# Keiko Wave 1 UI Pilot Operations Runbook

**Audience:** Development teams and pilot customers running Keiko's locally hosted UI.

**Status:** Wave 1 foundation. The UI is a first-class surface alongside the CLI and SDK. This runbook covers launch, runtime requirements, local-only security posture, and accessibility baseline. The end-to-end pilot operations runbook is the [customer pilot runbook](./pilot/runbook.md); it cross-references this document for UI operation.

## Overview

The Keiko UI is a locally hosted Next.js application served by a Node backend (BFF). It lets you launch workflows, observe runs live from the harness event stream, review and approve patches, browse evidence manifests, and inspect model configuration—without terminal interaction. The BFF consumes the same audited harness layer as the CLI and SDK, so the UI is subject to the same dry-run-first discipline and security controls.

The UI binds `127.0.0.1` only (never the public interface) and never contacts external services except the configured model endpoints (which only the harness reaches, never the browser). Secrets are redacted before reaching the browser, evidence is redacted on disk, and there is one gated write path for applying patches.

## The workspace shell

Opening `/` or `/launch` in the browser displays the dark, Keiko-branded workspace shell (ADR-0014). The shell is the primary surface for all local work:

- **Left sidebar** — A collapsible project list with the user's recently opened local directories. An in-UI "Add project" flow lets you enter a validated absolute local path to begin a new chat session in that workspace. Project-scoped chat history appears below the project list.

- **Central chat composer** — A text input with attached context. Above the text field is a registry-backed model dropdown showing only chat-capable models (vision and OCR models are excluded). The default model is `Mistral-Small-3.1-24B-Instruct-2503`. Below the text field, four explicit workflow-launch buttons let you start a specific task:
  - **Generate Tests** — automated unit test generation
  - **Investigate Bug** — root-cause analysis and patch proposal
  - **Explain Plan** — understanding and validation of a code area (read-only)
  - **Verify** — standalone verification without a workflow (BFF-only, no harness session)

- **Workspace tool entry area** — On tablet and desktop, the tools sit in the right-side rail. On mobile, the same project-bound entries remain reachable as a fixed bottom bar. The Files tool displays a bounded project tree and read-only previews through registered-project BFF routes that preserve deny-list, `.gitignore`, symlink-containment, and redaction semantics. Browser, Review, and Terminal tools are also available from this area.

**Secondary navigation** — `Config` (gateway configuration and model registry) and `Evidence` (run history and evidence manifests) are reachable from links in the shell header's secondary navigation bar, not as equal top-level surfaces.

## Prerequisites

**Node.js:** version 22 or later (stated in `package.json#engines`).

**npm:** version 10 or later.

**Browser:** any modern Chromium, Firefox, or Safari (current version). The UI uses standard DOM APIs with no browser-specific dependencies.

**Model gateway configuration:** a configured model provider is required to run workflows. Without it:

- The UI loads and all read surfaces (config inspector, evidence browser, workflow descriptors) work.
- Launching a run returns a clear error: "No model provider is configured."

Configure the gateway by providing a JSON config file:

- A JSON file passed with `keiko ui --config <path>`.

Per-model variables (`KEIKO_MODEL_<UPPER_ID>_API_KEY` and `_BASE_URL`) and global fallback variables (`KEIKO_DEFAULT_API_KEY` and `_BASE_URL`) can supply or override provider secrets referenced by that config file. They are not a standalone UI configuration source.

See the [main README](../README.md#configuration-and-secrets) for the full precedence and variable names.

## Building UI assets

The npm-published package includes the built UI assets, so `keiko ui` works directly after install. If you're building from source:

```bash
npm run build    # Compile src/ -> dist/ (includes src/ui/**, the BFF)
npm --prefix ui ci --ignore-scripts
npm run build:ui # Build the Next.js static export and copy into dist/ui/static/
```

The `prepack` and `prepublishOnly` chains run `npm run clean`, `npm run build`, `npm run ui:ci`, `npm run build:ui`, and `npm run check:package-surface`. The result:

- `dist/ui/static/` — the static HTML/CSS/JS export
- `dist/ui/csp-hashes.json` — precomputed inline-script hashes for Content-Security-Policy

The chain installs the nested `ui/` dependencies with scripts disabled before `build:ui`, then builds the static export and verifies the CSP hashes before copying assets into the root package.

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
- `--host 127.0.0.1|localhost` — validate a loopback host value for compatibility. The server always binds `127.0.0.1` and never binds `0.0.0.0`.
- `--config <path>` — path to a gateway config file (JSON) required for model-backed workflow runs.
- `--evidence-dir <path>` — custom directory for evidence manifests. Defaults to `$KEIKO_EVIDENCE_DIR` or a `.keiko/evidence` subdirectory in the detected workspace.
- `--ui-db <path>` — explicit path to the UI-local SQLite database file. Defaults to `<KEIKO_UI_DATA_DIR>/keiko-ui.db` when that environment variable is set, otherwise `~/.keiko/keiko-ui.db`. See **UI-local SQLite database** below.

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

- Config is presented through `toSafeObject`, which strips API keys and provider endpoint URLs.
  What you see in the config inspector is limited to non-sensitive provider settings; keys and
  endpoints never reach the browser.
- Live payloads (run reports, workflow projections, error messages) are redacted using the same `redact()` function that scrubs configured secret patterns and environment variable values.
- Evidence manifests are redacted at rest (when persisted to disk) and served as-is; no further redaction is applied.
- Live events from the harness are redacted by the harness emitter before the BFF sees them. The BFF does not retain raw event content.

**Dry-run-first discipline:**

- Launching a workflow always runs in dry-run mode first. The run produces a proposed patch and a verification preview but does not write any files.
- To apply the patch, you must explicitly review the proposed diff and click the apply button. This is the only write path; it re-runs the workflow with `apply: true` through the existing gated pipeline.
- The BFF does not reimplement, relax, or bypass workflow guards (path traversal checks, patch limits); it invokes the same audited workflows the CLI uses.

## Secondary surfaces reachable from the shell

**Live run view** — Real-time progress as a workflow executes. Shows model calls (with token usage and cost class), tool invocations (command, exit code, output), verification results (resource limits, pass/fail decisions), and reasoning traces. A cancel button is available to send a cancellation signal to the harness. The run stream closes asynchronously after the run reaches a terminal state.

**Patch review** — After a workflow dry-run that generates code changes, a unified diff viewer shows the proposed changes, affected file paths, and validation outcomes (linting errors, boundary violations, etc.). An explicit apply action (with confirmation) applies the patch and re-runs verification. The result is shown inline.

**Evidence browser** — Filterable list of all past runs persisted to disk (by workflow, model, outcome, date range). Clicking a run loads the full evidence manifest: usage totals, config fingerprint, verification status, optional reasoning trace, and the git-readable diff (if generated). Evidence is redacted on disk and served as-is to the UI.

**Config and model inspector** — View the active gateway configuration (no API keys shown), configured model capabilities with cost class and latency bounds, and the configured limits for workflows. No secrets are displayed.

## Known follow-ups and MVP limitations

Epic #61 (the workspace shell) is the foundation for multi-surface local interaction. The following capabilities are deferred to future work:

- **Native OS folder picker** — Projects are added by entering a validated absolute local path. A native file-picker dialog is not in the MVP (epic #61 non-goal).
- **Enterprise project-path allowlist and governance policy** — V1 validates project directories server-side (read-access checks, no write outside target). Governance policies that restrict which paths developers can open are deferred to a later governance issue.
- **Files explorer limits** — The Files tool is read-only and project-bound. It does not edit files, execute commands, expose arbitrary host paths, or preview deny-listed paths such as `.env`, `.git`, private keys, dependency folders, build output, caches, or logs.
- **Browser tool integration** — Placeholder entry point in the workspace tool area; full integration tracked in issue #76.
- **Review tool integration** — Placeholder entry point in the workspace tool area; full integration tracked in issue #77.
- **Terminal tool integration** — Placeholder entry point in the workspace tool area; full integration tracked in issue #78.
- **Optional shared workspace history for CLI/SDK** — In V1, the CLI and SDK do not read the UI SQLite database. Unified history across surfaces is deferred; CLI/SDK-accessible chat state is a follow-up.

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

## UI-local SQLite database

The UI maintains a small SQLite database for **projects** (workspace entries the developer has opened), **chats** scoped to those projects, and **chat messages** (with optional lightweight workflow references). This persistence is local to the user account running `keiko ui` and is never shared, synced, or transmitted off the machine. The database engine is Node's built-in `node:sqlite`, so no additional runtime dependency is shipped (ADR-0013).

**Location and resolution precedence.** Highest-priority first:

1. `keiko ui --ui-db <path>` — explicit file path. Tests use a `mkdtemp` path here.
2. `KEIKO_UI_DATA_DIR` environment variable. The DB file is `<KEIKO_UI_DATA_DIR>/keiko-ui.db`.
3. Default: `~/.keiko/keiko-ui.db` under the user's home directory.

The database lives under the **Keiko application data directory** and **never inside a target repository**. This is a security boundary, not a convention: a target repo's `.git/`, `.gitignore`, and `node_modules/` rules must not interact with persistence. Explicit `--ui-db` values and `KEIKO_UI_DATA_DIR` must be absolute, outside the current workspace, and not symlinked. During project onboarding, the BFF also rejects any selected project that overlaps the configured UI database path or its containing directory, even when `keiko ui` was launched outside that project. The directory is created with mode `0o700` on first run; the DB file (and its WAL/SHM sidecars) are chmodded to `0o600`. On Windows the OS-default ACL applies.

**What the database holds.** Per project: the normalized absolute path (primary key), display name, favorite flag, `created_at`/`last_opened_at` timestamps. Per chat: a UUID id, project path (FK with `ON DELETE CASCADE`), title, the selected model's **registry id only** (e.g. `Mistral-Small-3.1-24B-Instruct-2503` — never an API key, never a provider URL), optional branch label and status, timestamps. The BFF accepts only model registry entries with `kind === "chat"` for chat creation and model updates. Per chat message: a UUID id, chat id (FK with `ON DELETE CASCADE`), role (`user|assistant|system`), content, timestamp, and optional `run_id`/`workflow_id`/`workflow_status`/`short_result`/`task_type` columns (the v2 `task_type` column labels non-workflow task runs such as verify and explain-plan). The `short_result` column is truncated to 200 characters and run through the BFF redactor **before** persistence.

**What the database does NOT hold.** Provider credentials, API keys, base URLs, the full evidence manifest payloads, the full SSE event stream, reasoning traces, or any decrypted secret. Evidence manifests remain outside the UI DB in the path configured by `--evidence-dir`, `$KEIKO_EVIDENCE_DIR`, or the default workspace-local `.keiko/evidence/` directory; the UI DB only stores ids and short summaries. SQLite persistence belongs exclusively to the local UI/BFF layer. The CLI and SDK do not read or write `keiko-ui.db` in V1 (epic #61 non-goal).

**Schema and migrations.** The schema is versioned via SQLite's `PRAGMA user_version`. Migrations are forward-only and applied transactionally on first open by the migration runner in `src/ui/store/schema.ts`. A failed migration rolls back and surfaces a typed error; the database is left at the previous version. The current schema is v2: three `STRICT` tables (`projects`, `chats`, `chat_messages`) plus three indexes. V2 added an additive `task_type` column to `chat_messages` (issue #66) to label non-workflow task runs without overloading `workflow_id`. `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL` are set on every open.

**Project availability is derived, not stored.** When you delete a project's directory on disk, the row is **not** silently removed from the DB. `GET /api/projects` reports `available: false` for the missing entry so you can see and explicitly delete stale records. This avoids accidental data loss and surfaces what the UI knows.

## Accessibility status

The Wave 1 UI is designed and tested against **WCAG 2.2 AA** expectations:

- **Keyboard operation:** All primary actions (sidebar collapse and expansion, project selection, model selection, workflow-mode selection, composer submission, workspace tool entries, run cancellation, patch review, apply confirmation, and evidence browsing) are reachable and operable via Tab, Enter, Space, and Escape.
- **Semantic landmarks:** Pages use `<header>`, `<nav>`, `<main>`, and region landmarks with accessible names. A skip-to-main-content link is available on focus.
- **Focus management:** Focus moves predictably on route changes and when opening modals or detail views.
- **Contrast:** Text and meaningful UI elements meet AA contrast ratios. Design tokens ensure consistent sizing and spacing.
- **Live regions:** Status updates (e.g., "Run started", "Patch applied") are announced to screen readers via ARIA live regions.

The repository evidence currently includes automated `jest-axe` coverage, keyboard-behavior tests, focus-ring regression tests, and route-level shell integration tests. These checks cover the shell, sidebar, composer, workflow selector, model dropdown, dialogs, right-tool entry points, and secondary navigation. A real assistive-technology review is still required before making an externally certified WCAG conformance claim.

Axe-core covers automatable accessibility rules (roughly 30–50% of WCAG). Keyboard tests and browser verification cover interaction risks that axe cannot prove, while a release-grade pilot report must record any manual screen-reader findings and recommendations.

## CI and verification

The UI is built and tested in a dedicated `ui` job:

```
npm --prefix ui ci --ignore-scripts # Install ui/ dependencies from ui/package-lock.json
npm --prefix ui audit --audit-level=moderate
npm --prefix ui run lint     # ESLint + a11y rules
npm --prefix ui run typecheck # Type-check (DOM-aware TypeScript)
npm --prefix ui run build    # Static export
npm --prefix ui sbom --sbom-format cyclonedx --omit dev
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

### Runs error with "No model provider is configured"

You try to launch a workflow and see:

```json
{
  "error": {
    "code": "NO_MODEL",
    "message": "No model provider is configured."
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

## Relationship to the pilot runbook

The [customer pilot runbook](./pilot/runbook.md) is the end-to-end guide for running Wave 1 workflows in a pilot environment, covering:

- Multi-day pilot setup and team coordination
- Feedback collection and escalation
- Evidence retention and audit controls
- Evaluation and the Go/No-Go decision

This document provides the **UI operations content** the pilot runbook references. Use this guide to launch and operate the UI; use the pilot runbook for pilot-wide process, and the [main README](../README.md) for CLI/SDK usage and configuration.

## Further reading

- [Architecture decisions](./adr/README.md#adr-0011) — UI packaging and BFF boundary.
- [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/) — Accessibility standard.
- [Main README](../README.md) — CLI commands, SDK usage, gateway configuration.
