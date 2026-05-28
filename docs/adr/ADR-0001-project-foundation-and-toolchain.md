# ADR-0001: Project Foundation and Toolchain

## Status

Accepted

## Context

Keiko is an enterprise developer-assist coding agent for regulated banking and insurance engineering. Wave 1
delivers a CLI binary and a programmatic SDK from a single npm package. The package must be installable by
downstream CI/CD pipelines, embeddable as a library, and publishable to npm without additional build steps at
the consumer side.

The foundation must satisfy several competing forces simultaneously:

- **Supply-chain posture**: regulated customers audit transitive dependencies. Minimizing the runtime dependency
  graph reduces the attack surface and simplifies compliance reviews.
- **Strict typing**: `any` in TypeScript creates silent holes in the type system. A regulated product cannot ship
  with unverified data paths.
- **Module system**: Node.js is converging on ESM. A CJS-first choice today creates a dual-package hazard when
  the ecosystem completes its transition.
- **Single package, two entry points**: the `keiko` bin and the programmatic SDK share source but have different
  consumers (shell vs. TypeScript import). Both entry points must be independently usable.
- **No monorepo overhead in Wave 1**: the out-of-scope note in issue #2 explicitly defers UI build-boundary
  splitting to issue #13's ADR. Wave 1 is a single package.
- **Node.js runtime floor**: Node 20 LTS (Iron) reached end-of-life on 2026-04-30. As of 2026-05-28 only Node
  22 LTS (Jod, EOL April 2027) and later are receiving security patches. An enterprise product must not ship
  with an EOL runtime floor.

## Decision

We will structure Keiko as a **single npm package** with the following toolchain:

**Package manager**: npm 10.9.8, field `"packageManager": "npm@10.9.8"`, field `"engines": { "node": ">=22" }`.

**Module system**: `"type": "module"` (ESM). TypeScript compiler settings: `module: NodeNext`,
`moduleResolution: NodeNext`, `target: ES2022`, `strict: true`, `noUncheckedIndexedAccess: true`,
`declaration: true`, `declarationMap: true`, `sourceMap: true`, `outDir: dist`, `rootDir: src`.

**Build tool**: `tsc` only, emitting ESM + `.d.ts` to `dist/`. No bundler. The package is a Node CLI/SDK,
not a browser bundle — a bundler adds complexity without benefit here.

**Test runner**: Vitest with `environment: "node"`. Vitest understands TypeScript ESM natively, respects
`moduleResolution: NodeNext`, and runs tests without a network round-trip. `coverage` uses `v8` provider.

**Lint/format**: ESLint flat config (`eslint.config.js`) with `typescript-eslint` and
`eslint-config-prettier`. `npm run lint` enforces `--max-warnings=0`. Prettier for formatting.
`@typescript-eslint/no-explicit-any` is set to `error`.

**Runtime dependencies**: zero. The published package has no `dependencies` field. CLI argument parsing is
hand-rolled (sufficient for Wave 1: `--help`, `--version`, unknown-command). All tooling lives in
`devDependencies`.

**License**: Apache-2.0. The `"license": "Apache-2.0"` field in package.json must match the `LICENSE` file.

**CLI exit codes**: `0` success, `1` unexpected/runtime error, `2` usage error (unknown command, bad flags).
This matches POSIX convention and the npm CLI's own exit code semantics.

**Source layout**:

```
src/
  index.ts          # Package root re-export; exposes SDK surface
  cli/
    index.ts        # keiko bin entry; shebang #!/usr/bin/env node
  sdk/
    index.ts        # Typed SDK API surface (placeholder)
  harness/
    index.ts        # Future: deterministic agent harness loop
  gateway/
    index.ts        # Future: model-agnostic LLM gateway
  tools/
    index.ts        # Future: agent tool registry
  workflows/
    index.ts        # Future: named workflow definitions
  audit/
    index.ts        # Future: evidence/audit-trail producer
  evaluations/
    index.ts        # Future: deterministic output evaluator
  ui/
    index.ts        # Future: local UI integration point (see issue #13)
```

Each placeholder module exports a typed stub and carries a one-line comment naming the future issue that will
implement it. No speculative abstractions are introduced.

**package.json fields for publication**:

```json
{
  "name": "keiko",
  "version": "0.1.0",
  "type": "module",
  "license": "Apache-2.0",
  "engines": { "node": ">=22" },
  "packageManager": "npm@10.9.8",
  "bin": { "keiko": "dist/cli/index.js" },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "sideEffects": false
}
```

## Consequences

### Positive

- Zero runtime dependencies means `npm audit` has nothing to report on the published package, simplifying
  regulated-environment sign-off.
- ESM + NodeNext is the canonical modern Node.js path; no dual-package hazard, no CJS shim layer.
- `tsc` alone keeps the build observable — the emitted `.js` files are readable, the `.d.ts` files are
  accurate, and there is no bundler magic to debug.
- Vitest + TypeScript strict mode catches type errors at test-authoring time, not at runtime.
- Apache-2.0 gives enterprise customers a patent grant (absent in MIT), which legal teams in regulated
  industries typically require before approving a third-party dependency.

### Negative

