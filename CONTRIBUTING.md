# Contributing to Keiko

Keiko is built to a production-ready, enterprise quality bar: strict TypeScript (no `any`), tested behavior,
minimal runtime dependencies, and reviewable, evidence-backed changes. The toolchain and CI/supply-chain
rationale are recorded in the [Architecture Decision Records](docs/adr/); read them before opening a pull request.

## Local development

```bash
npm install        # install dev tooling and generate package-lock.json
npm run build      # compile src -> dist
npm test           # run the unit test suite
npm run lint       # ESLint, zero-warning policy
npm run typecheck  # type-check src + tests
```

## Pull requests

All seven required CI status checks must pass before a change can merge into `dev`:

1. `ci`
2. `actionlint`
3. `Verify pinned action SHAs`
4. `Analyze (actions)`
5. `Analyze (javascript-typescript)`
6. `Build, scan, SBOM, smoke`
7. `Review dependency diff (dev/main)`

The rationale for the CI and supply-chain security baseline is recorded in
[ADR-0002](docs/adr/README.md#adr-0002).

## Troubleshooting documentation

Operator-facing failure modes live in [`docs/troubleshooting/README.md`](docs/troubleshooting/README.md).
When adding a new entry, copy [`docs/troubleshooting/_template.md`](docs/troubleshooting/_template.md)
and follow the **Symptom**, **Root Cause**, **Diagnostic Steps**, and
**Resolution** structure. Do not include API keys, customer data,
internal endpoints, or unredacted log lines in examples.
