# React 19 UI and Editor Migration

Status: implemented and locally verified for issue #2295 on 2026-07-11. A clean Linux environment
using Node.js 24.18.0 and npm 11.16.0 reproduced the editor release evidence committed at that
time. The authoritative measurement fingerprint is owned by `docs/release/1209-bundle-evidence.json`
(`measurementSha256`) and is enforced by `npm run check:editor-release-evidence`. It moves with
every `keiko-ui` bundle change, so this document names the evidence file instead of carrying a
second copy of the value that would drift out of it.

## Decision and supported dependency set

Keiko's UI and reusable editor use one host-provided React runtime. The reviewed dependency set is:

| Surface                      | Dependency                 | Selected version | Contract                        |
| ---------------------------- | -------------------------- | ---------------: | ------------------------------- |
| `@oscharko-dev/keiko-ui`     | `react`, `react-dom`       |         `19.2.8` | Exact runtime versions          |
| `@oscharko-dev/keiko-ui`     | `@types/react`             |        `19.2.18` | Exact development version       |
| `@oscharko-dev/keiko-ui`     | `@types/react-dom`         |         `19.2.4` | Exact development version       |
| `@oscharko-dev/keiko-editor` | `react`, `react-dom`       |        `^19.2.8` | Host-provided peer dependencies |
| `@oscharko-dev/keiko-editor` | React declaration packages |       Same as UI | Exact test/build versions       |

The editor does not bundle a second React runtime. `npm ls` must resolve the editor peers to the UI
host's React 19.2.8 installation without invalid or extraneous nodes. React canary features and the
React Compiler remain out of scope.

## Compatibility work

The migration preserves the existing component and host contracts and addresses only compatibility
classes proven by the React 19 declaration packages and production build:

- Refs that are initialized with `null` now expose `RefObject<T | null>` at the owning interface.
  No unsafe ref cast masks the lifecycle state.
- The test-generation state machine supplies React 19's reducer action tuple explicitly. Its reducer,
  state, action union, and runtime transitions are unchanged.
- Dynamically loaded Next.js widgets declare their callback parameter types explicitly where the
  lazy component boundary cannot provide reliable contextual typing. The types reuse the existing
  chat, Quality Intelligence, Git, Figma, connector, and window contracts.
- The modal background remains both `inert` and `aria-hidden` while a true modal is open. The
  imperative attribute lifecycle is retained because it expresses exact attribute presence and is
  already covered by accessibility regression tests.

No `any`, broad assertion, suppression directive, strictness reduction, global CSS edit, visual
redesign, state migration, or new UI subsystem is part of this migration.

## Behavioral and release impact

- Release-note category: `state-or-compatibility-changes`.
- Priority: `high`.
- User-visible change: Keiko runs on the supported React 19 runtime while preserving the current
  static workspace, editor, accessibility, and visual behavior.
- Release-note bullet: "Updated Keiko's UI and editor runtime to React 19 with preserved
  accessibility and editor behavior."
- Affected state stores: none.
- User action for a source installation: run `npm ci` after updating.

The published `0.2.15` release-impact rows are append-only and are not modified by this work. The
release owner must bind the release-note data above to the future package version when this change is
assigned to a release. This avoids representing an unapproved release decision as reviewed metadata.

## Verification contract

The migration is releasable only after all of the following are green from a clean install:

1. Dependency integrity: `npm ci`, `npm ls`, root and UI audits, SBOM/license checks, dependency
   hygiene, and workspace supply-chain validation.
2. Compilation and style: root and UI typecheck, root and UI lint, formatting, and the production
   static Next.js build.
3. Behavior: full root tests, UI coverage, existing axe/accessibility assertions, editor tests,
   editor fidelity/performance gates, and Playwright smoke tests.
4. Product packaging: root build, package-surface checks, install smokes, CSP/static export checks,
   and runtime BFF smoke checks.
5. Release evidence: `check:editor-release-evidence` must pass in the clean Linux environment used by
   the release gate. A macOS fingerprint is diagnostic only and must not replace Linux evidence.

The acceptance baseline is no hydration warning, browser console error, coverage regression,
accessibility regression, editor bundle/performance regression, or visible CSS difference.

## Rollback

Rollback is atomic; do not retain a mixture of React 18 declarations and React 19 compatibility
types.

1. Pin React back at the manifest and lockfile level rather than restoring a pre-migration
   revision: set `react`, `react-dom`, `@types/react`, and `@types/react-dom` in
   `packages/keiko-ui/package.json`, and the editor peer and development entries in
   `packages/keiko-editor/package.json`, to the pre-migration React 18 set (`react`/`react-dom`
   18.3.1, `@types/react` 18.3.29, `@types/react-dom` 18.3.7), regenerate `package-lock.json` from
   those manifests, and reverse the React 19 typing accommodations listed under Compatibility work
   as one reviewed unit. A historical restore is not available: the migration landed inside the
   combined squash commit `5c885161` ("feat(platform): modernize TypeScript, Node, dependencies,
   and React (#2304)", 160 files) that also carries the TypeScript 7, Node 24 / npm 11, and
   secret-scanning changes, and the React pin has moved since (19.2.7 at that commit, 19.2.8
   today).
2. Run `npm ci` to remove the React 19 dependency graph rather than reusing `node_modules`.
3. Re-run the complete verification contract, including a production static export and clean Linux
   editor release evidence.
4. Confirm `npm ls` contains one valid React runtime and that the editor resolves its peer from the
   host.

No local state conversion or data rollback is required because React runtime selection does not
modify Keiko state stores or persisted customer data.