- `moduleResolution: NodeNext` requires explicit `.js` extensions on relative imports in TypeScript source
  files (e.g., `import { foo } from './foo.js'`). This surprises engineers accustomed to CJS-era bare imports
  and is a common source of early confusion.
- Zero runtime dependencies means hand-rolling CLI flag parsing. The current Wave 1 surface is small enough
  that this is safe; if the CLI grows beyond 5–6 subcommands with complex flag sets, revisit by adding a
  zero-dependency parser or a minimal dependency (yargs, commander) at that time.
- `tsc` emits one file per source file. For a CLI, startup time is slightly worse than a bundled single file.
  Acceptable for a developer tool; revisit if cold-start > 200ms becomes a complaint.
- Node 22 floor (engines: >=22) means customers on Node 20 cannot install the package. Node 20 reached EOL
  on 2026-04-30; this is a deliberate choice, not an oversight.

### Neutral

- `"files"` allowlist in package.json is used instead of `.npmignore`. Both achieve the same result; `files`
  is an opt-in allowlist (safer default) while `.npmignore` is a denylist (easy to forget entries).
- `declarationMap: true` produces `.d.ts.map` files, improving IDE go-to-definition from consumer projects.
  These are included in `dist/` and published with the package.

## Alternatives Considered

### Alternative 1: pnpm as package manager

- **Pros**: strict node_modules isolation prevents phantom dependency access; faster installs; built-in
  workspace support.
- **Cons**: `corepack` is offline on the current machine and CI runner; pnpm is unavailable per confirmed
  environment constraints. Requiring a separate pnpm bootstrap step in CI adds fragility.
- **Why rejected**: environment constraint (confirmed in issue #2: pnpm unavailable). Revisit in a follow-up
  if corepack/pnpm is made available.

### Alternative 2: CommonJS (`"type": "cjs"`)

- **Pros**: wider ecosystem compatibility; no `.js` extension requirement; simpler require() semantics for
  tooling written against older Node APIs.
- **Cons**: CJS is a legacy module system. Many modern packages (chalk ≥5, got ≥12, etc.) are ESM-only.
  Choosing CJS now creates an integration wall with the ESM ecosystem and forces a disruptive migration later.
  The "dual-package hazard" (shipping both CJS and ESM) doubles build complexity.
- **Why rejected**: ESM is the direction of Node.js. Wave 1 has no dependency on CJS-only packages.
  Starting ESM-first is cheaper than migrating later.

### Alternative 3: esbuild or tsup as build tool

- **Pros**: faster incremental builds; single-file bundle improves CLI startup time; dead-code elimination
  reduces published package size.
- **Cons**: bundled output is harder to inspect and debug; source maps across bundled output can mislead
  stack traces; tree-shaking a TypeScript SDK hides which exports are used by consumers; adds a devDependency
  that mediates the build.
- **Why rejected**: the package is a Node CLI/SDK, not a browser bundle. `tsc` output is 1:1 readable.
  Build speed is not a bottleneck for a project with < 20 source files at Wave 1. Revisit if cold-start
  latency or published package size becomes a measured problem.

### Alternative 4: Jest as test runner

- **Pros**: widely known; large plugin ecosystem; good snapshot testing.
- **Cons**: Jest requires a transform (ts-jest or babel-jest) to handle TypeScript and does not support
  `moduleResolution: NodeNext` natively without explicit configuration gymnastics. It also requires
  `"type": "module"` workarounds via `--experimental-vm-modules`. Vitest is a drop-in with zero transform
  configuration for this stack.
- **Why rejected**: Vitest handles TypeScript ESM natively with zero extra configuration. The Jest
  configuration overhead for ESM+NodeNext is disproportionate and fragile.

### Alternative 5: MIT license

- **Pros**: maximally permissive; widely understood; no patent-grant language to negotiate.
- **Cons**: MIT provides no explicit patent grant. Enterprise procurement and legal in regulated industries
  (banking, insurance) routinely flag dependencies without a patent grant as requiring legal review. Apache-2.0
  resolves this without restricting usage.
- **Why rejected**: Apache-2.0 has the same permissiveness as MIT for practical purposes (use, modify,
  distribute), adds a patent grant, and is npm-publishable. The marginal cost to adopters is zero; the
  compliance benefit is non-zero.

### Alternative 6: Proprietary / UNLICENSED

- **Pros**: maximum control; prevents redistribution without negotiation.
- **Cons**: blocks open adoption; npm publishing requires a declared license for discoverability; incompatible
  with the goal of enterprise self-service installation from npm.
- **Why rejected**: Keiko is intended for enterprise distribution via npm. An unlicensed package will be
  rejected by many enterprise security scanners on first import.

## Related

- ADR-0002: CI and Supply-Chain Security Baseline
- Issue #2: Bootstrap TypeScript npm workspace, CLI/SDK skeleton, and CI workflow
- Issue #13: UI build boundary (deferred — may require revisiting single-package decision)
- Node.js Release Schedule: https://nodejs.org/en/about/previous-releases (Node 20 EOL 2026-04-30)
- Apache-2.0 vs MIT patent implications: https://www.apache.org/licenses/LICENSE-2.0

## Date

2026-05-28
