# Keiko

Keiko is an enterprise, model-agnostic developer-assist coding agent for regulated engineering teams.

It runs bounded, reviewable coding workflows against a configurable gateway of language models, across three surfaces: a command-line tool (`keiko`), a programmatic SDK, and a local web UI. Every change is dry-run by default and produces redacted evidence for audit. Keiko assists a developer; it does not merge code on its own.

This README is the package's only shipped document. It is self-contained and links to the repository [`docs/`](docs/) for depth.

---

## Table of contents

- [What Keiko is](#what-keiko-is)
- [Wave 1 scope](#wave-1-scope)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Build and test](#build-and-test)
- [Configuration and secrets](#configuration-and-secrets)
- [CLI usage](#cli-usage)
- [SDK usage](#sdk-usage)
- [Evidence output](#evidence-output)
- [Local UI](#local-ui)
- [Security and audit boundaries](#security-and-audit-boundaries)
- [Evaluation and Go/No-Go](#evaluation-and-gono-go)
- [Packaging](#packaging)
- [Future architecture path](#future-architecture-path)
- [Documentation index](#documentation-index)
- [Development](#development)
- [License](#license)

---

## What Keiko is

Keiko is a coding agent for teams who must show their work. It targets regulated engineering — banking, insurance, and similar — where every automated change needs a human reviewer and an audit trail.

Three properties define it:

- **Model-agnostic.** Route each task to a model that fits the work and the budget, from one config file. The gateway exposes each model's declared capabilities; the caller chooses.
- **Bounded and reviewable.** Workflows run as deterministic pipelines, not open-ended autonomy. Changes are dry-run by default and returned as a diff for human review. No change reaches a branch without a person.
- **Auditable.** Each run emits a structured, redacted evidence manifest. Credentials never enter logs, events, or evidence.

Keiko provides bounded developer assistance with measurable output and regulated reviewability. It is not a replacement for engineering judgment, and it does not claim parity with general-purpose autonomous agents.

---

## Wave 1 scope

Wave 1 is feature-complete for its defined scope. The shipped capabilities are:

- **Bounded repository context** — a redacted, byte-budgeted view of a workspace.
- **Unit-test generation** — generate a reviewable test patch for an existing source file.
- **Bug investigation** — propose a fix and a regression test for a reported symptom.
- **Safe tool and command execution** — an allowlisted, bounded command runner.
- **Verification** — run the project's gates (lint, typecheck, test, build) under resource limits.
- **Audit evidence** — redacted, durable evidence manifests with retention.
- **Local UI** — a single-user, local-only web surface for the workflows and evidence.
- **Evaluation harness** — an offline (default) or live scorecard for pilot decisions.

These are reachable from all three surfaces: the CLI, the SDK, and the local UI.

Two model kinds in the portfolio are registered but not yet callable: OCR-vision (`callOcr`) and embedding (`callEmbedding`) methods are Wave 2. See the [model capability guide](docs/pilot/model-capability-guide.md).

---

## Requirements

- Node.js >= 22 (ESM-only package)
- npm >= 10

---

## Install

```bash
npm install keiko
```

Keiko has zero runtime dependencies and ships ESM only. Use `import`, not `require`.

---

## Quick start

A dry-run pass that writes nothing: inspect context, generate a test patch, review the diff.

```bash
# 1. List the models your gateway knows about (no credentials needed)
keiko models list

# 2. Print a redacted summary of what the workspace layer would read
keiko context --dir .

# 3. Generate a unit-test patch for a source file (dry-run by default)
keiko gen-tests --file src/foo.ts
```

Step 3 prints the proposed diff and writes nothing. Review it, then re-run with `--apply` to write the test file, which triggers verification.

---

## Build and test

From a clone of the repository:

```bash
npm install
npm run build       # compile TypeScript to dist/
npm test            # run the test suite (vitest)
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run format      # prettier --write
npm --prefix ui ci --ignore-scripts  # install UI build tooling when packaging or testing the UI
```

---

## Configuration and secrets

Keiko reads model credentials from **environment variables** or a **JSON config file** — never from CLI flags. This keeps credentials out of shell history and process listings.

### Precedence

The first match wins:

1. Per-model environment variables: `KEIKO_MODEL_<UPPER_MODEL_ID>_API_KEY` / `_BASE_URL`
2. Config-file value for that model's `apiKey` / `baseUrl`
3. Global environment variables: `KEIKO_DEFAULT_API_KEY` / `_BASE_URL`

Live model surfaces (`keiko models validate`, `keiko gen-tests`, `keiko investigate`, `keiko evaluate --live`, and `keiko ui`) read a config only from `--config PATH` or `KEIKO_CONFIG_FILE`. Keiko does not implicitly trust `./keiko.config.json` from the target repository.

Provider `baseUrl` values must use `https:` unless they target `localhost` or loopback for local development.

### Per-model variables

Derive the variable name from the model id: uppercase it, then replace every non-alphanumeric character with `_`. Suffix with `_API_KEY` or `_BASE_URL`.

```
gpt-oss-120b  →  KEIKO_MODEL_GPT_OSS_120B_API_KEY
                 KEIKO_MODEL_GPT_OSS_120B_BASE_URL
```

### Global fallback

Used when neither a per-model environment variable nor a config-file value supplies the secret:

```
KEIKO_DEFAULT_API_KEY
KEIKO_DEFAULT_BASE_URL
```

Credentials are held in memory for the duration of a call and are never logged or serialized. See [`.env.example`](.env.example) for a template and [ADR-0003](docs/adr/ADR-0003-model-gateway-boundary.md) for the rationale.

---

## CLI usage

The CLI provides nine subcommands (`models`, `run`, `context`, `verify`, `gen-tests`, `investigate`, `evidence`, `evaluate`, `ui`); `models` and `evidence` each take a sub-action. Top-level `keiko --help` and `keiko --version` print usage; `keiko evaluate --help` prints its own usage. Global options:

| Option            | Effect               |
| ----------------- | -------------------- |
| `-h`, `--help`    | Show help text       |
| `-v`, `--version` | Show the CLI version |

Exit codes are consistent across commands unless noted:

| Code | Meaning       |
| ---- | ------------- |
| `0`  | success       |
| `1`  | runtime error |
| `2`  | usage error   |

### `keiko models list`

List all registered model capabilities as a table. No credentials required.

```bash
keiko models list
```

Takes no options. Prints one row per model: id, kind, cost class, latency class, tool-calling, structured-output, and use cases.

### `keiko models validate`

Validate the gateway configuration from `--config` or `KEIKO_CONFIG_FILE`. Reports structural errors without printing any configured value. Exit `0` when valid, `1` when invalid or no source is given, `2` when `--config` has no path.

```bash
keiko models validate --config ./keiko.config.json
```

| Option          | Description                                  |
| --------------- | -------------------------------------------- |
| `--config PATH` | Gateway config file (or `KEIKO_CONFIG_FILE`) |

### `keiko run`

Run a bounded, dry-run task through the agent harness against deterministic fixtures (no provider call). The task type selects the harness pipeline. A redacted evidence manifest is written by default.

```bash
keiko run explain-plan --file src/auth.ts --question "what does this do?"
keiko run generate-unit-tests --file src/add.ts --function add
keiko run investigate-bug --description "login 500 on empty password"
```

| Option                | Description                                                               |
| --------------------- | ------------------------------------------------------------------------- |
| `<task-type>`         | `explain-plan`, `generate-unit-tests`, or `investigate-bug`               |
| `--file PATH`         | Target file (required for the first two task types)                       |
| `--question TEXT`     | Question for `explain-plan`                                               |
| `--function NAME`     | Focus function for `generate-unit-tests`                                  |
| `--description TEXT`  | Bug description (required for `investigate-bug`)                          |
| `--no-evidence`       | Do not write an evidence manifest                                         |
| `--evidence-dir PATH` | Evidence directory (or `KEIKO_EVIDENCE_DIR`; default `./.keiko/evidence`) |
| `--include-reasoning` | Include redacted reasoning entries in the manifest                        |
| `--include-diff`      | Include the redacted proposed diff in the manifest                        |

For real model-backed generation and investigation, use `keiko gen-tests` and `keiko investigate`.

### `keiko context`

Print a redacted workspace context summary. Dry-run by construction: no model is called and nothing is written.

```bash
keiko context --dir .
keiko context --dir . --task "add tests" --budget 65536
```

| Option           | Description                                 |
| ---------------- | ------------------------------------------- |
| `--dir PATH`     | Workspace root (default: cwd)               |
| `--task TEXT`    | Build a context pack scoped to this task    |
| `--budget BYTES` | Context-pack byte budget (positive integer) |
| `--json`         | Emit the summary as JSON                    |

### `keiko verify`

Run the project's gates through the safe tool layer under per-command resource limits, and print a redacted summary. Exit `0` when every gate passes, `1` when a gate fails or a workspace error occurs.

```bash
keiko verify --dir .
keiko verify --only typecheck,lint --changed src/a.ts
```

| Option                  | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `--dir PATH`            | Workspace root (default: cwd)                                               |
| `--only KIND[,KIND]`    | Run only these gates: `test`, `targeted-test`, `typecheck`, `lint`, `build` |
| `--changed FILE[,FILE]` | Restrict targeted tests to these changed files                              |
| `--json`                | Emit the verification report as JSON                                        |

### `keiko gen-tests`

Generate a reviewable unit-test patch. Dry-run by default; `--apply` writes the tests and runs verification. The patch may only create or modify test files (a production-code guard rejects anything else). The model provider comes from config, never a flag. Exit `0` on a successful dry-run or apply, `1` on a rejected/cancelled/failed run or workspace error, `2` on a usage error.

```bash
keiko gen-tests --file src/add.ts --config ~/keiko/config.json
keiko gen-tests --file src/add.ts --function add --apply
keiko gen-tests --dir src/math --changed src/math/sum.ts
```

| Option                  | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `--file PATH`           | Source file to test (exactly one of `--file` / `--dir`)                     |
| `--dir PATH`            | Module directory to test (exactly one of `--file` / `--dir`)                |
| `--function NAME`       | Focus on one function (with `--file`)                                       |
| `--changed FILE[,FILE]` | Authoritative changed-file target set                                       |
| `--apply`               | Write the patch and run verification (default: dry-run)                     |
| `--model ID`            | Registered configured model id (default: cheapest capable configured model) |
| `--config PATH`         | Gateway config file (or `KEIKO_CONFIG_FILE`)                                |
| `--json`                | Emit the workflow report as JSON                                            |
| `--dir-root PATH`       | Workspace root (default: cwd)                                               |

### `keiko investigate`

Investigate a bounded bug report, then propose a minimal fix and a regression test, separating verified facts from the model's unverified hypothesis. Dry-run by default; `--apply` writes the fix and runs verification. A scope guard rejects edits to sensitive paths (version-control internals, CI config, git hooks, lockfiles). At least one evidence source is required. Exit `0` on `fix-applied`/`fix-proposed`/`investigation-only`, `1` on a rejected/cancelled/failed run or read error, `2` on a usage error.

```bash
keiko investigate --description "login returns 500 on empty password" --config ~/keiko/config.json
keiko investigate --output-file ./fail.txt --file src/auth.ts --apply
```

| Option               | Description                                                                 |
| -------------------- | --------------------------------------------------------------------------- |
| `--description TEXT` | Free-text bug description                                                   |
| `--output TEXT`      | Failing command/test output (inline)                                        |
| `--output-file PATH` | Failing output read from a file                                             |
| `--stack TEXT`       | Stack trace (inline)                                                        |
| `--stack-file PATH`  | Stack trace read from a file                                                |
| `--file PATH[,PATH]` | Suspected target file(s)                                                    |
| `--apply`            | Apply the fix and run verification (default: dry-run)                       |
| `--model ID`         | Registered configured model id (default: cheapest capable configured model) |
| `--config PATH`      | Gateway config file (or `KEIKO_CONFIG_FILE`)                                |
| `--json`             | Emit the investigation report as JSON                                       |
| `--dir-root PATH`    | Workspace root (default: cwd)                                               |

### `keiko evidence`

Inspect redacted evidence manifests written by `keiko run`, the local UI, and `keiko evaluate`. Reads only the evidence base directory. Exit `0` on success, `1` on a run id not found in the store or a read error, `2` on a usage error (including `show` with no run id).

```bash
keiko evidence list
keiko evidence show <runId>
```

| Option                | Description                                      |
| --------------------- | ------------------------------------------------ |
| `list`                | List stored manifests                            |
| `show <runId>`        | Show one manifest by run id                      |
| `--evidence-dir PATH` | Evidence directory (default `./.keiko/evidence`) |
| `--json`              | Emit as JSON                                     |

### `keiko evaluate`

Run the evaluation harness against the built-in fixtures. Offline (deterministic, no network) by default; `--live` evaluates against a configured model and fails closed when no credentials resolve. Exit `0` when every applicable dimension and surface-parity pass, `1` on a failure or runtime error, `2` on a usage error.

```bash
keiko evaluate
keiko evaluate --suite unit-tests --json
keiko evaluate --live --model gpt-oss-120b --config ~/keiko/config.json
```

| Option           | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `--suite NAME`   | `unit-tests`, `bug-investigation`, or `all` (default `all`) |
| `--fixture NAME` | Run one fixture by name (mutually exclusive with `--suite`) |
| `--live`         | Evaluate against a configured model (default: offline)      |
| `--model ID`     | Override the model id for all fixtures (live mode)          |
| `--config PATH`  | Gateway config file (or `KEIKO_CONFIG_FILE`)                |
| `--json`         | Emit the scorecard as JSON                                  |
| `--output PATH`  | Write the scorecard JSON to a file                          |

The offline suite checks workflow plumbing deterministically. It does not measure model quality. See [Evaluation and Go/No-Go](#evaluation-and-gono-go).

### `keiko ui`

Launch the local UI. The server binds to `127.0.0.1` (loopback only), prints its URL, and runs until interrupted (Ctrl+C). It serves prebuilt UI assets. The published npm package ships these assets, so `keiko ui` works immediately after install; from a source checkout, run `npm run build:ui` first.

```bash
keiko ui
keiko ui --port 4319
```

| Option                | Description                                       |
| --------------------- | ------------------------------------------------- |
| `--port PORT`         | Port to bind (default: 4319)                      |
| `--host HOST`         | `127.0.0.1` or `localhost` (default: `127.0.0.1`) |
| `--evidence-dir PATH` | Evidence directory for UI-run evidence            |
| `--config PATH`       | Gateway config file (or `KEIKO_CONFIG_FILE`)      |

See [Local UI](#local-ui) and the [local UI runbook](docs/ui-runbook.md).

---

## SDK usage

Keiko ships ESM-only with full type definitions. The package entry point re-exports the public surface; import named values from `keiko`.

`detectWorkspace` and `loadConfigFromFile` are synchronous and take a path string. The workflow functions take a `workspaceRoot` path (not a workspace object) plus a `deps` object carrying the model port.

### Workspace summary

```typescript
import { detectWorkspace, buildWorkspaceSummary } from "keiko";

const workspace = detectWorkspace(process.cwd());
const summary = buildWorkspaceSummary(workspace);
console.log(summary.name, summary.counts);
```

### Generate unit tests

```typescript
import {
  generateUnitTests,
  renderUnitTestReport,
  Gateway,
  GatewayModelPort,
  loadConfigFromFile,
} from "keiko";

const config = loadConfigFromFile("./keiko.config.json", process.env);
const model = new GatewayModelPort(new Gateway(config));

const report = await generateUnitTests(
  {
    workspaceRoot: ".",
    target: { kind: "file", filePath: "src/add.ts" },
    modelId: config.providers[0].modelId,
    // apply defaults to false: a reviewable diff, no files written
  },
  { model },
);

console.log(report.status, report.proposedDiff);
console.log(renderUnitTestReport(report));
```

### Investigate a bug

```typescript
import {
  investigateBug,
  renderBugInvestigationReport,
  Gateway,
  GatewayModelPort,
  loadConfigFromFile,
} from "keiko";

const config = loadConfigFromFile("./keiko.config.json", process.env);
const model = new GatewayModelPort(new Gateway(config));

const report = await investigateBug(
  {
    workspaceRoot: ".",
    report: { description: "login returns 500 on empty password" },
    modelId: config.providers[0].modelId,
    // apply defaults to false (dry-run)
  },
  { model },
);

// The report separates established facts from the model's unverified hypothesis.
console.log(report.verified, report.hypothesis);
console.log(renderBugInvestigationReport(report));
```

### Run verification

`runVerification` takes a plan. Build it from the detected workspace and its script catalog.

```typescript
import {
  detectWorkspace,
  detectScripts,
  buildVerificationPlan,
  runVerification,
  buildVerificationSummary,
} from "keiko";

const workspace = detectWorkspace(process.cwd());
const catalog = detectScripts(workspace);
const plan = buildVerificationPlan(workspace, catalog, {});

const report = await runVerification(plan, { workspace });
console.log(buildVerificationSummary(report));
console.log(report.overallStatus); // "passed" when every gate passed
```

### Inspect evidence

`listEvidence` and `loadEvidence` are synchronous. The loaded data is redacted by construction.

```typescript
import { createNodeEvidenceStore, listEvidence, loadEvidence } from "keiko";

const store = createNodeEvidenceStore("./.keiko/evidence");

for (const entry of listEvidence(store)) {
  console.log(entry.runId, entry.taskType, entry.outcome, entry.finishedAt);
}

const manifest = loadEvidence(store, "the-run-id");
if (manifest !== undefined) {
  console.log(manifest.evidenceSchemaVersion);
}
```

### Drive a workflow with a scripted model

`createScriptedModelPort` builds a `ModelPort` that replays a fixed transcript, so you can exercise a workflow deterministically with no live model or credentials. It satisfies the same `deps.model` seam the workflows use.

```typescript
import { createScriptedModelPort, generateUnitTests, type NormalizedResponse } from "keiko";

const response: NormalizedResponse = {
  modelId: "scripted",
  content: "--- a/src/add.test.ts\n+++ b/src/add.test.ts\n+// generated test\n",
  finishReason: "stop",
  toolCalls: [],
  structuredOutput: null,
  usage: {
    requestId: "scripted",
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 1,
    costClass: "low",
  },
};

const model = createScriptedModelPort([response]);

const report = await generateUnitTests(
  { workspaceRoot: ".", target: { kind: "file", filePath: "src/add.ts" }, modelId: "scripted" },
  { model },
);
console.log(report.status);
```

For the full offline scorecard, run `keiko evaluate` (see [Evaluation and Go/No-Go](#evaluation-and-gono-go)).

`SDK_VERSION` is exported for diagnostics. `--version` on the CLI reports the same value.

---

## Evidence output

`keiko run`, workflow runs launched from the local UI, and `keiko evaluate` (offline and live) persist an `EvidenceManifest`. `keiko gen-tests` and `keiko investigate` print a reviewable report but do not persist an evidence manifest; `keiko verify` and `keiko context` are read-only summaries that persist nothing. Manifests are **redacted at construction** — secret-shaped strings, environment values, and known literal credentials are removed before anything is written. There is no code path that writes an unredacted manifest.

Manifests are written with an exclusive-create (`O_EXCL`) open into a directory whose real path is verified to be inside the evidence root. The default location is `$KEIKO_EVIDENCE_DIR` or `.keiko/evidence` under the workspace.

Retention keeps the newest runs up to a maximum (`DEFAULT_RETENTION`, 50 runs). Every manifest carries a stable `EVIDENCE_SCHEMA_VERSION`; readers reject unknown versions rather than guessing.

Inspect manifests with `keiko evidence list` and `keiko evidence show <runId>`. See [ADR-0010](docs/adr/ADR-0010-audit-ledger-and-evidence-manifests.md).

---

## Local UI

`keiko ui` serves a single-user web surface for the workflows and evidence. It binds to `127.0.0.1` by default, checks `Host` and `Origin` headers to block DNS-rebinding, serves a strict Content-Security-Policy, and renders only redacted views. The apply action uses the same gated, dry-run-default path as the CLI.

The server runs until you interrupt it (Ctrl+C). For setup, surfaces, and troubleshooting, see the [local UI runbook](docs/ui-runbook.md).

Multi-user access, authentication, and remote hosting are out of scope for Wave 1.

---

## Security and audit boundaries

Keiko's boundaries are explicit, and so are their limits. In summary:

- **Workspace access** is confined to the workspace root by a lexical and real-path check; secret-shaped files are always denied.
- **Command execution** runs an allowlist with no shell interpretation, an ephemeral HOME, and resource ceilings.
- **Patches** are dry-run by default and guarded by path scope; applying requires an explicit opt-in and is followed by verification.
- **The UI** is local-only with DNS-rebinding defense and a strict CSP.
- **No unattended merge.** A human reviews every change. This is a hard invariant of the pilot.

Wave 1 is **not** OS-level isolation. Allowlisted project scripts (for example `npm test`) can run repository-authored code; the boundary protects the host outside the workspace, not the workspace from itself. For the full picture and the explicit limitations, read [Security and audit boundaries](docs/security-and-audit-boundaries.md).

---

## Evaluation and Go/No-Go

`keiko evaluate` produces a scorecard, not a verdict. The Wave 1 pilot decision is made by people, using the scorecard plus run evidence.

- Offline (`keiko evaluate`) checks workflow plumbing deterministically against scripted responses. It does not measure model quality.
- Live (`keiko evaluate --live`) runs the same suite against a configured model endpoint.

See [Go/No-Go criteria](docs/pilot/go-no-go.md) and the [model capability guide](docs/pilot/model-capability-guide.md).

---

## Packaging

The published tarball ships only `dist/`, `README.md`, and `LICENSE` (the `files` allowlist). Repository docs stay in the repository. A surface check (`npm run check:package-surface`) runs in the `prepack` and `prepublishOnly` chains and asserts the built CLI, SDK, type declarations, and UI assets ship while source, UI source maps, `.env` files, and docs do not.

Keiko has zero runtime dependencies. Supply-chain review is covered by the CI dependency-review job, CodeQL, root/UI audit steps, and SBOM builds. Inspect the surface with:

```bash
npm pack --dry-run
```

Publishing the package is out of scope for Wave 1. See [npm packaging](docs/npm-packaging.md).

---

## Future architecture path

Wave 1 is npm-first and TypeScript-first: a CLI, an SDK, and a local UI that run on a developer machine or a CI runner with no managed control plane. This keeps the pilot's footprint small and its trust boundary local.

A later phase may add a cloud-native backend for teams that want shared evaluation, central evidence, or larger workloads. If it does, the CLI and UI stay lightweight local clients; the local-first path remains supported. Multi-user access, authentication, and a hosted UI are explicitly out of scope for Wave 1.

---

## Documentation index

Repository documentation (not shipped in the package):

| Document                                                               | Audience                            |
| ---------------------------------------------------------------------- | ----------------------------------- |
| [Customer pilot runbook](docs/pilot/runbook.md)                        | Pilot teams, evaluators, reviewers  |
| [Go/No-Go criteria](docs/pilot/go-no-go.md)                            | Pilot sponsors, leads, review board |
| [Model capability guide](docs/pilot/model-capability-guide.md)         | Pilot evaluators, operators         |
| [Security and audit boundaries](docs/security-and-audit-boundaries.md) | Security and regulated reviewers    |
| [Local UI runbook](docs/ui-runbook.md)                                 | UI operators and reviewers          |
| [npm packaging](docs/npm-packaging.md)                                 | Release engineers                   |

Architecture Decision Records live in [`docs/adr/`](docs/adr/).

---

## Development

```bash
npm install
npm run build
npm test
npm run lint
npm run typecheck
npm run format
```

Contributions follow the delivery standard in [`CONTRIBUTING.md`](CONTRIBUTING.md): strict TypeScript, tested behavior, conventional commits with an issue number, and reviewable, evidence-backed changes.

---

## License

Apache-2.0. See [`LICENSE`](LICENSE).
