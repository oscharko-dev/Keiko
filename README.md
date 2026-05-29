# Keiko

Keiko is an enterprise, model-agnostic developer-assist coding agent for regulated banking and insurance
engineering workflows. **Wave 1** establishes the developer-assist MVP foundation: a TypeScript/npm package
exposing a dual command-line (`keiko`) and programmatic SDK surface, a typed module layout for the agent
runtime, and a complete CI and supply-chain security baseline. Output is designed to be model-agnostic,
explainable, evidence-backed, and developer-controlled. This wave is a foundation, not a feature-complete
product — the agent runtime, tools, workflows, and audit surfaces arrive in later waves.

## Requirements

- Node.js >= 22
- npm >= 10

## Install

```bash
npm install keiko
```

The published package has **zero runtime dependencies**.

## CLI usage

```bash
keiko --help      # print usage and exit
keiko --version   # print the version and exit
```

### Exit codes

| Code | Meaning       |
| ---- | ------------- |
| 0    | Success       |
| 1    | Runtime error |
| 2    | Usage error   |

## Model gateway

The model gateway routes requests through a capability registry instead of hard-coded model
names, and applies per-call timeout, bounded retry, and circuit-breaker controls. Every response
carries typed usage metadata (request id, prompt and completion tokens, latency, cost class).

```bash
keiko models list                      # print the capability registry (no credentials)
keiko models validate --config PATH    # validate a gateway config file
keiko models validate                  # validate config from KEIKO_CONFIG_FILE
```

`models list` prints registered model capabilities to stdout and never emits credentials.
`models validate` reports structural configuration errors to stderr without printing any
configured value; it exits `0` when the config is valid, `1` when it is invalid, and `2` on a
usage error (such as `--config` without a path).

### Configuration and secrets

Credentials are read only from environment variables or a JSON config file — never from CLI
flags. Precedence is, highest first:

1. Config file — path from `--config <path>` or the `KEIKO_CONFIG_FILE` environment variable.
2. Per-model environment variables — `KEIKO_MODEL_<UPPER_MODEL_ID>_API_KEY` and
   `KEIKO_MODEL_<UPPER_MODEL_ID>_BASE_URL`, where `<UPPER_MODEL_ID>` is the model id with every
   non-alphanumeric character replaced by `_` and uppercased.
3. Global fallback — `KEIKO_DEFAULT_API_KEY` and `KEIKO_DEFAULT_BASE_URL`.

See [.env.example](.env.example) for the full list of variable names. API keys are never logged,
serialised, or included in error messages.

## SDK usage

```ts
import { SDK_VERSION, type AgentConfig } from "keiko";

console.log(SDK_VERSION); // "0.1.0"

const config: AgentConfig = {
  model: "your-model-id",
  workingDirectory: process.cwd(),
};
```

## Repository context and workspace access

Keiko can detect your workspace, discover files through a strict boundary, and build a
redacted structured summary suitable for developer-assist context — all without sending
anything to a model.

**Always-on deny patterns** (never read, regardless of .gitignore):
`.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `id_rsa`, `*.p12`, `*.pfx`,
`.npmrc`, `node_modules/`, `dist/`, `build/`, `out/`, `coverage/`, `.cache/`, `.next/`,
`.turbo/`, `.git/`, `*.log`, `.DS_Store`.

**Workspace boundary guarantee:** every file path is resolved via `resolveWithinWorkspace`
before any read. Paths that escape the root via `..`, absolute references outside the root,
or NUL bytes throw `PathEscapeError`; symlinks whose `realpath` escapes the root are
skipped. Lexical containment is checked in `src/workspace/paths.ts`; symlink/realpath
enforcement lives at the IO edge in `src/workspace/discovery.ts` (see ADR-0005).

**`keiko context` (dry-run):** prints a human-readable or JSON redacted summary of the
workspace. No model is called; no agent session is created.

```bash
keiko context                         # detect workspace at cwd, print summary
keiko context --dir ./my-project      # specify workspace root
keiko context --task "add tests" --budget 65536  # include a context pack
keiko context --json                  # machine-readable output
```

SDK usage:

```ts
import { detectWorkspace, buildWorkspaceSummary } from "keiko";

const workspace = detectWorkspace(".");
const summary = buildWorkspaceSummary(workspace);
console.log(summary.name, summary.counts);
```

## Unit-test generation

Keiko generates a reviewable unit-test patch for existing TypeScript code. It detects the
project's test framework and naming conventions, builds a redacted context pack, calls the model
once (with bounded retries on an invalid or out-of-scope diff), validates the diff through the safe
patch boundary, and — by default — stops at a reviewable diff without touching any file. A
production-code guard rejects any patch that would modify a non-test path, so a prompt-injected
diff cannot reach your source files (see ADR-0008 D6).

**`keiko gen-tests` (dry-run by default):**

```bash
keiko gen-tests --file src/add.ts                    # propose tests for a file (dry-run)
keiko gen-tests --file src/add.ts --function add     # focus on one function
keiko gen-tests --dir src/math                        # module-level generation
keiko gen-tests --changed src/a.ts,src/b.ts           # a changed-file set
keiko gen-tests --file src/add.ts --apply             # write the tests AND run verification
keiko gen-tests --file src/add.ts --json              # emit the full report as JSON
keiko gen-tests --file src/add.ts --model MODEL_ID    # pick a registered model
keiko gen-tests --file src/add.ts --dir-root ./proj   # workspace root override (defaults to cwd)
```

Exactly one of `--file` or `--dir` is required; `--changed` composes with either. The text output
prints the proposed unified diff and the patch validation summary so you can review the generated
tests in the terminal; `--apply` writes them and runs targeted verification through the safe tool
and verification layers. Exit `0` on a successful dry-run or apply, `1` on a rejected/cancelled/
failed run or a workspace error, `2` on a usage error. The model provider is read from
`keiko.config.json` or the gateway environment variables — never from CLI flags.

SDK usage:

```ts
import { generateUnitTests, type UnitTestWorkflowReport } from "keiko";
import { GatewayModelPort, Gateway, loadConfigFromFile } from "keiko";

const config = loadConfigFromFile("./keiko.config.json", process.env);
const model = new GatewayModelPort(new Gateway(config));

const report: UnitTestWorkflowReport = await generateUnitTests(
  {
    workspaceRoot: ".",
    target: { kind: "file", filePath: "src/add.ts" },
    modelId: config.providers[0].modelId,
  },
  { model }, // apply defaults to false: a reviewable diff, no files written
);
console.log(report.status, report.proposedDiff);
```

The returned `UnitTestWorkflowReport` is plain JSON: it carries the proposed diff, the validation
preview, estimated test counts, model-generated covered-behavior / known-gaps prose, next actions,
and (in apply mode) a verification summary — all redacted. `UNIT_TEST_WORKFLOW_DESCRIPTOR` exposes
the workflow's inputs and capabilities for a UI to render without knowing the implementation.

## Development

```bash
npm install        # install dev tooling and generate package-lock.json
npm run build      # compile src -> dist
npm run typecheck  # type-check src + tests
npm run lint       # ESLint, zero-warning policy
npm test           # run the unit test suite
```

All seven required CI checks must pass before a change can merge into `dev`. See
[CONTRIBUTING.md](CONTRIBUTING.md), [docs/adr/](docs/adr/) for the delivery standard and architecture
decisions, and [docs/ui-runbook.md](docs/ui-runbook.md) for Wave 1 UI operations.

## License

Licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 oscharko-dev
