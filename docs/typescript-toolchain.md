# TypeScript Toolchain

Status: active transition contract for
[Epic #2266](https://github.com/oscharko-dev/Keiko/issues/2266) and
[Issue #2267](https://github.com/oscharko-dev/Keiko/issues/2267).

Keiko uses a governed side-by-side TypeScript toolchain. TypeScript 7.0 provides the native compiler,
while TypeScript 6 remains the programmatic API used by productive language services and typed
tooling. This split follows the upstream TypeScript 7.0 transition model and is temporary until a
stable TypeScript 7 API and the dependent ecosystem have parity evidence.

## Toolchain roles

| Role                                     | Package and version                                              | Owner                                           | Why it remains separate                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Root and package-reference compiler      | `@typescript/native`, an npm alias for stable TypeScript `7.0.x` | root `devDependencies`                          | TypeScript 7 provides the native multithreaded compiler but no programmatic API in 7.0.                                                    |
| Productive compiler/language-service API | `typescript` `6.0.x`                                             | root and API-consuming workspace `dependencies` | Keiko Editor language services, workspace code intelligence, typed ESLint, and release scripts import this API.                            |
| Embedded UI toolchain                    | `typescript` `5.7.3`                                             | `packages/keiko-ui`                             | Next.js and its embedded TypeScript integration remain version-isolated until the UI compatibility child issue proves a supported upgrade. |

The upstream rationale and compatibility package guidance are documented in the
[TypeScript 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60).
The native implementation's intentional compatibility differences are tracked in
[microsoft/typescript-go `CHANGES.md`](https://github.com/microsoft/typescript-go/blob/main/CHANGES.md).

## Enforced invariants

`npm run check:typescript-toolchain` fails closed unless all of the following are true:

- `@typescript/native` is the exact development-only alias `npm:typescript@~7.0.2`;
- the explicit native compiler reports a stable TypeScript `7.0.x` version;
- compiler output matches the installed native package version;
- root `typescript` remains one stable `~6.0.x` runtime dependency;
- importing `typescript` resolves to a stable TypeScript `6.0.x` API;
- neither compiler role is missing, conflated, moved to an unsafe manifest section, or replaced by
  a prerelease.

Root build scripts invoke `node_modules/@typescript/native/bin/tsc` explicitly. They do not rely on
npm's collision resolution for the two packages' `tsc` bin names. Workspace-local UI scripts retain
their own compiler selection. The toolchain guard runs before every root package build, which also
covers root typecheck, test, release-check, prepack, and publish preparation paths.

The UI additionally runs `npm run typecheck:native --workspace @oscharko-dev/keiko-ui`. This checks
every Keiko-owned UI TypeScript surface with the native 7.0 compiler while leaving the supported
Next.js build and plugin integration on the workspace's TypeScript 5.7.3 package. Web API boundaries
normalize binary data to exact, non-shared `ArrayBuffer` values; this preserves byte identity and
avoids unsafe `BlobPart` or `BufferSource` casts.

Use these commands to inspect the split:

```bash
npm run check:typescript-toolchain
node node_modules/@typescript/native/bin/tsc --version
node -e 'import("typescript").then((module) => console.log(module.default?.version ?? module.version))'
```

## Runtime and supply-chain boundary

The native compiler is a development dependency. It must not enter the published Keiko runtime
graph. Its npm package selects a lockfile-integrity-pinned platform executable through optional
packages for supported Linux, macOS, Windows, and other upstream targets; it has no lifecycle
script. `typescript` 6 remains a runtime dependency because the bundled product executes its
server-side, workspace-contained language-service API.

The transition deliberately pins both minor lanes. A `7.1` compiler or `6.1` API update requires a
separate compatibility review instead of entering through a broad semver range.

Changes to either role require all of the following:

1. Review the upstream release notes and API/tool compatibility.
2. Update the manifest and lockfile in one change using npm only.
3. Update the dependency decision matrix when role, package name, license, lifecycle behavior, or
   runtime placement changes.
4. Run the toolchain guard before interpreting compiler diagnostics.
5. Validate `npm ci`, build, and typecheck on Linux, macOS, and Windows.
6. Run package, SBOM/license, install-smoke, release-impact, and required CI gates before delivery.

Do not point the package named `typescript` at TypeScript 7.0. That breaks the supported API boundary
and violates the current `typescript-eslint` peer range. Do not introduce an undocumented internal
TypeScript 7 API shim.

## Baseline performance evidence

Issue #2267 measured forced builds of all 23 referenced package projects on 2026-07-11. The checkout
was `9ca0eca4` plus the issue's dependency/toolchain change, on Darwin arm64 with Node 22.22.3. Each
compiler ran five times in the same installed worktree using:

```bash
node <compiler-bin> -b tsconfig.packages.json --force
```

| Compiler                              | Samples (milliseconds)                 | Median |         Range |
| ------------------------------------- | -------------------------------------- | -----: | ------------: |
| TypeScript 6.0.3 API package compiler | 9051.9, 8402.6, 8372.5, 8134.1, 8060.6 | 8372.5 | 8060.6-9051.9 |
| TypeScript 7.0.2 native compiler      | 854.9, 789.4, 767.7, 749.7, 791.0      |  789.4 |   749.7-854.9 |

The observed median speedup is approximately 10.6 times. These measurements are evidence, not a
correctness threshold: wall-clock timing varies by host and load. Correctness gates compare compiler
identity, diagnostics, output, tests, architecture, package surface, and runtime behavior instead.

## Upgrade sequence

1. **Native compiler adoption (#2267):** root and package builds use TypeScript 7; TypeScript 6 API
   and UI TypeScript remain unchanged.
2. **UI compatibility (#2268):** every Keiko-owned UI source file becomes clean under a separate
   TypeScript 7 compatibility check without forcing an unsupported embedded framework API.
3. **Stable API migration (#2269):** after the TypeScript 7 API is stable, productive API consumers
   migrate with diagnostics, navigation, refactoring, cancellation, output, Unicode-offset, and
   workspace-containment parity evidence.
4. **Compatibility removal (#2270):** obsolete TypeScript 6/5.7 packages and temporary migration
   seams are removed only after supported cross-platform parity.

## Current API readiness decision

Readiness was re-evaluated on 2026-07-11 after completing the compiler and UI compatibility work:

| Requirement                        | Current evidence                                                                 | Decision |
| ---------------------------------- | -------------------------------------------------------------------------------- | -------- |
| Stable TypeScript 7 API            | TypeScript 7.0.2 exposes the native compiler but no stable programmatic API.     | blocked  |
| Official stable API migration path | The 7.0 transition guidance requires side-by-side TypeScript 6 API use.          | blocked  |
| Typed ESLint support               | The installed `typescript-eslint` peer contract supports TypeScript below 6.1.0. | blocked  |
| Keiko UI source compatibility      | Supported UI typecheck and native 7.0 compatibility typecheck both pass.         | ready    |
| Framework-supported UI API upgrade | Next.js remains isolated on the supported TypeScript 5.7.3 workspace toolchain.  | blocked  |

Issue #2269 therefore remains blocked by its mandatory readiness gate. Keiko retains the supported
TypeScript 6.0 API without an internal or prerelease shim. Issue #2270 remains blocked by its entry
criteria until #2269 is merged with API and ecosystem parity evidence. These are intentional safety
decisions, not incomplete compatibility work in the compiler or UI phases.

TypeScript 7's native implementation uses UTF-8 parser offsets internally. Keiko's editor contracts
must retain their existing position semantics. Any future API migration must centralize and test
offset conversion rather than leak compiler implementation details into shared contracts.

## Troubleshooting and rollback

If the guard reports missing compiler metadata or API packages, run:

```bash
npm ci
npm run check:typescript-toolchain
```

If a supported host cannot resolve its native optional package, stop the rollout and record the
platform, Node/npm versions, lockfile state, and content-free error code. Do not bypass the guard or
fall back silently.

The rollback for the compiler-only phase is intentionally small: remove `@typescript/native`, restore
the previous lockfile, restore root compiler commands to the TypeScript 6 package, run `npm ci`, and
re-run the full affected gates. Productive TypeScript 6 API dependencies and user state are unchanged,
so this phase requires no state migration.
