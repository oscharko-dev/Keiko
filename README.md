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

## SDK usage

```ts
import { SDK_VERSION, type AgentConfig } from "keiko";

console.log(SDK_VERSION); // "0.1.0"

const config: AgentConfig = {
  model: "your-model-id",
  workingDirectory: process.cwd(),
};
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
