# Contributing to Keiko

The delivery standard, agent routing, and GitHub-artifact rules live in [AGENTS.md](AGENTS.md). Read it before
opening a pull request.

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
[ADR-0002](docs/adr/ADR-0002-ci-and-supply-chain-security-baseline.md).
