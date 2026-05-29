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

## Development

```bash
npm install        # install dev tooling and generate package-lock.json
npm run build      # compile src -> dist
npm run typecheck  # type-check src + tests
npm run lint       # ESLint, zero-warning policy
npm test           # run the unit test suite
```

All seven required CI checks must pass before a change can merge into `dev`. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [docs/adr/](docs/adr/) for the delivery standard and architecture
decisions.

## License

Licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 oscharko-dev
